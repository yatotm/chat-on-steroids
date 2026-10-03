import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { LocalProject, RemoteProjectBinding } from '../shared/projects.js';
import { getConfig } from './config.js';
import { pluginManager } from './plugins/manager.js';
import { readDurable, writeDurableNow } from './durable.js';

const workspaceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const remoteBindingSchema = z.object({
  pluginId: z.string().uuid(), workspaceId: workspaceIdSchema, endpointId: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const remotePathSchema = z.string().min(2).max(4096).refine(value =>
  value.startsWith('/') && !value.includes('\\') && !/[\x00-\x1f\x7f]/.test(value) &&
  !value.split('/').includes('..') && path.posix.normalize(value) === value,
  'Enter an absolute Linux project path, without .. or a trailing slash.');
const endpointId = (url: string) => createHash('sha256').update(url).digest('hex');

function remoteServer(pluginId: string, identity?: string) {
  const row = pluginManager.snapshot().plugins.find(plugin => plugin.id === pluginId);
  if (!row?.enabled || row.source.kind !== 'remote' || !row.source.url)
    throw new Error('Enable the remote CodexPro connection in Plugins.');
  if (identity && endpointId(row.source.url) !== identity)
    throw new Error('The remote server address changed. Add the remote project again.');
  if (pluginManager.toolOwner('open_workspace') !== pluginId)
    throw new Error('The remote CodexPro workspace tool is unavailable. Check Plugins for disabled or conflicting tools.');
  return { pluginId, sourceUrl: row.source.url };
}

function errorText(result: CallToolResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 1000);
}

export function validateRemoteProject(project: LocalProject): void {
  if (!project.remote) throw new Error('Choose a remote project.');
  remotePathSchema.parse(project.path);
  remoteServer(project.remote.pluginId, project.remote.endpointId);
}

export async function probeRemoteWorkspace(pluginId: string, root: string): Promise<{ path: string; remote: RemoteProjectBinding }> {
  z.string().uuid().parse(pluginId);
  remotePathSchema.parse(root);
  if (getConfig().readOnly) throw new Error('Turn off Read-only before connecting a remote project.');
  const expected = remoteServer(pluginId);
  const result = await pluginManager.call('open_workspace', { root, include_tree: false, include_skills: false }, undefined, expected);
  if (result.isError) throw new Error(errorText(result) || 'Could not open the remote workspace.');
  const parsed = z.object({ root: remotePathSchema, workspace_id: workspaceIdSchema }).parse(result.structuredContent);
  remoteServer(pluginId, endpointId(expected.sourceUrl));
  return { path: parsed.root, remote: { pluginId, workspaceId: parsed.workspace_id, endpointId: endpointId(expected.sourceUrl) } };
}

const PROCESS_ID = /^proc_[a-f0-9]{16}$/;
const processOwnerSchema = z.object({
  pluginId: z.string().uuid(), endpointId: z.string().regex(/^[a-f0-9]{64}$/), sessionId: z.string().min(1).max(128),
  processId: z.string().regex(PROCESS_ID), createdAt: z.number().finite().nonnegative()
});
const processOwnersSchema = z.array(processOwnerSchema).max(4096);
const PROCESS_OWNERS = 'remote-process-owners';
let processWrites: Promise<unknown> = Promise.resolve();
async function processOwners() {
  return processOwnersSchema.parse(await readDurable<unknown>(PROCESS_OWNERS) ?? []);
}
function rememberProcess(project: LocalProject, sessionId: string, processId: string): Promise<void> {
  const work = processWrites.then(async () => {
    const rows = await processOwners(), remote = project.remote!;
    const previous = rows.find(row => row.pluginId === remote.pluginId && row.endpointId === remote.endpointId && row.processId === processId);
    if (previous) {
      if (previous.sessionId !== sessionId) throw new Error('The remote process already belongs to another conversation.');
      return;
    }
    if (rows.length >= 4096) throw new Error('The remote process ownership limit was reached.');
    await writeDurableNow(PROCESS_OWNERS, [...rows, { pluginId: remote.pluginId, endpointId: remote.endpointId, sessionId, processId, createdAt: Date.now() }]);
  });
  processWrites = work.catch(() => undefined);
  return work;
}

/** 工作区及进程归属在发出调用前确定；断线不能授权自动重试。 */
export async function callRemoteProjectTool(project: LocalProject, sessionId: string, name: string, args: Record<string, unknown>,
  onOutcome?: (outcome: 'tool_rejected' | 'tool_execution_error') => void): Promise<CallToolResult> {
  validateRemoteProject(project);
  const remote = project.remote!, expected = remoteServer(remote.pluginId, remote.endpointId);
  const beforeDispatch = () => {
    if (getConfig().readOnly) throw new Error('TOOL_DISABLED: Remote tools are unavailable while CoS Read-only mode is on.');
    validateRemoteProject(project);
  };
  beforeDispatch();
  if (pluginManager.toolOwner(name) !== remote.pluginId)
    throw new Error('REMOTE_PROJECT_TOOL_MISMATCH: Use the CodexPro tools from this project’s remote connection.');
  if (name === 'codexpro' || name === 'open_current_workspace')
    throw new Error(`REMOTE_WORKSPACE_REQUIRED: Use explicit CodexPro tools with workspace_id=${remote.workspaceId}; open_workspace must use root=${project.path}.`);
  const bound = { ...args };
  if (name === 'open_workspace') {
    if ((args.root !== undefined && args.root !== project.path) || (args.path !== undefined && args.path !== project.path))
      throw new Error('REMOTE_WORKSPACE_MISMATCH: This conversation is bound to a different remote directory.');
    bound.root = project.path;
    delete bound.path;
  } else {
    const schema = pluginManager.tools().find(tool => tool.name === name)?.inputSchema;
    if (schema?.properties && 'workspace_id' in schema.properties) {
      if (args.workspace_id !== undefined && args.workspace_id !== remote.workspaceId)
        throw new Error('REMOTE_WORKSPACE_MISMATCH: Use this conversation’s remote workspace.');
      bound.workspace_id = remote.workspaceId;
    } else if (!['read_output', 'write_stdin', 'kill_command', 'server_config', 'list_workspaces'].includes(name)) {
      throw new Error('REMOTE_SCHEMA_UNSUPPORTED: This tool does not expose an explicit workspace_id. No remote operation was dispatched.');
    }
  }
  if (['read_output', 'write_stdin', 'kill_command'].includes(name)) {
    const owned = (await processOwners()).some(row => row.pluginId === remote.pluginId && row.endpointId === remote.endpointId &&
      row.sessionId === sessionId && row.processId === args.process_id);
    if (!owned) throw new Error('REMOTE_PROCESS_NOT_OWNED: This remote process does not belong to this conversation. Do not rerun its command to repair ownership.');
  }
  validateRemoteProject(project);
  if (name === 'exec_command' && (await processOwners()).length >= 4096)
    throw new Error('The remote process ownership limit was reached. No command was started.');
  const result = await pluginManager.call(name, bound, onOutcome, { ...expected, beforeDispatch });
  const reported = result.structuredContent as Record<string, unknown> | undefined;
  if (!result.isError && reported?.workspace_id !== undefined && reported.workspace_id !== remote.workspaceId) {
    onOutcome?.('tool_execution_error');
    return { ...result, isError: true, content: [...result.content, { type: 'text', text:
      'REMOTE_WORKSPACE_MISMATCH: The server reported a different workspace. Inspect the returned result before any further action; do not repeat this operation.' }] };
  }
  if (!result.isError && name === 'exec_command') {
    const processId = reported?.process_id;
    if (typeof processId === 'string' && PROCESS_ID.test(processId)) {
      try { await rememberProcess(project, sessionId, processId); }
      catch {
        onOutcome?.('tool_execution_error');
        return { ...result, isError: true, content: [...result.content, { type: 'text', text:
          'The remote command started, but its ownership could not be saved. Do not start it again. Check the returned process id on the development server.' }] };
      }
    } else {
      onOutcome?.('tool_execution_error');
      return { ...result, isError: true, content: [...result.content, { type: 'text', text:
        'The remote command may have started, but the server returned no valid process_id. Inspect the development server; do not repeat this command.' }] };
    }
  }
  return result;
}

export function remoteProjectInstructions(project: LocalProject): string {
  validateRemoteProject(project);
  return `This project runs on a remote Linux development server, not on the computer running the CoS app.\n` +
    `Remote directory: ${project.path}\nCodexPro workspace_id: ${project.remote!.workspaceId}\n` +
    `Use the explicit CodexPro tools on Chat On Steroids Plugins for files, searches, patches and commands. Always use this workspace_id. ` +
    `Start with open_workspace(root=${JSON.stringify(project.path)}, include_tree=false) and read the remote project's AGENTS.md before editing. ` +
    `Do not use Core read, find, view_image, apply_patch, exec_command or write_stdin for this project: they operate on the app computer and are refused. ` +
    `Do not use open_current_workspace or the codexpro wrapper. Core agents, update_plan and session_finish still manage this conversation. ` +
    `Use remote exec_command process_id with Plugins read_output/write_stdin/kill_command; Core terminal ids are different. ` +
    `If the remote connection fails, report it and inspect earlier results before retrying; never fall back to local execution.`;
}
