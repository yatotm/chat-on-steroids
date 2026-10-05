import { getRemoteHost, remoteEndpoint, validateHostDirectory } from './remote-hosts.js';
import { managedRemoteProjectSchema, type ManagedRemoteProject } from '../shared/remote-hosts.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rawPromises as fs } from './rawfs.js';
import { readDurable, writeDurableNow, writeDurableSoon } from './durable.js';
import { effectiveCapabilities, getConfig } from './config.js';
import { nativePathIdentity, resolvePath } from './sandbox.js';
import { bindSessionProject, findSessionByConversation, getSession } from './session/store.js';
import { PROJECT_COLORS, isManagedRemote, type LocalProject, type ProjectColor } from '../shared/projects.js';

import { probeRemoteWorkspace, remoteBindingSchema, validateRemoteProject } from './remote-workspace.js';
import { connectRemoteProjectSchema, isCoreRemote, type ConnectRemoteProject } from '../shared/remote-execution.js';
import { clearSecret, getSecret, setSecret } from './secrets.js';
import { logWarn } from './logger.js';

const projectSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(160), path: z.string().min(1).max(32768),
  color: z.enum(PROJECT_COLORS).optional(),
  remote: remoteBindingSchema.optional(),
  createdAt: z.number().finite().nonnegative(), ungrouped: z.boolean().optional()
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
    const project: LocalProject = { id: randomUUID(), name: (path.basename(resolved.real) || resolved.real).slice(0, 160), path: resolved.real, createdAt: Date.now() };
    await writeDurableNow('projects', [...projects, project]);
    return project;
  });
  mutations = operation.catch(() => undefined);
  return operation;
}

export async function addRemoteProject(request: ConnectRemoteProject): Promise<LocalProject> {
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
    const project: LocalProject = { id: replaced?.id ?? randomUUID(), name: replaced?.name ?? path.posix.basename(verified.root).slice(0, 160),
      path: verified.root, remote: { kind: 'core', url: input.url, serverId: verified.serverId, credentialId },
      ...(replaced?.color ? { color: replaced.color } : {}), createdAt: replaced?.createdAt ?? Date.now() };
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
      createdAt: Date.now(), remote: { kind: 'core', hostId: input.hostId } };
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
  if (project.remote) validateRemoteProject(project);
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
  return (await listProjects()).some(project => !!project.remote);
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
  if (project.remote) throw new Error('REMOTE_PROJECT: This directory is on the development server. It cannot be resolved on this computer.');
  const resolved = await resolvePath(getConfig().roots, project.path);
  if (!samePath(resolved.real, project.path) || !(await fs.stat(resolved.real)).isDirectory()) throw new Error('Project folder changed or is unavailable');
  return { virtual: resolved.virtual, real: resolved.real };
}
/** Null means no project. A broken explicit binding is an error, never permission to guess cwd. */
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
