import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/main/secrets.js', () => ({
  getSecret: async (key: string) => secrets.get(key) ?? null,
  setSecret: async (key: string, value: string) => { secrets.set(key, value); },
  clearSecret: async (key: string) => { secrets.delete(key); }
}));
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, readDurable, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, createSession, rebindSession, resetSessionStoreForTests } from '../src/main/session/store.js';
import { addRemoteProject, assignSessionProject, listProjects, projectWorkspace, inheritSessionProject, sessionProjectBinding } from '../src/main/projects.js';
import { callRemoteProjectTool, validateRemoteProject } from '../src/main/remote-workspace.js';
import { prepareSessionPrompt } from '../src/main/session/prompt.js';
import { enqueueInput, resetInputForTests } from '../src/main/session/input.js';
import { pluginManager } from '../src/main/plugins/manager.js';
import { dispatch } from '../src/main/mcp/kernel.js';
import { observeRequestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string, server: Server, pluginId: string;
let calls: Array<{ name: string; args: Record<string, unknown> }>;
let failNext = false;
beforeEach(async () => {
  directory = await makeTempDir('cos-remote-'); calls = []; failNext = false; secrets.clear();
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig(defaultConfig());
  const tools = ['open_workspace', 'read', 'bash', 'exec_command', 'read_output', 'write_stdin', 'kill_command', 'codexpro', 'open_current_workspace'].map(name => ({
    name, inputSchema: { type: 'object', properties: ['read', 'bash', 'exec_command'].includes(name) ? { workspace_id: { type: 'string' } } : {} }
  }));
  server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body);
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    let result: unknown;
    if (msg.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'CodexPro fixture', version: '1' } };
    else if (msg.method === 'tools/list') result = { tools };
    else {
      calls.push({ name: msg.params.name, args: msg.params.arguments });
      if (failNext) { failNext = false; res.writeHead(500).end(); return; }
      const args = msg.params.arguments;
      const structuredContent = msg.params.name === 'open_workspace' ? { root: args.root, workspace_id: `ws_${args.root.split('/').at(-1)}` }
        : msg.params.name === 'exec_command' ? { process_id: 'proc_0123456789abcdef', workspace_id: args.workspace_id }
        : { workspace_id: args.workspace_id, output: 'remote result' };
      result = { content: [{ type: 'text', text: 'Remote operation completed' }], structuredContent };
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await pluginManager.initialize(directory);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const plugin = (await pluginManager.install({ source: { kind: 'remote', url }, credentials: { token: 'remote-test-token' } })).plugins[0]!;
  expect(plugin.status, plugin.error).toBe('ready'); pluginId = plugin.id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await pluginManager.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  resetInputForTests(); resetCorrelationRegistryForTests(); resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});

it('binds remote directories without approving a local root and scopes concurrent calls explicitly', async () => {
  const a = await addRemoteProject(pluginId, '/srv/a'), b = await addRemoteProject(pluginId, '/srv/b');
  expect((await addRemoteProject(pluginId, '/srv/a')).id).toBe(a.id);
  expect(await listProjects()).toHaveLength(2);
  await expect(projectWorkspace(a.id)).rejects.toThrow(/development server/);
  await Promise.all([
    callRemoteProjectTool(a, 'session-a', 'read', { path: 'README.md' }),
    callRemoteProjectTool(b, 'session-b', 'bash', { command: 'npm test' })
  ]);
  expect(calls.slice(-2)).toEqual(expect.arrayContaining([
    { name: 'read', args: { path: 'README.md', workspace_id: 'ws_a' } },
    { name: 'bash', args: { command: 'npm test', workspace_id: 'ws_b' } }
  ]));
  await expect(callRemoteProjectTool(a, 'session-a', 'read', { workspace_id: 'ws_b', path: 'README.md' })).rejects.toThrow(/MISMATCH/);
  await expect(callRemoteProjectTool(a, 'session-a', 'open_workspace', { root: '/srv/b' })).rejects.toThrow(/MISMATCH/);
  await expect(callRemoteProjectTool(a, 'session-a', 'codexpro', { action: 'read', args: {} })).rejects.toThrow(/explicit/);
  await expect(callRemoteProjectTool(a, 'session-a', 'open_current_workspace', {})).rejects.toThrow(/explicit/);
});

it('keeps remote project identity through input admission, worker inheritance and frontend rebind', async () => {
  const project = await addRemoteProject(pluginId, '/srv/a');
  const session = await createSession({ title: 'Remote task', conversationId: 'prime-a' });
  await assignSessionProject(session.id, project.id);
  const worker = await createSession({ title: 'Worker', conversationId: 'worker-a' });
  await inheritSessionProject(worker.id, 'prime-a');
  expect((await sessionProjectBinding(worker.id))?.remote).toEqual(project.remote);
  const opening = await enqueueInput({ id: randomUUID(), sessionId: null, projectId: project.id, text: 'Fix the tests', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  expect(opening.state).toBe('queued');
  const prompt = await prepareSessionPrompt('Fix the tests', { sessionId: session.id });
  expect(prompt).toContain('Remote directory: /srv/a');
  expect(prompt).toContain('CodexPro workspace_id: ws_a');
  await callRemoteProjectTool(project, session.id, 'exec_command', { command: 'npm test' });
  await rebindSession(session.id, 'prime-a', 'prime-b');
  expect((await sessionProjectBinding(session.id))?.id).toBe(project.id);
  expect((await callRemoteProjectTool(project, session.id, 'read_output', { process_id: 'proc_0123456789abcdef' })).isError).not.toBe(true);
  await expect(callRemoteProjectTool(project, worker.id, 'kill_command', { process_id: 'proc_0123456789abcdef' })).rejects.toThrow(/NOT_OWNED/);
  expect(await readDurable('remote-process-owners')).toEqual([expect.objectContaining({ sessionId: session.id, processId: 'proc_0123456789abcdef' })]);
});

it('refuses native Core execution in a remote conversation before the handler runs', async () => {
  const project = await addRemoteProject(pluginId, '/srv/a');
  const session = await createSession({ title: 'Remote task', conversationId: 'remote-chat' });
  await assignSessionProject(session.id, project.id);
  const requestId = `remote-${randomUUID()}`;
  observeRequestCorrelation({ requestId, conversationId: 'remote-chat', sessionId: session.id, messageId: 'message', tool: 'exec_command', observedAt: Date.now() });
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'must not run' }] }));
  const result = await dispatch('exec_command', { cmd: 'touch should-not-exist' }, null, requestId, 'core', execute);
  expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('REMOTE_PROJECT');
  expect(execute).not.toHaveBeenCalled();
});

it('refuses changed or disabled endpoints and never replays an ambiguous remote mutation', async () => {
  const project = await addRemoteProject(pluginId, '/srv/a');
  await expect(callRemoteProjectTool({ ...project, remote: { ...project.remote!, endpointId: '0'.repeat(64) } }, 'a', 'read', {})).rejects.toThrow(/address changed/);
  const before = calls.length; failNext = true;
  const failed = await callRemoteProjectTool(project, 'a', 'bash', { command: 'npm test' });
  expect(failed.isError).toBe(true); expect(calls).toHaveLength(before + 1);
  expect(JSON.stringify(failed)).toContain('did not retry');
  await pluginManager.setEnabled(pluginId, false);
  expect(() => validateRemoteProject(project)).toThrow(/Enable/);
});

it('rechecks Read-only at dispatch after asynchronous routing without breaking the connection', async () => {
  const project = await addRemoteProject(pluginId, '/srv/a');
  const before = calls.length, original = pluginManager.call.bind(pluginManager);
  vi.spyOn(pluginManager, 'call').mockImplementationOnce(async (...args) => {
    await saveConfig({ ...getConfig(), readOnly: true });
    return original(...args);
  });
  const result = await callRemoteProjectTool(project, 'session-a', 'bash', { command: 'npm test' });
  expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('TOOL_DISABLED');
  expect(calls).toHaveLength(before);
  expect(pluginManager.snapshot().plugins[0]!.status).toBe('ready');
});
