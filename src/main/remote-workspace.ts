import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isManagedRemote, type LocalProject } from '../shared/projects.js';
import { remoteEndpoint, getRemoteHost, type RemoteEndpoint } from './remote-hosts.js';
import { insideRemoteRoot } from '../shared/remote-hosts.js';
import { EXECUTION_PROTOCOL, executionMetadataSchema, executionResultSchema, executionWorkspaceSchema,
  isCoreRemote, parseRemoteProcessHandle, processCompletionSchema, remoteBindingSchema, remoteDirectorySchema,
  type CoreExecutionTool, type CoreRemoteBinding, type ExecutionScope, type ExecutionWorkspace } from '../shared/remote-execution.js';
import { effectiveCapabilities, getConfig } from './config.js';
import { getSecret } from './secrets.js';
import { ExecutionTransportError, executionRpc } from './execution-client.js';
import { getProject, listProjects, sessionProjectBinding, remoteBindingFence } from './projects.js';
import { currentCall, noteOutcome, type CallContext } from './mcp/call-context.js';
import { fail } from './mcp/execution-common.js';
import type { ToolResult } from './mcp/kernel.js';
import type { OutputPublication } from './codex/unified-exec.js';

export { remoteBindingSchema };
const clientId = randomUUID();
interface Prepared { project: LocalProject; binding: CoreRemoteBinding; url: string; serverId: string; roots: string[]; token: string; workspace: ExecutionWorkspace; endpoint?: RemoteEndpoint }
interface Offered { projectId: string; sessionId: string; serverId: string; epoch: string; publication: OutputPublication; failed?: boolean }
const preparedCalls = new WeakMap<OutputPublication, Map<string, Promise<Prepared>>>();
const offered = new Map<string, Offered>();

export function validateRemoteProject(project: LocalProject): void {
  if (!project.remote) throw new Error('Choose a remote project.');
  remoteDirectorySchema.parse(project.path);
  remoteBindingSchema.parse(project.remote);
  if (!isCoreRemote(project.remote)) throw new Error('Reconnect this legacy remote project to the CoS execution service. CodexPro is no longer used for remote projects.');
}

function remoteFailure(result: Record<string, unknown>): void {
  if (result.isError !== true) return;
  const content = Array.isArray(result.content) ? result.content : [];
  const message = content.filter((part): part is { type: string; text: string } =>
    !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' &&
    typeof (part as { text?: unknown }).text === 'string').map(part => part.text).join('\n').slice(0, 1600);
  throw new Error(message || 'The CoS execution service rejected this request.');
}

export async function probeRemoteWorkspace(url: string, token: string, directory: string, serverId?: string): Promise<ExecutionWorkspace> {
  const response = await executionRpc(url, token, 'cos_workspace', { directory, ...(serverId ? { serverId } : {}) });
  remoteFailure(response);
  const workspace = executionWorkspaceSchema.parse(response.structuredContent);
  if (serverId && workspace.serverId !== serverId) throw new Error('The execution service identity changed. Reconnect the intended service.');
  return workspace;
}

async function unchanged(project: LocalProject, sessionId?: string): Promise<void> {
  const now = sessionId ? await sessionProjectBinding(sessionId) : await getProject(project.id);
  if (!now || now.id !== project.id || now.path !== project.path || JSON.stringify(now.remote) !== JSON.stringify(project.remote))
    throw new Error('The remote project binding changed. No operation was dispatched.');
}

async function prepare(project: LocalProject, context?: CallContext): Promise<Prepared> {
  validateRemoteProject(project);
  const binding = project.remote as CoreRemoteBinding;
  const perform = async (): Promise<Prepared> => {
    const endpoint = isManagedRemote(binding) ? await remoteEndpoint(binding.hostId) : undefined;
    const token = endpoint?.token ?? (!isManagedRemote(binding) ? await getSecret(`execution:${binding.credentialId}`) : null);
    if (!token) throw new Error('Reconnect this remote project to store its execution service token.');
    const url = endpoint?.url ?? (!isManagedRemote(binding) ? binding.url : '');
    const serverId = endpoint?.host.serverId ?? (!isManagedRemote(binding) ? binding.serverId : '');
    const roots = endpoint?.host.roots ?? [project.path];
    if (!insideRemoteRoot(roots, project.path)) throw new Error('This project is no longer inside the approved directories for this development server.');
    await unchanged(project, context?.caller.sessionId ?? undefined);
    endpoint?.assertCurrent();
    const workspace = await probeRemoteWorkspace(url, token, project.path, serverId);
    if (workspace.root !== project.path) throw new Error('The remote directory changed. Reconnect the project.');
    await unchanged(project, context?.caller.sessionId ?? undefined);
    endpoint?.assertCurrent();
    return { project, binding, token, url, serverId, roots, workspace, endpoint };
  };
  // 一个外层调用（包括 code-mode 子调用）共享只读握手，执行授权仍逐次检查。
  if (!context?.publication) return perform();
  let rows = preparedCalls.get(context.publication);
  if (!rows) { rows = new Map(); preparedCalls.set(context.publication, rows); }
  const key = `${project.id}:${isManagedRemote(binding) ? binding.hostId : binding.credentialId}`;
  let pending = rows.get(key);
  if (!pending) { pending = perform(); rows.set(key, pending); }
  return pending;
}

function scopeFor(prepared: Prepared, sessionId: string): ExecutionScope {
  const config = getConfig();
  return { protocol: EXECUTION_PROTOCOL, serverId: prepared.serverId, epoch: prepared.workspace.epoch,
    clientId, projectId: prepared.project.id, sessionId, directory: prepared.project.path, roots: prepared.roots,
    policy: { caps: effectiveCapabilities(config), readOnly: config.readOnly, commandPolicy: config.commandAllowlist } };
}

function requireExecutionPermission(name: CoreExecutionTool | 'cos_save_image', scope: ExecutionScope): void {
  const caps = scope.policy.caps;
  const allowed = name === 'read' ? caps.read || caps.browse || caps.metadata
    : name === 'view_image' ? caps.read : name === 'find' ? caps.search
    : name === 'cos_save_image' ? caps.create
    : name === 'apply_patch' ? caps.create || caps.edit || caps.move || caps.deleteFile : caps.command;
  if (!allowed) throw new Error(`TOOL_DISABLED: ${name} is disabled by the current CoS permissions. No remote operation was dispatched.`);
}

export async function callRemoteCore(project: LocalProject, sessionId: string, name: CoreExecutionTool | 'cos_save_image', args: unknown,
  beforeDispatch: () => Promise<void>): Promise<ToolResult> {
  let dispatched = false;
  try {
    const bindingUnchanged = remoteBindingFence(project.id);
    const context = currentCall();
    const prepared = await prepare(project, context ?? undefined);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Core tool arguments must be an object.');
    if (name === 'write_stdin') {
      const handle = parseRemoteProcessHandle((args as Record<string, unknown>).session_id);
      if (!handle || handle.serverId !== prepared.serverId || handle.epoch !== prepared.workspace.epoch)
        throw new Error('REMOTE_PROCESS_EXPIRED: Use the original process handle from this execution service. It cannot survive a service restart; do not repeat its command.');
    }
    await unchanged(project, sessionId);
    await beforeDispatch();
    bindingUnchanged();
    prepared.endpoint?.assertCurrent();
    const scope = scopeFor(prepared, sessionId);
    requireExecutionPermission(name, scope);
    dispatched = true;
    const response = await executionRpc(prepared.url, prepared.token, name, args as Record<string, unknown>, scope);
    const { _meta, ...payload } = response;
    const result = executionResultSchema.parse(payload);
    if (_meta && typeof _meta === 'object' && !Array.isArray(_meta)) {
      const metadata = executionMetadataSchema.parse((_meta as Record<string, unknown>).cosExecution);
      if (metadata.serverId !== scope.serverId || metadata.epoch !== scope.epoch)
        throw new Error('The execution response belongs to a different service lifetime. Check existing work; do not repeat the operation.');
      noteOutcome(metadata.outcome);
      if (context) {
        Object.assign(context.evidence, metadata.evidence);
        if (metadata.hasCompletion && metadata.evidence.processSessionId) {
          const promise = executionRpc(prepared.url, prepared.token, 'cos_completion',
            { session_id: metadata.evidence.processSessionId }, scope, { completion: true }).then(completed => {
            remoteFailure(completed);
            return processCompletionSchema.parse(completed.structuredContent);
          });
          // recorder 接管这条真实结束事件；这里的接收不消耗远程输出。
          void promise.catch(() => undefined);
          context.evidence.processCompletion = promise;
        }
      }
    } else if (!result.isError) throw new Error('The execution service omitted result ownership. Check existing work; do not repeat the operation.');
    return result;
  } catch (error) {
    noteOutcome(dispatched ? 'tool_execution_error' : 'tool_rejected');
    return fail(error instanceof Error ? error.message : 'Remote execution failed. The call was not retried.');
  }
}

export async function remoteBackground(context: CallContext, phase: 'ack' | 'offer', budget = 12000,
  except?: unknown, beforeDispatch?: () => Promise<void>): Promise<string | null> {
  const sessionId = context.caller.sessionId;
  if (!sessionId || !context.publication) return null;
  const project = await sessionProjectBinding(sessionId);
  if (!project?.remote || !isCoreRemote(project.remote)) return null;
  const bindingUnchanged = remoteBindingFence(project.id);
  const prepared = await prepare(project, context);
  const acknowledged: string[] = [], failed: string[] = [];
  for (const [id, row] of offered) {
    if (row.projectId !== project.id || row.sessionId !== sessionId) continue;
    if (row.serverId !== prepared.serverId || row.epoch !== prepared.workspace.epoch) { offered.delete(id); continue; }
    if (row.failed || row.publication.failed) failed.push(id);
    else if (row.publication.completedAt !== null && row.publication.completedAt <= context.startedAt) acknowledged.push(id);
  }
  await unchanged(project, sessionId);
  await beforeDispatch?.();
  bindingUnchanged();
  prepared.endpoint?.assertCurrent();
  const offerId = phase === 'offer' && offered.size < 512 ? randomUUID() : undefined;
  const receipt: Offered = { projectId: project.id, sessionId, serverId: prepared.serverId,
    epoch: prepared.workspace.epoch, publication: context.publication };
  // 发送之前持有 receipt ID，offer 的返回丢失也能明确撤销它并重新交付原输出。
  if (offerId) offered.set(offerId, receipt);
  try {
    const response = await executionRpc(prepared.url, prepared.token, 'cos_background', {
      phase: phase === 'offer' && !offerId ? 'ack' : phase, acknowledged, failed, maxBytes: budget,
      ...(offerId ? { offerId } : {}),
      ...(typeof except === 'string' && parseRemoteProcessHandle(except)?.epoch === prepared.workspace.epoch ? { except } : {})
    }, scopeFor(prepared, sessionId));
    remoteFailure(response);
    for (const id of [...acknowledged, ...failed]) offered.delete(id);
    const result = z.object({ text: z.string().max(16000).nullable(), receiptId: z.string().uuid().nullable() }).strict().parse(response.structuredContent);
    if (result.receiptId !== null && result.receiptId !== offerId) throw new Error('The remote output receipt did not match its request.');
    if (!result.receiptId && offerId) offered.delete(offerId);
    return result.text;
  } catch (error) { receipt.failed = true; throw error; }
}

export async function remoteProjectInstructions(project: LocalProject): Promise<string> {
  validateRemoteProject(project);
  const roots = project.remote && isManagedRemote(project.remote) ? (await getRemoteHost(project.remote.hostId)).roots : [project.path];
  const permissions = roots.map(root => '- ' + root).join('\n');
  return `Approved remote directories:\n${permissions.slice(0, 10000)}${permissions.length > 10000 ? '\n[Directory list shortened.]' : ''}\n` +
    `The primary directory is the default working directory, not the entire permission boundary.\n` +
    `This project executes on its connected CoS development server. Remote directory: ${project.path}\n` +
    `Use the normal Chat On Steroids Core read, view_image, find, apply_patch, exec_command and write_stdin tools. ` +
    `CoS routes project file and command operations to that server; use /project or its native directory as the working root. File paths and shell commands follow the server's POSIX environment. ` +
    `Read /project/AGENTS.md before editing. Remote process handles are opaque strings; pass each returned session_id unchanged to write_stdin. ` +
    `Explicit /skills and /user-skills paths are desktop-owned read-only resources in this remote context; read them separately from remote files and copy any needed scripts into an approved remote directory before running them. ` +
    `Core agents, update_plan and session_finish remain available. No CodexPro or Plugins connection is required. ` +
    `If the server connection fails, inspect existing results and report uncertainty; never repeat a possibly executed mutation automatically.`;
}

/** 健康检查验证真实远端目录；保存的项目记录本身不是可用性证明。 */
export async function checkRemoteProjectAccess(): Promise<{ configured: number; verified: number; detail: string }> {
  const projects = (await listProjects()).filter(project => !!project.remote);
  const unavailable = new Set<string>();
  let detail = '';
  for (const project of projects) {
    const binding = project.remote!;
    const identity = isManagedRemote(binding) ? binding.hostId : isCoreRemote(binding) ? binding.url : binding.pluginId;
    if (unavailable.has(identity)) continue;
    try { await prepare(project); return { configured: projects.length, verified: 1, detail: '' }; }
    catch (error) {
      if (error instanceof ExecutionTransportError) unavailable.add(identity);
      detail ||= error instanceof Error ? error.message : 'Remote verification failed.';
    }
  }
  return { configured: projects.length, verified: 0, detail };
}
