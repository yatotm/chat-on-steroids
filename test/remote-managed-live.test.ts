import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { expect, it, vi } from 'vitest';
const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/main/secrets.js', () => ({
  getSecret: async (key: string) => secrets.get(key) ?? null,
  setSecret: async (key: string, value: string) => { secrets.set(key, value); },
  clearSecret: async (key: string) => { secrets.delete(key); }
}));
import { defaultConfig, effectiveCapabilities, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, createSession, resetSessionStoreForTests } from '../src/main/session/store.js';
import { addManagedRemoteProject, assignSessionProject } from '../src/main/projects.js';
import { observeRequestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { flushRecorder } from '../src/main/session/recorder.js';
import { startMcpServer } from '../src/main/mcp/server.js';
import { saveRemoteHost, listRemoteHosts, suspendRemoteHosts, resumeRemoteHosts, closeRemoteHosts, resetRemoteHostsForTests } from '../src/main/remote-hosts.js';
import { initializeSshTunnels } from '../src/main/ssh-tunnel.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const sshHost = process.env.COS_TEST_SSH_HOST;
const tokenFile = process.env.COS_EXECUTION_TEST_TOKEN_FILE;
const directory = process.env.COS_EXECUTION_TEST_DIRECTORY;
const remotePort = Number(process.env.COS_EXECUTION_TEST_REMOTE_PORT || '18788');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

// 使用明确指定的验收目录和独立端口；不复用已安装应用的数据，不操作用户手动 SSH。
it.skipIf(!sshHost || !tokenFile || !directory || process.platform === 'win32')('uses one real managed SSH connection for two Linux projects and survives reconnect without replaying a command', async () => {
  const local = await makeTempDir('cos-managed-live-');
  const runDirectory = directory + '/managed-' + randomUUID();
  const a = runDirectory + '/app', b = runDirectory + '/library';
  initConfigPath(local); initDurableStore(local); initSessionStore(local);
  await saveConfig({ ...defaultConfig(), roots: [] });
  await initializeSshTunnels(local);
  const endpoint = await startMcpServer(() => ({ roots: [], caps: effectiveCapabilities(getConfig()), readOnly: getConfig().readOnly }));
  let sequence = 0, requestId = randomUUID(), hostId = '', projectsCreated = false;
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(endpoint.urls.core, { method: 'POST', headers: { 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'x-request-id': requestId },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } }) });
    const text = await response.text();
    const wire = JSON.parse(text.startsWith('{') ? text : [...text.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
    expect(wire.error).toBeUndefined(); return wire.result;
  };
  try {
    let host = await saveRemoteHost({ sshHost: sshHost!, remotePort, token: (await fs.readFile(tokenFile!, 'utf8')).trim(), roots: [directory!] });
    hostId = host.id;
    const [first, second] = await Promise.all([addManagedRemoteProject({ hostId, directory: a, createDirectory: true }),
      addManagedRemoteProject({ hostId, directory: b, createDirectory: true })]);
    projectsCreated = true;
    const originalPort = host.localPort;
    host = await saveRemoteHost({ id: hostId, revision: host.revision, sshHost: sshHost!, remotePort, roots: [a, b] });
    expect(host.localPort).toBe(originalPort); expect(await listRemoteHosts()).toHaveLength(1); expect(secrets.size).toBe(1);
    const session = await createSession({ title: 'Managed Linux acceptance', conversationId: 'managed-linux-acceptance' });
    await assignSessionProject(session.id, first.id);
    observeRequestCorrelation({ requestId, conversationId: 'managed-linux-acceptance', sessionId: session.id,
      messageId: randomUUID(), tool: 'read', observedAt: Date.now() });
    const patch = await call('apply_patch', { patch: `*** Begin Patch\n*** Add File: primary.txt\n+primary workspace\n*** Add File: ${b}/dependency.txt\n+shared dependency\n*** End Patch` });
    expect(patch.isError, JSON.stringify(patch)).not.toBe(true);
    expect(JSON.stringify(await call('read', { paths: [b + '/dependency.txt'] }))).toContain('shared dependency');
    const command = await call('exec_command', { cmd: 'uname -s; pwd', yield_time_ms: 1000 });
    expect(command.structuredContent.output).toContain('Linux'); expect(command.structuredContent.output).toContain(a);
    const launched = await call('exec_command', { cmd: 'printf x >> once; read -r answer; printf "reply=%s\n" "$answer"', tty: true, yield_time_ms: 250 });
    const processId = launched.structuredContent.session_id;
    expect(processId).toMatch(/^cos:/);
    await suspendRemoteHosts();
    expect(await listRemoteHosts()).toMatchObject([{ state: 'suspended', localPort: null }]);
    await resumeRemoteHosts();
    expect(await listRemoteHosts()).toMatchObject([{ state: 'connected' }]);
    const narrowed = await saveRemoteHost({ id: hostId, revision: host.revision, sshHost: sshHost!, remotePort, roots: [a] });
    expect((await call('read', { paths: [b + '/dependency.txt'] })).isError).toBe(true);
    expect(JSON.stringify(await call('write_stdin', { session_id: processId, chars: 'rejected\n' }))).toContain('REMOTE_PERMISSIONS_CHANGED');
    host = await saveRemoteHost({ id: hostId, revision: narrowed.revision, sshHost: sshHost!, remotePort, roots: [a, b] });
    const finished = await call('write_stdin', { session_id: processId, chars: 'accepted\n', yield_time_ms: 1000 });
    expect(finished.structuredContent.output).toContain('reply=accepted'); expect(finished.structuredContent.output).not.toContain('rejected');
    expect(JSON.stringify(await call('read', { paths: ['once'] }))).toContain('x');
    const checked = await call('exec_command', { cmd: 'test "$(cat once)" = x', yield_time_ms: 1000 });
    expect(checked.structuredContent.exit_code).toBe(0);
    expect(second.id).not.toBe(first.id);
    const removed = await call('exec_command', { cmd: 'rm -rf -- ' + quote(runDirectory), yield_time_ms: 1000 });
    expect(removed.structuredContent.exit_code).toBe(0); projectsCreated = false;
    const port = host.localPort;
    await closeRemoteHosts();
    await expect(fetch('http://127.0.0.1:' + port + '/mcp')).rejects.toThrow();
  } finally {
    if (projectsCreated && hostId) await call('exec_command', { cmd: 'rm -rf -- ' + quote(runDirectory), yield_time_ms: 1000 }).catch(() => undefined);
    await endpoint.stop(); await flushRecorder(); await resetRemoteHostsForTests();
    resetCorrelationRegistryForTests(); resetSessionStoreForTests(); resetDurableForTests(); secrets.clear(); await removeTempDir(local);
  }
}, 60000);
