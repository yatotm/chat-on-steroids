import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/main/secrets.js', () => ({
  getSecret: async (key: string) => secrets.get(key) ?? null,
  setSecret: async (key: string, value: string) => { secrets.set(key, value); },
  clearSecret: async (key: string) => { secrets.delete(key); }
}));
import { defaultConfig, effectiveCapabilities, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, createSession, resetSessionStoreForTests, readRecentEvents } from '../src/main/session/store.js';
import { addRemoteProject, assignSessionProject } from '../src/main/projects.js';
import { observeRequestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { startMcpServer } from '../src/main/mcp/server.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const url = process.env.COS_EXECUTION_TEST_URL;
const tokenFile = process.env.COS_EXECUTION_TEST_TOKEN_FILE;
const remoteDirectory = process.env.COS_EXECUTION_TEST_DIRECTORY;

// 仅显式指定的验收目录会写入随机命名文件；不用已安装应用的数据或真实项目。
it.skipIf(!url || !tokenFile || !remoteDirectory)('runs Mac Core through an actual Linux execution service', async () => {
  const local = await makeTempDir('cos-live-core-');
  initConfigPath(local); initDurableStore(local); initSessionStore(local);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'desktop', path: local }] });
  const endpoint = await startMcpServer(() => ({ roots: getConfig().roots, caps: effectiveCapabilities(getConfig()), readOnly: getConfig().readOnly }));
  const file = `core-acceptance-${randomUUID()}.txt`;
  const png = file + '.png';
  let requestId = randomUUID(), sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(endpoint.urls.core, { method: 'POST', headers: { 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'x-request-id': requestId },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } }) });
    const text = await response.text();
    const wire = JSON.parse(text.startsWith('{') ? text : [...text.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
    expect(wire.error).toBeUndefined();
    return wire.result;
  };
  try {
    const token = (await fs.readFile(tokenFile!, 'utf8')).trim();
    const project = await addRemoteProject({ url: url!, token, directory: remoteDirectory! });
    const session = await createSession({ title: 'Linux Core acceptance', conversationId: 'linux-core-acceptance' });
    await assignSessionProject(session.id, project.id);
    observeRequestCorrelation({ requestId, conversationId: 'linux-core-acceptance', sessionId: session.id,
      messageId: randomUUID(), tool: 'read', observedAt: Date.now() });
    const patched = await call('apply_patch', { patch: `*** Begin Patch\n*** Add File: ${file}\n+Mac Core to Linux\n*** End Patch` });
    expect(patched.isError, JSON.stringify(patched)).not.toBe(true);
    expect(JSON.stringify(await call('read', { paths: [file] }))).toContain('Mac Core to Linux');
    await expect(fs.stat(`${local}/${file}`)).rejects.toThrow();
    const execution = await call('exec_command', { cmd: 'uname -s; pwd', yield_time_ms: 1000 });
    expect(execution.isError, JSON.stringify(execution)).not.toBe(true);
    expect(execution.structuredContent.output).toContain('Linux');
    expect(execution.structuredContent.output).toContain(remoteDirectory);
    const interactive = await call('exec_command', { cmd: 'read -r answer; printf "reply=%s\\n" "$answer"', tty: true, yield_time_ms: 250 });
    expect(interactive.isError, JSON.stringify(interactive)).not.toBe(true);
    expect(interactive.structuredContent.session_id).toMatch(/^cos:/);
    const reply = await call('write_stdin', { session_id: interactive.structuredContent.session_id, chars: 'accepted\n', yield_time_ms: 1000 });
    expect(reply.structuredContent.output).toContain('reply=accepted');
    expect(reply.structuredContent.exit_code).toBe(0);
    const imageBytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).png().toBuffer();
    const image = await call('exec_command', { cmd: `printf '%s' '${imageBytes.toString('base64')}' | base64 -d > ${png}`, yield_time_ms: 1000 });
    expect(image.structuredContent.exit_code).toBe(0);
    expect((await call('view_image', { path: png })).content.some((part: { type: string }) => part.type === 'image')).toBe(true);
    const failed = await call('exec_command', { cmd: 'exit 7', yield_time_ms: 1000 });
    expect(failed.structuredContent.exit_code).toBe(7);
    const events = await readRecentEvents(session.id, 40);
    expect(events.some(event => event.kind === 'tool_call' && event.call.tool === 'apply_patch' && event.call.outcome === 'ok')).toBe(true);
    expect(events.some(event => event.kind === 'tool_call' && event.call.tool === 'exec_command' && event.call.outcome === 'process_exit_nonzero')).toBe(true);
    await call('exec_command', { cmd: `rm -- ${file} ${png}`, yield_time_ms: 1000 });
    requestId = randomUUID();
    expect(JSON.stringify(await call('exec_command', { cmd: 'pwd' }))).toContain('CALLER_IDENTITY_REQUIRED');
  } finally {
    await endpoint.stop(); await flushRecorder();
    resetCorrelationRegistryForTests(); resetSessionStoreForTests(); resetDurableForTests();
    secrets.clear(); await removeTempDir(local);
  }
}, 30000);
