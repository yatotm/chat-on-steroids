import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/main/secrets.js', () => ({
  getSecret: async (key: string) => secrets.get(key) ?? null,
  setSecret: async (key: string, value: string) => { secrets.set(key, value); },
  clearSecret: async (key: string) => { secrets.delete(key); }
}));
import { defaultConfig, effectiveCapabilities, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, readDurable, writeDurableNow, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, createSession, rebindSession, bindSessionProject, resetSessionStoreForTests, readRecentEvents, appendEvent } from '../src/main/session/store.js';
import { addProject, addRemoteProject, assignSessionProject, listProjects, projectWorkspace, inheritSessionProject, sessionProjectBinding } from '../src/main/projects.js';
import { callRemoteCore, validateRemoteProject } from '../src/main/remote-workspace.js';
import { prepareSessionPrompt } from '../src/main/session/prompt.js';
import { enqueueInput, resetInputForTests } from '../src/main/session/input.js';
import { observeRequestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { executorFixture } from './executor-fixture.js';
import * as executionTransport from '../src/main/execution-client.js';
import * as bridge from '../src/main/bridge.js';
import { pendingImageExports, completeImageExport, resetImageExportsForTests } from '../src/main/image-export.js';
import sharp from 'sharp';

const supported = process.platform !== 'win32';
let directory: string, appRoot: string, a: string, b: string;
let executor: Awaited<ReturnType<typeof executorFixture>> | undefined, endpoint: McpEndpoint | undefined;
let sequence = 0;
beforeEach(async () => {
  if (!supported) return;
  secrets.clear(); directory = await makeTempDir('cos-remote-core-');
  appRoot = path.join(directory, 'desktop'); a = path.join(directory, 'a'); b = path.join(directory, 'b');
  await Promise.all([fs.mkdir(appRoot), fs.mkdir(a), fs.mkdir(b)]);
  executor = await executorFixture(directory, [a, b]);
  initConfigPath(appRoot); initDurableStore(appRoot); initSessionStore(appRoot);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'desktop', path: appRoot }] });
  endpoint = await startMcpServer(() => ({ roots: getConfig().roots, caps: effectiveCapabilities(getConfig()), readOnly: getConfig().readOnly }));
});
afterEach(async () => {
  if (!supported) return;
  resetImageExportsForTests();
  await endpoint?.stop(); endpoint = undefined;
  await executor?.stop(); executor = undefined; await flushRecorder();
  vi.restoreAllMocks(); resetInputForTests(); resetCorrelationRegistryForTests(); resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});
const add = (directory: string) => addRemoteProject({ url: executor!.url, token: executor!.token, directory });
async function owner(projectId: string, conversationId: string) {
  const session = await createSession({ title: 'Remote Core test', conversationId });
  await assignSessionProject(session.id, projectId);
  return { session, requestId: prove(session.id, conversationId) };
}
function prove(sessionId: string, conversationId: string) {
  const requestId = randomUUID();
  observeRequestCorrelation({ requestId, conversationId, sessionId, messageId: randomUUID(), tool: 'read', observedAt: Date.now() });
  return requestId;
}
async function call(requestId: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(endpoint!.urls.core, { method: 'POST', headers: { 'content-type': 'application/json',
    accept: 'application/json, text/event-stream', 'x-request-id': requestId },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } }) });
  const text = await response.text();
  const wire = JSON.parse(text.startsWith('{') ? text : [...text.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
  expect(wire.error, JSON.stringify(wire.error)).toBeUndefined();
  return wire.result;
}

it.skipIf(!supported)('routes the real Core surface to an independent execution service and records the exact result', async () => {
  const project = await add(a);
  const { session, requestId } = await owner(project.id, 'remote-core-a');
  expect((await add(a)).id).toBe(project.id);
  await expect(projectWorkspace(project.id)).rejects.toThrow(/development server/);
  const result = await call(requestId, 'apply_patch', { patch: '*** Begin Patch\n*** Add File: proof.txt\n+written through Core\n*** End Patch' });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(await fs.readFile(path.join(a, 'proof.txt'), 'utf8')).toBe('written through Core\n');
  await expect(fs.stat(path.join(appRoot, 'proof.txt'))).rejects.toThrow();
  expect(JSON.stringify(await call(requestId, 'read', { paths: ['proof.txt'] }))).toContain('written through Core');
  const events = await readRecentEvents(session.id, 30);
  expect(events.some(event => event.kind === 'tool_call' && event.call.tool === 'apply_patch' && event.call.outcome === 'ok')).toBe(true);
  expect(await readDurable('remote-process-owners')).toBeNull();
});

it.skipIf(!supported)('keeps concurrent projects separate and refuses native paths and unknown callers without local fallback', async () => {
  const pa = await add(a), pb = await add(b);
  const aa = await owner(pa.id, 'remote-a'), bb = await owner(pb.id, 'remote-b');
  const results = await Promise.all([
    call(aa.requestId, 'exec_command', { cmd: 'pwd', yield_time_ms: 1000 }),
    call(bb.requestId, 'exec_command', { cmd: 'pwd', yield_time_ms: 1000 })
  ]);
  expect(results[0].isError, JSON.stringify(results[0])).not.toBe(true);
  expect(results[1].isError, JSON.stringify(results[1])).not.toBe(true);
  expect(results[0].structuredContent.output).toContain(a);
  expect(results[1].structuredContent.output).toContain(b);
  expect((await call(aa.requestId, 'read', { paths: [b] })).isError).toBe(true);
  const native = await call(aa.requestId, 'apply_patch', { patch: `*** Begin Patch\n*** Add File: ${appRoot}/forbidden\n+no\n*** End Patch` });
  expect(native.isError).toBe(true);
  const unknown = await call('unidentified-remote-caller', 'exec_command', { cmd: 'touch forbidden', workdir: appRoot });
  expect(JSON.stringify(unknown)).toContain('CALLER_IDENTITY_REQUIRED');
  await expect(fs.stat(path.join(appRoot, 'forbidden'))).rejects.toThrow();
});

it.skipIf(!supported)('keeps local and remote work independent on the same Core, including a remote outage', async () => {
  const local = await addProject(appRoot), remote = await add(a);
  const l = await owner(local.id, 'local-with-remote'), r = await owner(remote.id, 'remote-with-local');
  const patch = (text: string) => ({ patch: `*** Begin Patch\n*** Add File: same.txt\n+${text}\n*** End Patch` });
  const results = await Promise.all([call(l.requestId, 'apply_patch', patch('local')), call(r.requestId, 'apply_patch', patch('remote'))]);
  for (const result of results) expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(await fs.readFile(path.join(appRoot, 'same.txt'), 'utf8')).toBe('local\n');
  expect(await fs.readFile(path.join(a, 'same.txt'), 'utf8')).toBe('remote\n');
  expect((await call(l.requestId, 'exec_command', { cmd: 'pwd', yield_time_ms: 1000 })).structuredContent.output).toContain(appRoot);
  expect((await call(r.requestId, 'exec_command', { cmd: 'pwd', yield_time_ms: 1000 })).structuredContent.output).toContain(a);
  await executor!.stop(); executor = undefined;
  expect((await call(r.requestId, 'read', { paths: ['same.txt'] })).isError).toBe(true);
  expect(JSON.stringify(await call(l.requestId, 'read', { paths: ['same.txt'] }))).toContain('local');
  expect(await fs.readFile(path.join(appRoot, 'same.txt'), 'utf8')).toBe('local\n');
});

it.skipIf(!supported)('keeps project and process custody through worker inheritance and Compact & Resume', async () => {
  const project = await add(a);
  const { session, requestId } = await owner(project.id, 'prime-before');
  const worker = await createSession({ title: 'Worker', conversationId: 'worker' });
  await inheritSessionProject(worker.id, 'prime-before');
  expect((await sessionProjectBinding(worker.id))?.id).toBe(project.id);
  const opening = await enqueueInput({ id: randomUUID(), sessionId: null, projectId: project.id, text: 'Read project', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  expect(opening.state).toBe('queued');
  expect(await prepareSessionPrompt('Read project', { sessionId: session.id })).toContain('Use the normal Chat On Steroids Core');
  const launched = await call(requestId, 'exec_command', { cmd: 'printf retained-output', yield_time_ms: 1000 });
  expect(launched.isError, JSON.stringify(launched)).not.toBe(true);
  const handle = launched.structuredContent.completed_session_id ?? launched.structuredContent.session_id;
  expect(handle).toMatch(/^cos:/);
  await rebindSession(session.id, 'prime-before', 'prime-after');
  const result = await call(prove(session.id, 'prime-after'), 'write_stdin', { session_id: handle });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(result.structuredContent.output).toContain('retained-output');
  expect((await call(prove(worker.id, 'worker'), 'write_stdin', { session_id: handle })).isError).toBe(true);
  expect((await call(requestId, 'exec_command', { cmd: 'touch retired' })).isError).toBe(true);
  await expect(fs.stat(path.join(a, 'retired'))).rejects.toThrow();
});

it.skipIf(!supported)('applies current permissions remotely while retaining permitted reads', async () => {
  const project = await add(a), actor = await owner(project.id, 'permissions');
  await fs.writeFile(path.join(a, 'readable'), 'yes');
  await call(actor.requestId, 'read', { paths: ['readable'] });
  await saveConfig({ ...getConfig(), readOnly: true });
  expect((await call(actor.requestId, 'exec_command', { cmd: 'touch forbidden' })).isError).toBe(true);
  expect(JSON.stringify(await call(actor.requestId, 'read', { paths: ['readable'] }))).toContain('yes');
  await expect(fs.stat(path.join(a, 'forbidden'))).rejects.toThrow();
});

it.skipIf(!supported)('requires an explicit legacy reconnection and preserves project/session identity without storing the token in metadata', async () => {
  const legacy = { id: randomUUID(), name: 'Existing project', path: a, createdAt: 1,
    remote: { pluginId: randomUUID(), workspaceId: 'old_workspace', endpointId: 'a'.repeat(64) } };
  await writeDurableNow('projects', [legacy]);
  expect(() => validateRemoteProject(legacy)).toThrow(/Reconnect/);
  const session = await createSession({ title: 'Existing chat', conversationId: 'legacy-chat' });
  await bindSessionProject(session.id, legacy.id);
  const project = await addRemoteProject({ url: executor!.url, token: executor!.token, directory: a,
    replace: { projectId: legacy.id, path: legacy.path, binding: legacy.remote } });
  expect(project.id).toBe(legacy.id); expect(project.createdAt).toBe(1);
  expect((await sessionProjectBinding(session.id))?.id).toBe(legacy.id);
  expect(JSON.stringify(await listProjects())).not.toContain(executor!.token);
  await expect(addRemoteProject({ url: executor!.url, token: executor!.token, directory: a,
    replace: { projectId: legacy.id, path: legacy.path, binding: legacy.remote } })).rejects.toThrow(/changed/);
});

it.skipIf(!supported)('delivers remote completion and background output through the owning Core response', async () => {
  const project = await add(a), actor = await owner(project.id, 'background');
  const started = await call(actor.requestId, 'exec_command', { cmd: 'sleep 0.7; printf owned-background', yield_time_ms: 250 });
  expect(started.isError, JSON.stringify(started)).not.toBe(true);
  expect(started.structuredContent.session_id).toMatch(/^cos:/);
  await new Promise(resolve => setTimeout(resolve, 850));
  const result = await call(actor.requestId, 'read', { paths: ['.'] });
  expect(JSON.stringify(result)).toContain('owned-background');
  await vi.waitFor(async () => {
    const events = await readRecentEvents(actor.session.id, 30);
    expect(events.some(event => event.kind === 'tool_call' && event.call.tool === 'exec_command' && event.call.process?.exitCode === 0)).toBe(true);
  });
});

it.skipIf(!supported)('does not publish a refused connection later through a durable retry', async () => {
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementationOnce(async (source, target) => {
    if (String(target).endsWith('projects.json')) throw new Error('fixture write failure');
    return rename(source, target);
  });
  await expect(add(a)).rejects.toThrow(/fixture write failure/);
  vi.restoreAllMocks();
  await flushDurable();
  expect(await listProjects()).toEqual([]);
  expect([...secrets.keys()].filter(key => key.startsWith('execution:'))).toEqual([]);
});

it.skipIf(!supported)('recovers background output after its private offer response is lost', async () => {
  const project = await add(a), actor = await owner(project.id, 'lost-background');
  await call(actor.requestId, 'exec_command', { cmd: 'sleep 0.6; printf recovered-background', yield_time_ms: 250 });
  await new Promise(resolve => setTimeout(resolve, 750));
  const original = executionTransport.executionRpc;
  let dropped = false;
  vi.spyOn(executionTransport, 'executionRpc').mockImplementation(async (...args) => {
    const result = await original(...args);
    if (!dropped && args[2] === 'cos_background' && args[3].phase === 'offer' && result.structuredContent) {
      dropped = true; throw new Error('fixture lost offer response');
    }
    return result;
  });
  const first = await call(actor.requestId, 'read', { paths: ['.'] });
  expect(JSON.stringify(first)).not.toContain('recovered-background');
  const next = await call(actor.requestId, 'read', { paths: ['.'] });
  expect(JSON.stringify(next)).toContain('recovered-background');
});

it.skipIf(!supported)('revokes a prepared target when reconnection commits during the final caller check', async () => {
  const project = await add(a), actor = await owner(project.id, 'binding-race');
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = callRemoteCore(project, actor.session.id, 'exec_command', { cmd: 'touch stale-binding' }, async () => { enter(); await gate; });
  await entered;
  await addRemoteProject({ url: executor!.url, token: executor!.token, directory: a,
    replace: { projectId: project.id, path: project.path, binding: project.remote! } });
  release();
  const result = await pending;
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('binding changed');
  await expect(fs.stat(path.join(a, 'stale-binding'))).rejects.toThrow();
});

it.skipIf(!supported)('routes upstream save_image through the same remote Core owner', async () => {
  const project = await add(a), actor = await owner(project.id, 'remote-generated-image');
  vi.spyOn(bridge, 'imageExportCapable').mockReturnValue(true);
  await appendEvent(actor.session.id, { source: 'extension', time: Date.now(), kind: 'native_image',
    messageId: randomUUID(), providerAssetId: 'generated-fixture', providerRole: 'tool',
    providerStatus: 'finished_successfully', previewStatus: 'unavailable' });
  const saving = call(actor.requestId, 'save_image', { path: 'native-image.png' });
  await vi.waitFor(() => expect(pendingImageExports()).toHaveLength(1));
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).png().toBuffer();
  await completeImageExport({ nonce: pendingImageExports()[0]!.nonce, data: bytes.toString('base64') });
  const result = await saving;
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(await fs.readFile(path.join(a, 'native-image.png'))).toEqual(bytes);
  await expect(fs.stat(path.join(appRoot, 'native-image.png'))).rejects.toThrow();
});
