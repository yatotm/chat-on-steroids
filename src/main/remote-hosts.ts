import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readDurable, writeDurableNow, writeDurableSoon } from './durable.js';
import { clearSecret, getSecret, setSecret } from './secrets.js';
import { effectiveCapabilities, getConfig } from './config.js';
import { executionRpc } from './execution-client.js';
import { resolveSshHost } from './ssh-config.js';
import { openSshTunnel, type SshTunnel } from './ssh-tunnel.js';
import { executionServiceSchema, executionWorkspaceSchema, type ExecutionService } from '../shared/remote-execution.js';
import { remoteHostSchema, saveRemoteHostSchema, insideRemoteRoot,
  type RemoteHost, type RemoteHostView, type SaveRemoteHost } from '../shared/remote-hosts.js';

interface Runtime {
  key: string; controller: AbortController; tunnel: SshTunnel | null;
  service: ExecutionService | null; state: RemoteHostView['state']; checkedAt: number | null; detail: string;
  starting: Promise<void> | null;
}
export interface RemoteEndpoint {
  host: RemoteHost; url: string; token: string; service: ExecutionService; assertCurrent(): void; failed(message: string): void;
}
export interface ExistingExecutionCredential { serverId: string; credentialId: string }
const catalogSchema = z.array(remoteHostSchema).max(32);
let records: RemoteHost[] | null = null, loading: Promise<RemoteHost[]> | null = null;
let mutations: Promise<unknown> = Promise.resolve(), closing: Promise<void> | null = null;
let powerTransitions: Promise<void> = Promise.resolve();
let powerEpoch = 0;
let stopped = false, suspended = false;
let healthTimer: ReturnType<typeof setInterval> | null = null;
const runtimes = new Map<string, Runtime>();
const updating = new Set<string>();
const listeners = new Set<() => void>();

function changed(): void { for (const listener of listeners) { try { listener(); } catch { /* 展示回调不能影响连接所有权。 */ } } }
export function onRemoteHostsChanged(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
function requireOpen(): void {
  if (stopped) throw new Error('CoS is shutting down. No remote connection was opened.');
  if (suspended) throw new Error('Remote connections are suspended. Wait for this computer to wake.');
}
export function remoteFailure(response: Record<string, unknown>): void {
  if (!response.isError) return;
  const content = Array.isArray(response.content) ? response.content : [];
  const message = content.filter((entry): entry is { type: string; text: string } => !!entry && typeof entry === 'object' &&
    (entry as { type?: unknown }).type === 'text' && typeof (entry as { text?: unknown }).text === 'string')
    .map(entry => entry.text).join('\n').slice(0, 1600);
  throw new Error(message || 'The CoS execution service rejected this request.');
}

async function load(): Promise<RemoteHost[]> {
  if (records) return records;
  return loading ??= (async () => {
    const loaded = catalogSchema.parse(await readDurable('remote-hosts') ?? []);
    if (new Set(loaded.map(host => host.id)).size !== loaded.length ||
        new Set(loaded.map(host => host.targetKey)).size !== loaded.length ||
        new Set(loaded.map(host => host.serverId)).size !== loaded.length)
      throw new Error('The saved development server connections are ambiguous.');
    records = loaded;
    return loaded;
  })().finally(() => { loading = null; });
}
export async function getRemoteHost(id: string): Promise<RemoteHost> {
  const host = (await load()).find(row => row.id === id);
  if (!host) throw new Error('This development server connection is unavailable.');
  return host;
}
export function hasManagedRemoteHosts(): boolean { return !!records?.length; }
function key(host: RemoteHost): string { return JSON.stringify([host.sshHost, host.targetKey, host.remotePort, host.credentialId, host.serverId]); }
function view(host: RemoteHost): RemoteHostView {
  const live = runtimes.get(host.id);
  return { id: host.id, sshHost: host.sshHost, serverId: host.serverId, remotePort: host.remotePort, roots: [...host.roots],
    revision: host.revision, enabled: host.enabled, state: suspended ? 'suspended' : live?.state ?? 'disconnected',
    checkedAt: live?.checkedAt ?? null, detail: live?.detail ?? '', localPort: live?.tunnel?.alive() ? live.tunnel.port : null };
}
export async function listRemoteHosts(): Promise<RemoteHostView[]> { return (await load()).map(view); }
async function publish(next: RemoteHost[]): Promise<void> {
  const previous = await load();
  try { await writeDurableNow('remote-hosts', next); }
  catch (error) { writeDurableSoon('remote-hosts', previous); throw error; }
  records = next; changed();
}
function mutation<T>(run: () => Promise<T>): Promise<T> {
  const result = mutations.then(run);
  mutations = result.then(() => undefined, () => undefined);
  return result;
}

/** 先撤销本代准入，再等待它启动或结束；旧映射清理完成前不能启动新映射。 */
async function retire(id: string): Promise<void> {
  const live = runtimes.get(id);
  if (!live) return;
  live.controller.abort(); live.state = 'disconnected'; live.service = null; changed();
  await live.starting?.catch(() => undefined);
  try { await live.tunnel?.stop(); }
  catch (error) {
    live.state = 'error'; live.detail = 'The previous CoS SSH mapping could not be closed. Retry reconnecting before opening another one.';
    changed(); throw error;
  }
  if (runtimes.get(id) === live) runtimes.delete(id);
  changed();
}
function current(host: RemoteHost, live: Runtime): void {
  requireOpen();
  if (runtimes.get(host.id) !== live || live.controller.signal.aborted)
    throw new Error('The development server connection changed.');
}
async function verifyService(host: RemoteHost, live: Runtime, token: string, expectedServerId?: string | null): Promise<void> {
  current(host, live);
  const response = await executionRpc(live.tunnel!.url, token, 'cos_info', expectedServerId ? { serverId: expectedServerId } : {});
  remoteFailure(response);
  const service = executionServiceSchema.safeParse(response.structuredContent);
  if (!service.success) throw new Error('Update the CoS execution service on the development server before connecting.');
  if (expectedServerId && service.data.serverId !== expectedServerId) throw new Error('This is a different CoS execution service.');
  current(host, live);
  live.service = service.data; live.checkedAt = Date.now(); live.state = 'connected'; live.detail = ''; changed();
}

async function ensure(host: RemoteHost, refresh = false, suppliedToken?: string, expectedServerId: string | null = host.serverId): Promise<Runtime> {
  requireOpen();
  if (!host.enabled) throw new Error('This development server is disconnected. Use Reconnect to enable it.');
  let live = runtimes.get(host.id);
  if (live && (live.key !== key(host) || live.controller.signal.aborted)) { await retire(host.id); live = undefined; }
  if (!live) {
    live = { key: key(host), controller: new AbortController(), tunnel: null, service: null,
      state: 'disconnected', checkedAt: null, detail: '', starting: null };
    runtimes.set(host.id, live);
  }
  const owned = live;
  if (!owned.starting && (!owned.tunnel?.alive() || refresh || owned.state !== 'connected')) {
    owned.state = 'connecting'; changed();
    owned.starting = (async () => {
      const target = await resolveSshHost(host.sshHost, owned.controller.signal);
      current(host, owned);
      if (target !== host.targetKey) throw new Error('The SSH host configuration changed. Edit this connection to confirm its target.');
      if (!owned.tunnel?.alive()) {
        await owned.tunnel?.stop();
        current(host, owned);
        const tunnel = await openSshTunnel(host.sshHost, host.remotePort, owned.controller.signal);
        try { current(host, owned); } catch (error) { await tunnel.stop(); throw error; }
        owned.tunnel = tunnel;
        void tunnel.closed.then(() => {
          if (runtimes.get(host.id) !== owned || owned.tunnel !== tunnel || owned.controller.signal.aborted) return;
          owned.service = null; owned.state = 'error'; owned.detail = 'The SSH connection closed.'; changed();
          void tunnel.stop().catch(() => {
            if (runtimes.get(host.id) !== owned) return;
            owned.detail = 'The previous CoS SSH mapping could not be closed. Retry reconnecting before opening another one.'; changed();
          });
        });
      }
      const token = suppliedToken ?? await getSecret(`execution:${host.credentialId}`);
      if (!token) throw new Error('This development server has no saved execution token. Edit its connection.');
      await verifyService(host, owned, token, expectedServerId);
    })().catch(async error => {
      if (runtimes.get(host.id) === owned && !owned.controller.signal.aborted) {
        owned.state = 'error'; owned.service = null;
        owned.detail = error instanceof Error ? error.message : 'The development server is unavailable.';
        changed();
      }
      throw error;
    }).finally(() => { owned.starting = null; });
  }
  await owned.starting;
  current(host, owned);
  if (!owned.tunnel?.alive() || !owned.service) throw new Error('The development server is not connected.');
  return owned;
}

export async function remoteEndpoint(id: string): Promise<RemoteEndpoint> {
  const host = await getRemoteHost(id);
  if (updating.has(id)) throw new Error('This development server connection is being updated.');
  const live = await ensure(host);
  const token = await getSecret(`execution:${host.credentialId}`);
  if (!token) throw new Error('The execution service token is unavailable.');
  const assertCurrent = () => {
    current(host, live);
    if (!host.enabled || updating.has(id) || records?.find(row => row.id === id) !== host || !live.tunnel?.alive())
      throw new Error('The development server or its permissions changed.');
  };
  assertCurrent();
  return { host, url: live.tunnel!.url, token, service: live.service!, assertCurrent,
    failed(message) {
      try { assertCurrent(); } catch { return; }
      live.state = 'error'; live.detail = message.slice(0, 1600); changed();
    } };
}

export async function validateHostDirectory(endpoint: RemoteEndpoint, directory: string, create = false): Promise<string> {
  if (create && !insideRemoteRoot(endpoint.host.roots, directory)) throw new Error('The project is outside this development server\'s approved directories. Edit its directory list first.');
  endpoint.assertCurrent();
  if (create && !effectiveCapabilities(getConfig()).create) throw new Error('Creating files is disabled in CoS permissions.');
  const result = await executionRpc(endpoint.url, endpoint.token, 'cos_workspace', { directory, serverId: endpoint.host.serverId,
    roots: endpoint.host.roots, ...(create ? { create: true } : {}) });
  remoteFailure(result);
  const value = executionWorkspaceSchema.parse(result.structuredContent);
  endpoint.assertCurrent();
  if (!insideRemoteRoot(endpoint.host.roots, value.root)) throw new Error('The project resolves outside its approved directories.');
  return value.root;
}

/** 凭据属于开发机。项目复用连接引用，不再各自保存同一令牌或启动各自的转发。 */
export function saveRemoteHost(raw: SaveRemoteHost, reuse?: ExistingExecutionCredential): Promise<RemoteHostView> {
  const input = saveRemoteHostSchema.parse(raw);
  return mutation(async () => {
    requireOpen();
    const hosts = await load();
    const before = input.id ? hosts.find(host => host.id === input.id) : undefined;
    if (input.id && (!before || before.revision !== input.revision)) throw new Error('The development server changed. Open its settings again.');
    if (!before && hosts.length >= 32) throw new Error('At most 32 development servers can be configured.');
    const targetKey = await resolveSshHost(input.sshHost);
    requireOpen();
    const duplicate = hosts.find(host => host.id !== before?.id && host.targetKey === targetKey);
    if (duplicate) throw new Error(`This SSH target is already configured as ${duplicate.sshHost}. Select that connection to add another project.`);
    const token = input.token ?? (before ? await getSecret(`execution:${before.credentialId}`)
      : reuse ? await getSecret(`execution:${reuse.credentialId}`) : null);
    if (!token) throw new Error('Enter the execution service token for this development server.');
    const id = before?.id ?? randomUUID();
    const credentialId = input.token || !before ? randomUUID() : before.credentialId;
    const expectedId = before?.serverId ?? reuse?.serverId;
    const host: RemoteHost = { id, sshHost: input.sshHost, remotePort: input.remotePort, targetKey,
      credentialId, serverId: expectedId ?? randomUUID(), roots: input.roots,
      enabled: true, revision: (before?.revision ?? 0) + 1 };
    const transportChanged = !before || key(before) !== key(host);
    let accepted = false, secretWritten = false;
    updating.add(id);
    try {
      if (transportChanged) await retire(id);
      const live = await ensure(host, true, token, expectedId ?? null);
      const service = live.service!;
      if (hosts.some(row => row.id !== id && row.serverId === service.serverId))
        throw new Error('This execution service already has a connection. Select it instead of creating another mapping.');
      const roots: string[] = [];
      for (const directory of input.roots) {
        current(host, live);
        const result = await executionRpc(live.tunnel!.url, token, 'cos_workspace', { directory, serverId: service.serverId });
        remoteFailure(result);
        roots.push(executionWorkspaceSchema.parse(result.structuredContent).root);
      }
      current(host, live);
      host.serverId = service.serverId; host.roots = [...new Set(roots)];
      live.key = key(host);
      if (credentialId !== before?.credentialId) { await setSecret(`execution:${credentialId}`, token); secretWritten = true; }
      requireOpen();
      await publish(before ? hosts.map(row => row.id === id ? host : row) : [...hosts, host]);
      accepted = true;
      if (before && before.credentialId !== credentialId) await clearSecret(`execution:${before.credentialId}`).catch(() => undefined);
      startHealthChecks();
      return view(host);
    } finally {
      if (!accepted) {
        if (transportChanged) await retire(id);
        if (secretWritten) await clearSecret(`execution:${credentialId}`).catch(() => undefined);
      }
      updating.delete(id);
    }
  });
}

export async function refreshRemoteHost(id: string): Promise<RemoteHostView> {
  const host = await getRemoteHost(id);
  if (host.enabled && !updating.has(id)) await ensure(host, true).catch(() => undefined);
  return view(host);
}
export function reconnectRemoteHost(id: string): Promise<RemoteHostView> {
  return mutation(async () => {
    requireOpen();
    let host = await getRemoteHost(id);
    await retire(id);
    if (!host.enabled) {
      host = { ...host, enabled: true, revision: host.revision + 1 };
      await publish((await load()).map(row => row.id === id ? host : row));
    }
    await ensure(host, true).catch(() => undefined);
    startHealthChecks();
    return view(host);
  });
}
export function disconnectRemoteHost(id: string): Promise<RemoteHostView> {
  return mutation(async () => {
    const previous = await getRemoteHost(id);
    const host = { ...previous, enabled: false, revision: previous.revision + 1 };
    await publish((await load()).map(row => row.id === id ? host : row));
    await retire(id);
    return view(host);
  });
}
function startHealthChecks(): void {
  if (!records?.some(host => host.enabled)) {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = null; return;
  }
  if (healthTimer || stopped) return;
  // 只有这一处按开发机检查服务，项目和界面刷新不创建各自的定时器。
  healthTimer = setInterval(() => {
    if (stopped || suspended) return;
    for (const host of records ?? []) if (host.enabled) void refreshRemoteHost(host.id);
  }, 30_000);
  healthTimer.unref();
}
export async function restoreRemoteHosts(): Promise<void> {
  const hosts = await load();
  startHealthChecks();
  await Promise.allSettled(hosts.filter(host => host.enabled && !updating.has(host.id)).map(host => ensure(host, true)));
}
export async function initializeRemoteHosts(): Promise<void> { await load(); }
export async function suspendRemoteHosts(): Promise<void> {
  powerEpoch++;
  suspended = true;
  for (const live of runtimes.values()) live.controller.abort();
  powerTransitions = powerTransitions.catch(() => undefined).then(async () => {
    await Promise.allSettled([...runtimes.keys()].map(retire)); changed();
  });
  await powerTransitions;
}
export async function resumeRemoteHosts(): Promise<void> {
  if (stopped) return;
  const epoch = ++powerEpoch;
  powerTransitions = powerTransitions.catch(() => undefined).then(async () => {
    if (stopped || epoch !== powerEpoch) return;
    suspended = false;
    await restoreRemoteHosts();
  });
  await powerTransitions;
}
export function beginRemoteHostShutdown(): void {
  powerEpoch++;
  stopped = true;
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
  for (const live of runtimes.values()) if (live.starting) live.controller.abort();
}
export function closeRemoteHosts(): Promise<void> {
  if (closing) return closing;
  beginRemoteHostShutdown();
  for (const live of runtimes.values()) live.controller.abort();
  closing = (async () => {
    await powerTransitions.catch(() => undefined);
    await mutations;
    await Promise.allSettled([...runtimes.keys()].map(retire));
  })();
  return closing;
}
export async function resetRemoteHostsForTests(): Promise<void> {
  await closeRemoteHosts(); records = null; loading = null; mutations = Promise.resolve(); closing = null;
  powerTransitions = Promise.resolve(); stopped = false; suspended = false; runtimes.clear(); updating.clear(); listeners.clear();
}
