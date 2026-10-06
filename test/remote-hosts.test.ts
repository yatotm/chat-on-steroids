import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const fixture = vi.hoisted(() => ({ url: '', token: '', opens: 0, stops: 0, secrets: new Map<string, string>(),
  secretGate: null as null | (() => Promise<void>) }));
vi.mock('../src/main/secrets.js', () => ({
  getSecret: async (key: string) => { await fixture.secretGate?.(); return fixture.secrets.get(key) ?? null; },
  setSecret: async (key: string, value: string) => { fixture.secrets.set(key, value); },
  clearSecret: async (key: string) => { fixture.secrets.delete(key); }
}));
vi.mock('../src/main/ssh-config.js', () => ({ resolveSshHost: async (host: string) => (host === 'other' ? 'b' : 'a').repeat(64) }));
vi.mock('../src/main/ssh-tunnel.js', () => ({
  openSshTunnel: async () => {
    fixture.opens++;
    let alive = true, resolve!: () => void;
    const closed = new Promise<void>(done => { resolve = done; });
    return { url: fixture.url, port: Number(new URL(fixture.url).port), alive: () => alive, closed,
      stop: async () => { if (alive) { alive = false; fixture.stops++; resolve(); } } };
  }
}));
import { startExecutionServer } from '../src/executor/server.js';
import { initDurableStore, readDurable, resetDurableForTests } from '../src/main/durable.js';
import { initConfigPath, defaultConfig, getConfig, saveConfig } from '../src/main/config.js';
import { saveRemoteHost, listRemoteHosts, remoteEndpoint, disconnectRemoteHost, reconnectRemoteHost,
  suspendRemoteHosts, resumeRemoteHosts, closeRemoteHosts, resetRemoteHostsForTests } from '../src/main/remote-hosts.js';
import { addManagedRemoteProject, listProjects } from '../src/main/projects.js';
import { runDiagnostics } from '../src/main/diagnostics.js';
import { DESKTOP_CAPABILITIES } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';
let directory: string, a: string, b: string;
let service: Awaited<ReturnType<typeof startExecutionServer>>;
const supported = process.platform !== 'win32';
beforeEach(async () => {
  if (!supported) return;
  await resetRemoteHostsForTests(); fixture.opens = fixture.stops = 0; fixture.secrets.clear();
  fixture.secretGate = null;
  directory = await makeTempDir('cos-hosts-'); a = path.join(directory, 'a'); b = path.join(directory, 'b');
  await fs.mkdir(a); await fs.mkdir(b);
  initDurableStore(directory); initConfigPath(directory); await saveConfig({ ...defaultConfig(), roots: [] });
  fixture.token = randomUUID() + randomUUID();
  service = await startExecutionServer({ roots: [directory], token: fixture.token, serverId: randomUUID(), port: 0 });
  fixture.url = 'http://127.0.0.1:' + service.port + '/mcp';
});
afterEach(async () => {
  if (!supported) return;
  await resetRemoteHostsForTests(); await service.stop(); resetDurableForTests(); await removeTempDir(directory);
});
const connect = () => saveRemoteHost({ sshHost: 'dev', remotePort: 18787, token: fixture.token, roots: [a, b] });

it.skipIf(!supported)('shares one connection and stored token across multiple project directories', async () => {
  const host = await connect();
  const projects = await Promise.all([addManagedRemoteProject({ hostId: host.id, directory: a, createDirectory: false }),
    addManagedRemoteProject({ hostId: host.id, directory: b, createDirectory: false })]);
  expect(fixture.opens).toBe(1); expect(projects[0].id).not.toBe(projects[1].id);
  expect(JSON.stringify(await listProjects())).not.toContain(fixture.token);
  expect(JSON.stringify(await readDurable('remote-hosts'))).not.toContain(fixture.token);
  expect(fixture.secrets.size).toBe(1);
  await expect(saveRemoteHost({ sshHost: 'alias', remotePort: 18787, token: fixture.token, roots: [a] })).rejects.toThrow(/already configured/);
  expect(fixture.opens).toBe(1);
});

it.skipIf(!supported)('invalidates a prepared endpoint when directory permissions change without opening another SSH connection', async () => {
  const host = await connect(), prepared = await remoteEndpoint(host.id);
  await saveRemoteHost({ id: host.id, revision: host.revision, sshHost: 'dev', remotePort: 18787, roots: [a] });
  expect(fixture.opens).toBe(1);
  expect(() => prepared.assertCurrent()).toThrow(/permissions changed/);
  await expect(addManagedRemoteProject({ hostId: host.id, directory: b, createDirectory: false })).rejects.toThrow(/outside/);
});

it.skipIf(!supported)('creates an explicitly requested child directory inside an approved parent only', async () => {
  const host = await connect(), child = path.join(a, 'new-project');
  const project = await addManagedRemoteProject({ hostId: host.id, directory: child, createDirectory: true });
  expect(project.path).toBe(child); expect((await fs.stat(child)).isDirectory()).toBe(true);
  await expect(addManagedRemoteProject({ hostId: host.id, directory: path.join(directory, 'not-approved'), createDirectory: true })).rejects.toThrow(/outside/);
  await expect(fs.stat(path.join(directory, 'not-approved'))).rejects.toThrow();
});

it.skipIf(!supported)('honors disconnect, resumes one mapping after suspend, and cannot reopen after quit', async () => {
  const host = await connect();
  await disconnectRemoteHost(host.id);
  expect(fixture.stops).toBe(1);
  await expect(remoteEndpoint(host.id)).rejects.toThrow(/disconnected/);
  await reconnectRemoteHost(host.id); expect(fixture.opens).toBe(2);
  await suspendRemoteHosts(); expect(fixture.stops).toBe(2);
  expect(await listRemoteHosts()).toMatchObject([{ state: 'suspended' }]);
  await resumeRemoteHosts(); expect(fixture.opens).toBe(3);
  await closeRemoteHosts(); expect(fixture.stops).toBe(3);
  await expect(remoteEndpoint(host.id)).rejects.toThrow(/shutting down/);
});

it.skipIf(!supported)('rechecks create permission after waiting for the connection credential', async () => {
  const host = await connect(), target = path.join(a, 'revoked-create');
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  fixture.secretGate = async () => { entered(); await gate; };
  const pending = addManagedRemoteProject({ hostId: host.id, directory: target, createDirectory: true });
  const rejected = expect(pending).rejects.toThrow(/Creating files is disabled/);
  try {
    await waiting;
    await saveConfig({ ...getConfig(), readOnly: true });
  } finally { release(); fixture.secretGate = null; }
  await rejected;
  await expect(fs.stat(target)).rejects.toThrow();
});

it.skipIf(!supported)('verifies remote-only permissions with no shared local folders and reports a genuinely missing workspace', async () => {
  // 本用例只验证远程 Core；各平台的首启桌面权限不同，不能依赖 Mac 的默认值。
  const config = structuredClone(getConfig());
  for (const capability of DESKTOP_CAPABILITIES) config.capabilities[capability] = false;
  await saveConfig(config);
  const host = await connect();
  await addManagedRemoteProject({ hostId: host.id, directory: a, createDirectory: false });
  expect(getConfig().roots).toEqual([]);
  expect((await runDiagnostics()).checks.find(check => check.name === 'Permissions')).toMatchObject({ status: 'pass', ok: true });
  await fs.rmdir(a);
  expect((await runDiagnostics()).checks.find(check => check.name === 'Permissions')).toMatchObject({ status: 'fail', ok: false });
});
