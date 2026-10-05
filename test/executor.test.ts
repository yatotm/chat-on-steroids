import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startExecutionServer } from '../src/executor/server.js';
import { executionRpc } from '../src/main/execution-client.js';
import { CAPABILITIES, type Capabilities } from '../src/shared/types.js';
import { EXECUTION_PROTOCOL, executionWorkspaceSchema, type ExecutionScope } from '../src/shared/remote-execution.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { UnifiedExecProcessManager } from '../src/main/codex/unified-exec.js';
import sharp from 'sharp';

const supported = process.platform !== 'win32';
let directory: string, a: string, b: string, token: string, serverId: string, url: string;
let service: Awaited<ReturnType<typeof startExecutionServer>> | undefined;
let scope: ExecutionScope;
const caps = Object.fromEntries(CAPABILITIES.map(name => [name, true])) as Capabilities;

beforeEach(async () => {
  if (!supported) return;
  directory = await makeTempDir('cos-execution-'); a = path.join(directory, 'a'); b = path.join(directory, 'b');
  await fs.mkdir(a); await fs.mkdir(b);
  token = randomUUID() + randomUUID(); serverId = randomUUID();
  service = await startExecutionServer({ roots: [directory], token, serverId, port: 0 });
  url = `http://127.0.0.1:${service.port}/mcp`;
  const response = await executionRpc(url, token, 'cos_workspace', { directory: a });
  const workspace = executionWorkspaceSchema.parse(response.structuredContent);
  scope = { protocol: EXECUTION_PROTOCOL, serverId, epoch: workspace.epoch, clientId: randomUUID(),
    projectId: randomUUID(), sessionId: randomUUID(), directory: a,
    policy: { caps: { ...caps }, readOnly: false, commandPolicy: { enabled: false, mode: 'allow', rules: [] } } };
});
afterEach(async () => { if (supported) { vi.restoreAllMocks(); await service?.stop(); service = undefined; await removeTempDir(directory); } });
const call = (name: string, args: Record<string, unknown>, owner = scope) => executionRpc(url, token, name,
  name === 'cos_background' && args.phase === 'offer' ? { offerId: randomUUID(), ...args } : args, owner);
const data = (result: Record<string, unknown>) => result.structuredContent as Record<string, unknown>;

it.skipIf(!supported)('requires authentication, loopback host, no Origin and exact execution identity', async () => {
  await expect(executionRpc(url, 'wrong-token', 'cos_workspace', { directory: a })).rejects.toThrow(/token/);
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'https://example.com' }, body: '{}' });
  expect(response.status).toBe(403);
  expect((await call('exec_command', { cmd: 'touch forbidden' }, { ...scope, serverId: randomUUID() })).isError).toBe(true);
  expect((await call('exec_command', { cmd: 'touch forbidden' }, { ...scope, epoch: randomUUID() })).isError).toBe(true);
  await expect(fs.stat(path.join(a, 'forbidden'))).rejects.toThrow();
  expect((await executionRpc(url, token, 'exec_command', { cmd: 'touch forbidden' })).isError).toBe(true);
});

it.skipIf(!supported)('uses the shared Core patch/read implementation within the exact approved project', async () => {
  const patched = await call('apply_patch', { patch: '*** Begin Patch\n*** Add File: note.txt\n+remote proof\n*** End Patch' });
  expect(patched.isError, JSON.stringify(patched)).not.toBe(true);
  expect(await fs.readFile(path.join(a, 'note.txt'), 'utf8')).toBe('remote proof\n');
  const read = await call('read', { paths: ['note.txt'] });
  expect(read.isError, JSON.stringify(read)).not.toBe(true);
  expect(JSON.stringify(read)).toContain('remote proof');
  expect((await call('read', { paths: ['../b/private.txt'] })).isError).toBe(true);
  await fs.writeFile(path.join(b, 'private.txt'), 'not this project');
  await fs.symlink(path.join(b, 'private.txt'), path.join(a, 'escape'));
  expect((await call('read', { paths: ['escape'] })).isError).toBe(true);
  expect((await call('read', { paths: [path.join(b, 'private.txt')] })).isError).toBe(true);
  expect((await executionRpc(url, token, 'cos_workspace', { directory: path.dirname(directory) })).isError).toBe(true);
});

it.skipIf(!supported)('enforces Read-only and the command policy before starting a child', async () => {
  const readOnly = { ...scope, policy: { ...scope.policy, readOnly: true } };
  expect((await call('exec_command', { cmd: 'touch refused' }, readOnly)).isError).toBe(true);
  expect((await call('apply_patch', { patch: '*** Begin Patch\n*** Add File: refused\n+bad\n*** End Patch' }, readOnly)).isError).toBe(true);
  await fs.writeFile(path.join(a, 'ok'), 'readable');
  expect((await call('read', { paths: ['ok'] }, readOnly)).isError).not.toBe(true);
  const restricted = { ...scope, policy: { ...scope.policy, commandPolicy: { enabled: true, mode: 'allow' as const, rules: [] } } };
  expect(JSON.stringify(await call('exec_command', { cmd: 'touch refused' }, restricted))).toContain('COMMAND_NOT_ALLOWED');
  await expect(fs.stat(path.join(a, 'refused'))).rejects.toThrow();
});

it.skipIf(!supported)('keeps opaque process handles, replayed output and exact session/project custody', async () => {
  const started = await call('exec_command', { cmd: 'printf "Process running with session ID 1234\\n"; pwd', yield_time_ms: 1000 });
  expect(started.isError, JSON.stringify(started)).not.toBe(true);
  const id = data(started).completed_session_id ?? data(started).session_id;
  expect(id).toMatch(/^cos:/);
  expect(data(started).output).toContain('Process running with session ID 1234');
  expect(data(started).output).toContain(a);
  const result = await call('write_stdin', { session_id: id, chars: '' });
  expect(result.isError).not.toBe(true); expect(data(result).output_replayed).toBe(true);
  expect((await call('write_stdin', { session_id: id }, { ...scope, sessionId: randomUUID() })).isError).toBe(true);
  expect((await call('write_stdin', { session_id: id }, { ...scope, directory: b })).isError).toBe(true);
});

it.skipIf(!supported)('observes completion without draining output and only acknowledges a proved result receipt', async () => {
  const started = await call('exec_command', { cmd: 'sleep 0.7; printf final-output', yield_time_ms: 250 });
  const id = data(started).session_id;
  expect(id).toMatch(/^cos:/);
  const completed = await call('cos_completion', { session_id: id });
  expect(data(completed).exitCode).toBe(0);
  const offered = await call('cos_background', { phase: 'offer', maxBytes: 6000 });
  expect(data(offered).text).toContain('final-output');
  expect(data(offered).text).toContain(String(id));
  const receipt = data(offered).receiptId;
  await call('cos_background', { phase: 'ack', acknowledged: [receipt] }, { ...scope, sessionId: randomUUID() });
  const stillRetained = await call('write_stdin', { session_id: id });
  expect(data(stillRetained).output).toContain('final-output');
});

it.skipIf(!supported)('rejects old handles after an execution service restart', async () => {
  const started = await call('exec_command', { cmd: 'printf old', yield_time_ms: 1000 });
  const id = data(started).completed_session_id;
  await service!.stop();
  service = await startExecutionServer({ roots: [directory], token, serverId, port: 0 });
  url = `http://127.0.0.1:${service.port}/mcp`;
  const next = executionWorkspaceSchema.parse((await executionRpc(url, token, 'cos_workspace', { directory: a })).structuredContent);
  expect(next.epoch).not.toBe(scope.epoch);
  expect((await call('write_stdin', { session_id: id }, { ...scope, epoch: next.epoch })).isError).toBe(true);
});

it.skipIf(!supported)('does not repeat a command after the response is lost', async () => {
  await expect(executionRpc(url, token, 'exec_command', { cmd: 'printf x >> once; sleep 0.8', yield_time_ms: 1000 }, scope,
    { timeoutMs: 200 })).rejects.toThrow(/unconfirmed/);
  await new Promise(resolve => setTimeout(resolve, 1100));
  expect(await fs.readFile(path.join(a, 'once'), 'utf8')).toBe('x');
});

it.skipIf(!supported)('reoffers the same retained output when the offer response never reached its caller', async () => {
  const started = await call('exec_command', { cmd: 'sleep 0.5; printf retained-after-loss', yield_time_ms: 250 });
  await call('cos_completion', { session_id: data(started).session_id });
  const lostId = randomUUID();
  const lost = await call('cos_background', { phase: 'offer', offerId: lostId });
  expect(data(lost).receiptId).toBe(lostId);
  const retried = await call('cos_background', { phase: 'offer', failed: [lostId] });
  expect(data(retried).text).toBe(data(lost).text);
  await call('cos_background', { phase: 'ack', acknowledged: [data(retried).receiptId] });
  expect(data(await call('cos_background', { phase: 'offer' })).text).toBeNull();
});

it.skipIf(!supported)('releases disconnected completion readers without stopping the process or draining output', async () => {
  const started = await call('exec_command', { cmd: 'sleep 3; printf still-alive', yield_time_ms: 250 });
  const id = data(started).session_id;
  for (let count = 0; count < 70; count++) {
    await expect(executionRpc(url, token, 'cos_completion', { session_id: id }, scope, { timeoutMs: 20 })).rejects.toThrow(/timed out/);
  }
  expect(data(await call('cos_completion', { session_id: id })).exitCode).toBe(0);
  expect(data(await call('write_stdin', { session_id: id })).output).toContain('still-alive');
});

it.skipIf(!supported)('cannot reserve output after a disconnected offer was already reconciled', async () => {
  const started = await call('exec_command', { cmd: 'printf x >> once; sleep 0.5; printf retained-in-order', yield_time_ms: 250 });
  await call('cos_completion', { session_id: data(started).session_id });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const realpath = fs.realpath.bind(fs);
  let held = false;
  vi.spyOn(fs, 'realpath').mockImplementation((async (...args: Parameters<typeof fs.realpath>) => {
    if (!held && String(args[0]) === directory) { held = true; enter(); await gate; }
    return realpath(...args);
  }) as typeof fs.realpath);
  const lostId = randomUUID();
  const lost = expect(executionRpc(url, token, 'cos_background', { phase: 'offer', offerId: lostId }, scope,
    { timeoutMs: 100 })).rejects.toThrow(/timed out/);
  await entered;
  await lost;
  await call('cos_background', { phase: 'ack', failed: [lostId] });
  release();
  const next = await call('cos_background', { phase: 'offer' });
  expect(data(next).text).toContain('retained-in-order');
  expect(await fs.readFile(path.join(a, 'once'), 'utf8')).toBe('x');
});

it.skipIf(!supported)('waits for accepted preparation to retire and cannot launch after stop returns', async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const realpath = fs.realpath.bind(fs);
  let held = false;
  vi.spyOn(fs, 'realpath').mockImplementation((async (...args: Parameters<typeof fs.realpath>) => {
    if (!held && String(args[0]) === directory) { held = true; enter(); await gate; }
    return realpath(...args);
  }) as typeof fs.realpath);
  const result = call('exec_command', { cmd: 'touch must-not-start', yield_time_ms: 250 });
  await entered;
  let stopped = false;
  const closing = service!.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(stopped).toBe(false);
  release();
  expect((await result).isError).toBe(true);
  await closing;
  expect(stopped).toBe(true);
  await expect(fs.stat(path.join(a, 'must-not-start'))).rejects.toThrow();
});

it.skipIf(!supported)('joins a child that is still starting before shutdown completes', async () => {
  const manager = new UnifiedExecProcessManager(300000);
  const id = manager.allocateProcessId();
  const launched = manager.execCommand({ processId: id, command: [process.execPath, '-e',
    "require('fs').writeFileSync('startup.pid',String(process.pid));setInterval(()=>{},1000)"],
    hookCommand: 'fixture pending launch', shellType: 'bash', cwd: a, displayCwd: '/project', env: process.env,
    tty: false, yieldTimeMs: 30000, maxOutputTokens: undefined, truncationPolicy: { kind: 'tokens', tokens: 1000 } });
  const stopped = manager.shutdown();
  await expect(launched).rejects.toThrow(/shutdown/);
  await stopped;
  expect(manager.listProcesses()).toEqual([]);
  expect(() => manager.allocateProcessId()).toThrow(/shutting down/);
  const pid = await fs.readFile(path.join(a, 'startup.pid'), 'utf8').catch(() => null);
  if (pid) await vi.waitFor(() => expect(() => process.kill(Number(pid), 0)).toThrow(), { timeout: 1000 });
});

it.skipIf(!supported)('separates the primary cwd from multiple explicitly approved directories', async () => {
  await fs.writeFile(path.join(b, 'library.txt'), 'shared dependency');
  const shared = { ...scope, roots: [a, b] };
  expect(JSON.stringify(await call('read', { paths: [path.join(b, 'library.txt')] }, shared))).toContain('shared dependency');
  expect(data(await call('exec_command', { cmd: 'pwd', yield_time_ms: 1000 }, shared)).output).toContain(a);
  expect((await call('read', { paths: [path.join(b, 'library.txt')] }, { ...shared, roots: [a] })).isError).toBe(true);
  expect((await call('read', { paths: [directory] }, shared)).isError).toBe(true);
  const missing = path.join(directory, 'unused-missing-directory');
  expect(JSON.stringify(await call('read', { paths: [path.join(b, 'library.txt')] }, { ...shared, roots: [a, b, missing] }))).toContain('shared dependency');
});

it.skipIf(!supported)('does not let a retained terminal accept new input under narrowed directory permissions', async () => {
  const shared = { ...scope, roots: [a, b] };
  const launched = await call('exec_command', { cmd: 'read -r answer; printf "%s" "$answer"', tty: true, yield_time_ms: 250 }, shared);
  const handle = data(launched).session_id;
  expect(handle).toMatch(/^cos:/);
  const denied = await call('write_stdin', { session_id: handle, chars: 'must-not-arrive\n' }, { ...shared, roots: [a] });
  expect(JSON.stringify(denied)).toContain('REMOTE_PERMISSIONS_CHANGED');
  const completed = await call('write_stdin', { session_id: handle, chars: 'accepted\n', yield_time_ms: 1000 }, shared);
  expect(data(completed).output).toContain('accepted');
  expect(data(completed).output).not.toContain('must-not-arrive');
  const changedInstance = String(handle).replace(/:[0-9]+$/, ':999999');
  expect(JSON.stringify(await call('write_stdin', { session_id: changedInstance }, shared))).toContain('REMOTE_PROCESS_EXPIRED');
});

it.skipIf(!supported)('saves original image bytes in the remote workspace without replacing an existing file', async () => {
  const bytes = await sharp({ create: { width: 5, height: 3, channels: 3, background: 'blue' } }).png().toBuffer();
  const result = await call('cos_save_image', { path: 'generated', data: bytes.toString('base64') });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(await fs.readFile(path.join(a, 'generated.png'))).toEqual(bytes);
  expect((await call('cos_save_image', { path: 'generated.png', data: bytes.toString('base64') })).isError).toBe(true);
  expect((await call('cos_save_image', { path: path.join(b, 'outside.png'), data: bytes.toString('base64') })).isError).toBe(true);
});
