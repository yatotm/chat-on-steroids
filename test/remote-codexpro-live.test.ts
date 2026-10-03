import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/main/secrets.js', () => ({
  getSecret: async (key: string) => secrets.get(key) ?? null,
  setSecret: async (key: string, value: string) => { secrets.set(key, value); },
  clearSecret: async (key: string) => { secrets.delete(key); }
}));
import { defaultConfig, effectiveCapabilities, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { createSession, initSessionStore, readRecentEvents, resetSessionStoreForTests } from '../src/main/session/store.js';
import { observeRequestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { pluginManager } from '../src/main/plugins/manager.js';
import { addRemoteProject, assignSessionProject } from '../src/main/projects.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { makeTempDir, removeTempDir } from './helpers.js';

it.skipIf(!process.env.COS_CODEXPRO_HTTP_ENTRY)('executes and records real CodexPro file and process tools through the CoS MCP surface', async () => {
  const directory = await makeTempDir('cos-codexpro-live-');
  const projectRoot = path.join(directory, 'development'), appRoot = path.join(directory, 'desktop');
  await fs.mkdir(projectRoot); await fs.mkdir(appRoot);
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const token = randomBytes(32).toString('hex');
  let child: ChildProcess | undefined, endpoint: McpEndpoint | undefined;
  let diagnostic = '';
  try {
    child = spawn(process.execPath, [process.env.COS_CODEXPRO_HTTP_ENTRY!, '--root', projectRoot, '--host', '127.0.0.1', '--port', String(port)], {
      cwd: projectRoot, env: { PATH: process.env.PATH, CODEXPRO_HTTP_TOKEN: token,
        CODEXPRO_BASH_MODE: 'full', CODEXPRO_WRITE_MODE: 'workspace', CODEXPRO_TOOL_MODE: 'full' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    const keep = (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString().split(token).join('[redacted]')).slice(-2000); };
    child.stdout?.on('data', keep); child.stderr?.on('data', keep);
    await vi.waitFor(async () => {
      expect(child!.exitCode, diagnostic).toBeNull();
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBeLessThan(500);
    }, { timeout: 15000, interval: 100 });
    initConfigPath(appRoot); initDurableStore(appRoot); initSessionStore(appRoot);
    await saveConfig(defaultConfig()); await pluginManager.initialize(appRoot);
    const plugin = (await pluginManager.install({ source: { kind: 'remote', url: `http://127.0.0.1:${port}/mcp` }, credentials: { token } })).plugins[0]!;
    expect(plugin.status, plugin.error).toBe('ready');
    const project = await addRemoteProject(plugin.id, projectRoot);
    const session = await createSession({ title: 'Remote live verification', conversationId: 'remote-live-chat' });
    await assignSessionProject(session.id, project.id);
    const requestId = 'remote-live-request';
    observeRequestCorrelation({ requestId, conversationId: 'remote-live-chat', sessionId: session.id,
      messageId: 'remote-live-message', tool: 'write', observedAt: Date.now() });
    endpoint = await startMcpServer(() => ({ roots: [], caps: effectiveCapabilities(getConfig()), readOnly: false }));
    let sequence = 0;
    const call = async (surface: 'core' | 'plugins', name: string, args: Record<string, unknown>) => {
      const response = await fetch(endpoint!.urls[surface], { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-request-id': requestId
      }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } }) });
      const text = await response.text();
      const wire = JSON.parse(text.startsWith('{') ? text : [...text.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
      expect(wire.error, JSON.stringify(wire.error)).toBeUndefined();
      return wire.result;
    };
    const written = await call('plugins', 'write', { path: 'remote-proof.txt', content: 'Written on the development server\n' });
    expect(written.isError, JSON.stringify(written)).not.toBe(true);
    expect(await fs.readFile(path.join(projectRoot, 'remote-proof.txt'), 'utf8')).toBe('Written on the development server\n');
    await expect(fs.access(path.join(appRoot, 'remote-proof.txt'))).rejects.toThrow();
    const read = await call('plugins', 'read', { path: 'remote-proof.txt' });
    expect(JSON.stringify(read)).toContain('Written on the development server');
    const launched = await call('plugins', 'exec_command', { command: 'node -e "console.log(6 * 7)"' });
    expect(launched.isError, JSON.stringify(launched)).not.toBe(true);
    const processId = launched.structuredContent.process_id;
    const output = await call('plugins', 'read_output', { process_id: processId, wait_ms: 1000 });
    expect(output.isError, JSON.stringify(output)).not.toBe(true);
    expect(JSON.stringify(output)).toContain('42');
    const refused = await call('core', 'exec_command', { cmd: 'echo must-not-run-locally' });
    expect(refused.isError).toBe(true); expect(JSON.stringify(refused)).toContain('REMOTE_PROJECT');
    await flushRecorder();
    const events = await readRecentEvents(session.id, 30);
    expect(events.some(event => event.kind === 'tool_call' && event.call.tool === 'write')).toBe(true);
    expect(events.some(event => event.kind === 'tool_call' && event.call.tool === 'read_output')).toBe(true);
  } finally {
    await endpoint?.stop(); await flushRecorder(); await pluginManager.close();
    if (child?.exitCode === null) {
      const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
      child.kill('SIGTERM'); await exited;
    }
    resetCorrelationRegistryForTests(); resetSessionStoreForTests(); resetDurableForTests();
    await removeTempDir(directory);
  }
}, 45000);
