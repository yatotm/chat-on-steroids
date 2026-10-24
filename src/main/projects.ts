import { getRemoteHost, remoteEndpoint, validateHostDirectory } from './remote-hosts.js';
import { managedRemoteProjectSchema, type ManagedRemoteProject } from '../shared/remote-hosts.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rawPromises as fs } from './rawfs.js';
import { readDurable, writeDurableNow, writeDurableSoon } from './durable.js';
import { effectiveCapabilities, getConfig, updateConfig } from './config.js';
import { nativePathIdentity, resolvePath, uniqueRootName } from './sandbox.js';
import { parseRemote, remoteIdentity, sftpFor } from './remote/ssh.js';
import { SftpError, type SftpClient } from './remote/sftp.js';
import type { RemoteFolder, Root } from '../shared/types.js';
import { bindSessionProject, findSessionByConversation, getSession } from './session/store.js';
import { workspaceForChat } from './workspace.js';
import { logInfo, logWarn } from './logger.js';
import { CHATGPT_PROJECT_ID, PROJECT_COLORS, isManagedRemote, isSftpRemote, type ChatgptProjectLink, type LocalProject, type ProjectColor } from '../shared/projects.js';
import { probeRemoteWorkspace, remoteBindingSchema, validateRemoteProject } from './remote-workspace.js';
import { connectRemoteProjectSchema, isCoreRemote, type ConnectRemoteProject } from '../shared/remote-execution.js';
import { clearSecret, getSecret, setSecret } from './secrets.js';

const at = z.number().finite().nonnegative();
const requestId = z.string().uuid();
const chatgptSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('requested'), requestId, updatedAt: at }),
  z.object({ state: z.literal('claimed'), requestId, owner: z.string().min(1).max(64), updatedAt: at }),
  z.object({ state: z.literal('creating'), requestId, owner: z.string().min(1).max(64), updatedAt: at }),
  z.object({ state: z.literal('linked'), id: z.string().regex(CHATGPT_PROJECT_ID), updatedAt: at }),
  z.object({ state: z.literal('failed'), requestId, error: z.string().max(500), updatedAt: at }),
  z.object({ state: z.literal('uncertain'), requestId, error: z.string().max(500), updatedAt: at })
]);
const projectSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(160), path: z.string().min(1).max(32768),
  color: z.enum(PROJECT_COLORS).optional(),
  createdAt: z.number().finite().nonnegative(), ungrouped: z.boolean().optional(), secretsShieldOff: z.boolean().optional(),
  chatgpt: chatgptSchema.optional(),
  remote: z.union([remoteBindingSchema, z.object({ host: z.string().min(1).max(255), port: z.number().int().min(1).max(65535).optional(), path: z.string().min(1).max(4096) }).strict()]).optional()
});
const catalogSchema = z.array(projectSchema).max(200);
let mutations: Promise<unknown> = Promise.resolve();
const remoteBindings = new Map<string, { changing: boolean }>();
function trimRemoteBindings(): void {
  for (const [id, held] of remoteBindings) {
    if (remoteBindings.size <= 256) break;
    if (!held.changing) remoteBindings.delete(id);
  }
}

/** 绑定变更的在途代属于项目目录所有者；不复制绑定或权限，只撤销旧的异步执行准备。 */
export function remoteBindingFence(projectId: string): () => void {
  let current = remoteBindings.get(projectId);
  if (!current) {
    current = { changing: false }; remoteBindings.set(projectId, current);
    trimRemoteBindings();
  }
  const expected = current;
  const check = () => {
    if (remoteBindings.get(projectId) !== expected || expected.changing)
      throw new Error('The remote project binding changed. No operation was dispatched.');
  };
  check();
  return check;
}
const samePath = (a: string, b: string) => nativePathIdentity(a) === nativePathIdentity(b);

const projectIdentity = (project: LocalProject): string => !project.remote ? nativePathIdentity(project.path)
  : isSftpRemote(project.remote) ? `ssh:${remoteIdentity(project.remote)}`
  : isManagedRemote(project.remote) ? `host:${project.remote.hostId}:${project.path}`
  : isCoreRemote(project.remote) ? `core:${project.remote.serverId}:${project.path}`
  : `legacy:${project.remote.pluginId}:${project.remote.endpointId}:${project.remote.workspaceId}`;

export async function listProjects(): Promise<LocalProject[]> {
  const raw = await readDurable<unknown>('projects');
  if (raw === null) return [];
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success || new Set(parsed.data.map(row => row.id)).size !== parsed.data.length) throw new Error('Project catalog is invalid');
  if (new Set(parsed.data.map(projectIdentity)).size !== parsed.data.length) throw new Error('Project catalog is invalid');
  return parsed.data;
}
export async function getProject(id: string): Promise<LocalProject | null> {
  return (await listProjects()).find(project => project.id === id) ?? null;
}
/** Folder picker callers approve roots separately; project selection cannot widen them. */
export function addProject(folderPath: string): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    if (!path.isAbsolute(folderPath)) throw new Error('Choose an absolute local project folder');
    const resolved = await resolvePath(getConfig().roots, folderPath);
    if (!(await fs.stat(resolved.real)).isDirectory()) throw new Error('Choose a project folder');
    const projects = await listProjects();
    const existing = projects.find(project => !project.remote && samePath(project.path, resolved.real));
    if (existing) {
      if (!existing.ungrouped) return existing;
      const { ungrouped: _, ...restored } = existing;
      await writeDurableNow('projects', projects.map(project => project.id === existing.id ? restored : project));
      return restored;
    }
    if (projects.length >= 200) throw new Error('Project catalog limit reached');
    // Only a project created here gets a native ChatGPT Project; an existing or restored one
    // above keeps exactly what it had.
    const project: LocalProject = { id: randomUUID(), name: (path.basename(resolved.real) || resolved.real).slice(0, 160), path: resolved.real, createdAt: Date.now(),
      chatgpt: { state: 'requested', requestId: randomUUID(), updatedAt: Date.now() } };
    await writeDurableNow('projects', [...projects, project]);
    logInfo(`projects: project ${project.id} asks for a new ChatGPT Project`);
    return project;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}


/**
 * Adds a folder on a server as a project and an approved root (#1469), by its real path there.
 * The server is asked once, over SFTP: the folder must exist and be a folder. `~/app` resolves
 * against the server's home, the way `ssh -s sftp` resolves a relative path.
 */
export function addRemoteProject(request: ConnectRemoteProject): Promise<LocalProject>;
export function addRemoteProject(address: string, folder: string, deps?: { connect?: (remote: RemoteFolder) => Promise<SftpClient> }): Promise<LocalProject>;
export function addRemoteProject(request: ConnectRemoteProject | string, folder?: string, deps?: { connect?: (remote: RemoteFolder) => Promise<SftpClient> }): Promise<LocalProject> {
  if (typeof request !== 'string') return addExecutionProject(request);
  if (folder === undefined) throw new Error('Enter a folder on the server');
  return addSftpProject(request, folder, deps);
}

function addSftpProject(address: string, folder: string, deps: { connect?: (remote: RemoteFolder) => Promise<SftpClient> } = {}): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    const asked = parseRemote(address, folder);
    const client = await (deps.connect ?? sftpFor)(asked);
    const query = asked.path === '~' ? '.' : asked.path.startsWith('~/') ? asked.path.slice(2) : asked.path;
    let realPath: string;
    try { realPath = await client.realpath(query); }
    catch (error) {
      if (error instanceof SftpError && error.code === 'ENOENT') throw new Error(`Folder not found on the server: ${asked.path}`);
      throw error;
    }
    const stats = await client.stat(realPath).catch(error => {
      if (error instanceof SftpError && error.code === 'ENOENT') throw new Error(`Folder not found on the server: ${asked.path}`);
      throw error;
    });
    if (!stats.isDirectory) throw new Error(`${asked.path} on the server is not a folder`);
    const remote: RemoteFolder = { host: asked.host, ...(asked.port ? { port: asked.port } : {}), path: realPath };
    const identity = remoteIdentity(remote);
    const projects = await listProjects();
    const existing = projects.find(project => project.remote && isSftpRemote(project.remote) && remoteIdentity(project.remote) === identity);
    await updateConfig(config => {
      if (config.roots.some(root => root.remote && remoteIdentity(root.remote) === identity)) return config;
      if (config.roots.length >= 32) throw new Error('Folder limit reached');
      return { ...config, roots: [...config.roots, { name: uniqueRootName(path.posix.basename(realPath) || 'server', config.roots), path: identity, remote }] };
    });
    if (existing) {
      if (!existing.ungrouped) return existing;
      const { ungrouped: _, ...restored } = existing;
      await writeDurableNow('projects', projects.map(project => project.id === existing.id ? restored : project));
      return restored;
    }
    if (projects.length >= 200) throw new Error('Project catalog limit reached');
    const project: LocalProject = { id: randomUUID(), name: (path.posix.basename(realPath) || identity).slice(0, 160), path: identity, remote,
      createdAt: Date.now(), chatgpt: { state: 'requested', requestId: randomUUID(), updatedAt: Date.now() } };
    await writeDurableNow('projects', [...projects, project]);
    logInfo(`projects: project ${project.id} asks for a new ChatGPT Project`);
    return project;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}

async function addExecutionProject(request: ConnectRemoteProject): Promise<LocalProject> {
  const input = connectRemoteProjectSchema.parse(request);
  if (input.replace && isManagedRemote(input.replace.binding)) throw new Error('Use the development server settings to change this managed connection.');
  const expectedServer = input.replace && isCoreRemote(input.replace.binding) && !isManagedRemote(input.replace.binding) ? input.replace.binding.serverId : undefined;
  const verified = await probeRemoteWorkspace(input.url, input.token, input.directory, expectedServer);
  const operation = mutations.then(async () => {
    const projects = await listProjects();
    const replaced = input.replace ? projects.find(row => row.id === input.replace!.projectId) : undefined;
    if (input.replace && (!replaced || replaced.path !== input.replace.path ||
        JSON.stringify(replaced.remote) !== JSON.stringify(input.replace.binding)))
      throw new Error('The remote project changed while connecting. Open the dialog again.');
    if (replaced && verified.root !== replaced.path)
      throw new Error('Reconnecting must keep the existing project directory. Add a new project for another directory.');
    const credentialId = randomUUID();
    const project: LocalProject = { ...replaced,
      ...(replaced ? {} : { chatgpt: { state: 'requested' as const, requestId: randomUUID(), updatedAt: Date.now() } }),
      id: replaced?.id ?? randomUUID(), name: replaced?.name ?? path.posix.basename(verified.root).slice(0, 160),
      path: verified.root, remote: { kind: 'core', url: input.url, serverId: verified.serverId, credentialId },
      createdAt: replaced?.createdAt ?? Date.now() };
    const duplicate = projects.find(row => row.id !== replaced?.id && projectIdentity(row) === projectIdentity(project));
    if (duplicate) {
      if (replaced) throw new Error('This execution workspace already belongs to another project.');
      if (!duplicate.remote || !isCoreRemote(duplicate.remote) || isManagedRemote(duplicate.remote) || duplicate.remote.url !== input.url ||
          await getSecret(`execution:${duplicate.remote.credentialId}`) !== input.token)
        throw new Error('This project already exists. Select Reconnect for that project to update its connection.');
      if (!duplicate.ungrouped) return duplicate;
      const { ungrouped: _, ...restored } = duplicate;
      await writeDurableNow('projects', projects.map(row => row.id === duplicate.id ? restored : row));
      return restored;
    }
    if (!replaced && projects.length >= 200) throw new Error('Project catalog limit reached');
    // 新凭据先落盘，项目提交后才对调用可见。失败不能破坏旧绑定的凭据。
    const binding = { changing: true };
    remoteBindings.set(project.id, binding);
    trimRemoteBindings();
    let published = false;
    try {
      await setSecret(`execution:${credentialId}`, input.token);
      try { await writeDurableNow('projects', replaced ? projects.map(row => row.id === replaced.id ? project : row) : [...projects, project]); }
      catch (error) {
        // 失败的立即写入会被 durable 重试，先用已公布目录覆盖该代，防止后台接受被拒绝的连接。
        writeDurableSoon('projects', projects);
        await clearSecret(`execution:${credentialId}`).catch(() => undefined);
        throw error;
      }
      published = true;
      if (replaced?.remote && isCoreRemote(replaced.remote) && !isManagedRemote(replaced.remote))
        await clearSecret(`execution:${replaced.remote.credentialId}`).catch(() => logWarn('An obsolete execution credential could not be removed.'));
      return project;
    } finally {
      binding.changing = false;
      if (!published && !replaced && remoteBindings.get(project.id) === binding) remoteBindings.delete(project.id);
    }
  });
  mutations = operation.catch(() => undefined);
  return operation;
}

/** 先确认目录和权限，再登记项目；连接本身已由开发机所有者保存。 */
export async function addManagedRemoteProject(raw: ManagedRemoteProject): Promise<LocalProject> {
  const input = managedRemoteProjectSchema.parse(raw);
  if (input.createDirectory && !effectiveCapabilities(getConfig()).create) throw new Error('Creating files is disabled in CoS permissions.');
  const endpoint = await remoteEndpoint(input.hostId);
  const directory = await validateHostDirectory(endpoint, input.directory, input.createDirectory);
  const operation = mutations.then(async () => {
    endpoint.assertCurrent();
    const projects = await listProjects();
    const project: LocalProject = { id: randomUUID(), name: path.posix.basename(directory), path: directory,
      createdAt: Date.now(), remote: { kind: 'core', hostId: input.hostId },
      chatgpt: { state: 'requested', requestId: randomUUID(), updatedAt: Date.now() } };
    const duplicate = projects.find(row => projectIdentity(row) === projectIdentity(project));
    if (duplicate && !duplicate.ungrouped) return duplicate;
    if (!duplicate && projects.length >= 200) throw new Error('Project catalog limit reached');
    const { ungrouped: _, ...restored } = duplicate ?? project;
    try { await writeDurableNow('projects', duplicate ? projects.map(row => row.id === duplicate.id ? restored : row) : [...projects, project]); }
    catch (error) { writeDurableSoon('projects', projects); throw error; }
    return duplicate ? restored : project;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}

/** 显式选择旧服务与 SSH 主机，且服务身份相同后，统一迁移该连接的项目，保留全部项目身份。 */
export function migrateRemoteProjects(hostId: string, expected: Pick<LocalProject, 'id' | 'path' | 'remote'>): Promise<void> {
  const operation = mutations.then(async () => {
    const projects = await listProjects();
    const source = projects.find(project => project.id === expected.id);
    if (!source?.remote || source.path !== expected.path || JSON.stringify(source.remote) !== JSON.stringify(expected.remote))
      throw new Error('The project changed while its SSH connection was being configured. Open the dialog again.');
    if (isManagedRemote(source.remote)) {
      if (source.remote.hostId !== hostId) throw new Error('This project already uses a different managed connection.');
      return;
    }
    const binding = source.remote;
    const host = await getRemoteHost(hostId);
    let changed: LocalProject[];
    if (isCoreRemote(binding)) {
      if (host.serverId !== binding.serverId) throw new Error('The SSH host runs a different execution service.');
      changed = projects.filter(project => project.remote && isCoreRemote(project.remote) && !isManagedRemote(project.remote) &&
        project.remote.serverId === binding.serverId && project.remote.url === binding.url);
    } else {
      // 旧 CodexPro 没有 CoS 服务身份，只迁移用户明确选择且在新服务上验证过的这一个目录。
      await validateHostDirectory(await remoteEndpoint(hostId), source.path);
      changed = [source];
    }
    const ids = new Set(changed.map(project => project.id));
    const next = projects.map(project => ids.has(project.id) ? { ...project, remote: { kind: 'core' as const, hostId } } : project);
    if (new Set(next.map(projectIdentity)).size !== next.length) throw new Error('A migrated project would duplicate an existing workspace.');
    const fences = changed.map(project => { const fence = { changing: true }; remoteBindings.set(project.id, fence); return fence; });
    try { await writeDurableNow('projects', next); }
    catch (error) { writeDurableSoon('projects', projects); throw error; }
    finally { for (const fence of fences) fence.changing = false; }
    for (const project of changed) if (project.remote && isCoreRemote(project.remote) && !isManagedRemote(project.remote))
      await clearSecret(`execution:${project.remote.credentialId}`).catch(() => logWarn('An obsolete execution credential could not be removed.'));
  });
  mutations = operation.catch(() => undefined);
  return operation;
}

export async function validateProject(projectId: string): Promise<LocalProject> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  if (project.remote && !isSftpRemote(project.remote)) validateRemoteProject(project);
  else await resolveProject(project);
  return project;
}

export async function sessionProjectBinding(sessionId: string): Promise<LocalProject | null> {
  const session = await getSession(sessionId);
  if (!session?.projectId) return null;
  const project = await getProject(session.projectId);
  if (!project) throw new Error('The session project is unavailable');
  return project;
}

export async function hasRemoteProjects(): Promise<boolean> {
  return (await listProjects()).some(project => !!project.remote && !isSftpRemote(project.remote));
}

/** Presentation metadata only; changing it never revalidates or alters project workspace authority. */
export function setProjectColor(projectId: string, color: ProjectColor | null): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    z.string().uuid().parse(projectId);
    const normalized = z.enum(PROJECT_COLORS).nullable().parse(color);
    const projects = await listProjects();
    const project = projects.find(row => row.id === projectId);
    if (!project) throw new Error('Project not found');
    if (project.color === (normalized ?? undefined)) return project;
    const { color: _, ...withoutColor } = project;
    const updated: LocalProject = normalized ? { ...withoutColor, color: normalized } : withoutColor;
    await writeDurableNow('projects', projects.map(row => row.id === projectId ? updated : row));
    return updated;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}

/** Remove only the grouping. One catalog commit also covers unloaded sessions and
 * in-flight inputs without rewriting their durable workspace/receipt identities. */
export function removeProject(id: string): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    z.string().uuid().parse(id);
    const projects = await listProjects();
    const project = projects.find(row => row.id === id);
    if (!project) throw new Error('Project not found');
    const removed = { ...project, ungrouped: true };
    if (!project.ungrouped) await writeDurableNow('projects', projects.map(row => row.id === id ? removed : row));
    return removed;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}
export async function assignSessionProject(sessionId: string, projectId: string): Promise<void> {
  const project = await validateProject(projectId);
  await bindSessionProject(sessionId, project.id);
}
export async function projectWorkspace(projectId: string): Promise<{ virtual: string; real: string }> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  return resolveProject(project);
}
async function resolveProject(project: LocalProject): Promise<{ virtual: string; real: string }> {
  if (project.remote && !isSftpRemote(project.remote)) throw new Error('REMOTE_PROJECT: This directory is on the development server. It cannot be resolved on this computer.');
  if (project.remote && isSftpRemote(project.remote)) {
    // A server project is its root: the same folder, checked on the server (#1469).
    const identity = remoteIdentity(project.remote);
    const root = getConfig().roots.find(entry => entry.remote && remoteIdentity(entry.remote) === identity);
    if (!root) throw new Error('Project folder changed or is unavailable');
    try {
      const resolved = await resolvePath(getConfig().roots, `/${root.name}`, { remote: true });
      return { virtual: resolved.virtual, real: resolved.real };
    } catch (error) {
      throw new Error(`The project's server folder is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const resolved = await resolvePath(getConfig().roots, project.path);
  if (!samePath(resolved.real, project.path) || !(await fs.stat(resolved.real)).isDirectory()) throw new Error('Project folder changed or is unavailable');
  return { virtual: resolved.virtual, real: resolved.real };
}
/** The approved folder on a server (#1469) that holds this virtual path, if it is on one. */
export function serverRootOf(virtual: string): Root | undefined {
  const name = virtual.split('/').find(part => part.length > 0)?.toLowerCase();
  return getConfig().roots.find(root => root.remote !== undefined && root.name.toLowerCase() === name);
}

/**
 * A project's folder on this computer, for what reads only this computer's disk (its Skills). A
 * folder on a server has none: its chats list the Skills here, and the server's are not read in v1.
 */
export function localProjectPath(folder: { virtual: string; real: string } | null): string | null {
  return folder && !serverRootOf(folder.virtual) ? folder.real : null;
}

/** Null means no project. A broken explicit binding is an error, never permission to guess cwd. */
/** #1797: turns the secrets shield off (or back on) for one project's chats. On leaves no flag behind. */
export function setProjectSecretsShieldOff(projectId: string, off: boolean): Promise<LocalProject> {
  const operation = mutations.then(async () => {
    z.string().uuid().parse(projectId);
    z.boolean().parse(off);
    const projects = await listProjects();
    const project = projects.find(row => row.id === projectId);
    if (!project) throw new Error('Project not found');
    if ((project.secretsShieldOff === true) === off) return project;
    const { secretsShieldOff: _, ...without } = project;
    const updated: LocalProject = off ? { ...without, secretsShieldOff: true } : without;
    try {
      await writeDurableNow('projects', projects.map(row => row.id === projectId ? updated : row));
    } catch (error) {
      // The store retries a failed write later. A switch reported as failed must not land then,
      // so the unchanged list takes its place as the write to retry.
      await writeDurableNow('projects', projects).catch(() => undefined);
      throw error;
    }
    return updated;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}

/** #1797: whether this chat's project turned the secrets shield off. A chat without a project never has. */
export async function sessionSecretsShieldOff(sessionId: string): Promise<boolean> {
  const session = await getSession(sessionId);
  if (!session?.projectId) return false;
  return (await getProject(session.projectId))?.secretsShieldOff === true;
}

export async function getSessionProject(sessionId: string): Promise<{ virtual: string; real: string } | null> {
  const session = await getSession(sessionId);
  if (!session?.projectId) return null;
  const project = await getProject(session.projectId);
  if (!project) throw new Error('The session project is unavailable');
  return resolveProject(project);
}
/** The broker supplies an exact prime conversation; unrelated families are never consulted. */
export async function inheritSessionProject(sessionId: string, primeConversationId: string): Promise<void> {
  const prime = await findSessionByConversation(primeConversationId, { requireUnique: true });
  if (prime?.conversationId !== primeConversationId || !prime.projectId) return;
  await assignSessionProject(sessionId, prime.projectId);
}

/**
 * A chat the person started on chatgpt.com inside the native ChatGPT Project of a CoS project
 * (#1744) joins that project, as one started from the project's New chat does, so its commands
 * run in the project's folder rather than the first approved one. Only a chat with no project yet
 * that has not already worked in a folder, never a worker or helper (they follow their prime), and
 * only when exactly one listed project is linked to that ChatGPT Project.
 */
export async function bindChatToLinkedProject(sessionId: string, chatgptProjectId: string): Promise<'bound' | 'kept' | 'none' | 'ambiguous'> {
  if (!CHATGPT_PROJECT_ID.test(chatgptProjectId)) return 'none';
  const session = await getSession(sessionId);
  if (!session) return 'none';
  if (session.projectId || session.origin?.kind === 'worker' || session.origin?.kind === 'helper') return 'kept';
  if (workspaceForChat(session.conversationId ?? null)) return 'kept';
  const linked = (await listProjects()).filter(project =>
    !project.ungrouped && project.chatgpt?.state === 'linked' && project.chatgpt.id === chatgptProjectId);
  if (linked.length !== 1) {
    if (linked.length > 1) logInfo(`projects: chat ${sessionId} is in ChatGPT Project ${chatgptProjectId}, which ${linked.length} projects are linked to; it stays outside them`);
    return linked.length ? 'ambiguous' : 'none';
  }
  await assignSessionProject(sessionId, linked[0]!.id);
  logInfo(`projects: chat ${sessionId} was started in ChatGPT Project ${chatgptProjectId}, so it joins project ${linked[0]!.id}`);
  return 'bound';
}

/** A page may hold an unarmed claim this long before the request is offered to another. */
export const PROJECT_CREATE_CLAIM_MS = 60_000;
/** An armed creation whose id has not come back by then may or may not exist in ChatGPT. */
export const PROJECT_CREATE_ARMED_MS = 60_000;

const linkListeners = new Set<() => void>();
/** Hears every committed change of a project's native ChatGPT Project link. */
export function onProjectLinkChange(listener: () => void): () => void {
  linkListeners.add(listener);
  return () => linkListeners.delete(listener);
}

function updateChatgptLink(match: (link: ChatgptProjectLink, project: LocalProject) => boolean,
  next: (link: ChatgptProjectLink, now: number) => ChatgptProjectLink | null): Promise<LocalProject | null> {
  const operation = mutations.then(async () => {
    const projects = await listProjects();
    const project = projects.find(row => row.chatgpt && match(row.chatgpt, row));
    if (!project?.chatgpt) return null;
    const changed = next(project.chatgpt, Date.now());
    if (!changed) return null;
    const updated: LocalProject = { ...project, chatgpt: changed };
    await writeDurableNow('projects', projects.map(row => row.id === project.id ? updated : row));
    // Every step, so a Project that never appeared shows where it stopped (#1759); ids only, no names.
    // A page reports the error text: one line, no control characters, so it can never split or forge a line.
    // eslint-disable-next-line no-control-regex
    const why = 'error' in changed ? `: ${changed.error.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}` : '';
    logInfo(`projects: project ${project.id}'s ChatGPT Project went from ${project.chatgpt.state} to ${changed.state}${why}`);
    for (const listener of linkListeners) { try { listener(); } catch { /* presentation only */ } }
    return updated;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}
const forRequest = (id: string) => (link: ChatgptProjectLink) => 'requestId' in link && link.requestId === id;
const claimLapsed = (link: ChatgptProjectLink, now: number) => link.state === 'claimed' && now - link.updatedAt >= PROJECT_CREATE_CLAIM_MS;

/**
 * Native ChatGPT Projects still to create, for the browser to pick up.
 *
 * An armed creation that outlived its window turns `uncertain` here, never back into a request:
 * its click may have created a Project whose id was lost, and only the person may ask again.
 */
export async function pendingProjectCreates(): Promise<Array<{ id: string; projectId: string; name: string; state: 'requested' | 'claimed' | 'creating' }>> {
  await expireArmedProjectCreates();
  // In-progress ones are listed too, so the browser keeps the tab doing them; only `requested`
  // (or a claim that lapsed) is offered to a page again.
  return (await listProjects()).flatMap(project => {
    const link = project.chatgpt;
    if (project.ungrouped || !link || !['requested', 'claimed', 'creating'].includes(link.state)) return [];
    const state = link.state === 'claimed' && claimLapsed(link, Date.now()) ? 'requested' : link.state as 'requested' | 'claimed' | 'creating';
    return [{ id: (link as { requestId: string }).requestId, projectId: project.id, name: project.name, state }];
  });
}

let armedSweep: NodeJS.Timeout | null = null;
/**
 * Turns an armed creation that outlived its window `uncertain`, and keeps a timer for the next one.
 *
 * The app owns this clock: waiting for the browser's next status pass left a creation armed by a
 * page the app quit under `creating` with nothing on screen (measured 2026-10-10).
 */
export async function expireArmedProjectCreates(): Promise<void> {
  const now = Date.now();
  let next = Infinity;
  for (const project of await listProjects()) {
    const link = project.chatgpt;
    if (link?.state !== 'creating') continue;
    if (now - link.updatedAt >= PROJECT_CREATE_ARMED_MS) {
      // Only the very arm this pass saw: a newer one has its own window.
      await updateChatgptLink(forRequest(link.requestId), (current, at) => current.state === 'creating' && current.updatedAt === link.updatedAt
        ? { state: 'uncertain', requestId: current.requestId, error: 'ChatGPT did not show the new Project in time', updatedAt: at } : null);
    } else next = Math.min(next, link.updatedAt + PROJECT_CREATE_ARMED_MS);
  }
  if (armedSweep) clearTimeout(armedSweep);
  armedSweep = null;
  if (Number.isFinite(next)) {
    armedSweep = setTimeout(() => { armedSweep = null; void expireArmedProjectCreates().catch(() => undefined); }, Math.max(0, next - Date.now()) + 50);
    armedSweep.unref?.();
  }
}

/** One page takes the request before touching ChatGPT; nothing exists remotely yet. */
export async function claimProjectCreate(id: string, owner: string): Promise<boolean> {
  return !!await updateChatgptLink(forRequest(id), (link, now) =>
    link.state === 'requested' || (link.state === 'claimed' && (link.owner === owner || claimLapsed(link, now)))
      ? { state: 'claimed', requestId: id, owner, updatedAt: now } : null);
}

/** Written before the click that creates the Project: from here it may exist without our knowing its id. */
export async function armProjectCreate(id: string, owner: string): Promise<boolean> {
  const armed = !!await updateChatgptLink(forRequest(id), (link, now) =>
    link.state === 'claimed' && link.owner === owner && !claimLapsed(link, now)
      ? { state: 'creating', requestId: id, owner, updatedAt: now } : null);
  if (armed) await expireArmedProjectCreates();
  return armed;
}

/** The id ChatGPT showed on the new Project's own page, from the page that created it. */
export async function completeProjectCreate(id: string, owner: string, chatgptId: string): Promise<boolean> {
  if (!CHATGPT_PROJECT_ID.test(chatgptId)) return false;
  return !!await updateChatgptLink(forRequest(id), (link, now) =>
    link.state === 'creating' && link.owner === owner ? { state: 'linked', id: chatgptId, updatedAt: now } : null);
}

/** Before the click nothing was created and the request simply failed; after it, it is uncertain. */
export async function failProjectCreate(id: string, owner: string, error: string): Promise<boolean> {
  const why = error.slice(0, 500) || 'unknown error';
  return !!await updateChatgptLink(forRequest(id), (link, now) =>
    link.state === 'claimed' && link.owner === owner ? { state: 'failed', requestId: id, error: why, updatedAt: now }
      : link.state === 'creating' && link.owner === owner ? { state: 'uncertain', requestId: id, error: why, updatedAt: now } : null);
}

/** The person asks again after a failed or uncertain creation; uncertain may leave a second Project. */
export async function retryProjectCreate(projectId: string): Promise<LocalProject | null> {
  z.string().uuid().parse(projectId);
  return updateChatgptLink((_link, project) => project.id === projectId, (link, now) =>
    link.state === 'failed' || link.state === 'uncertain' ? { state: 'requested', requestId: randomUUID(), updatedAt: now } : null);
}

/**
 * ChatGPT no longer opens a linked Project: a new chat's tab for it landed on ChatGPT's home
 * (measured 2026-10-10: a deleted Project's page redirects there). The link becomes `failed`, so the
 * chat waiting for it says so and Retry creates a new Project; nothing is recreated on its own.
 */
export async function markProjectGone(projectId: string, chatgptId: string): Promise<boolean> {
  return !!await updateChatgptLink((link, project) => project.id === projectId && link.state === 'linked' && link.id === chatgptId,
    (_link, now) => ({ state: 'failed', requestId: randomUUID(), error: 'ChatGPT no longer opens this Project', updatedAt: now }));
}
