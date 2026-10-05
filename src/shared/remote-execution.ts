import { z } from 'zod';
import { CAPABILITIES } from './types.js';
import { MAX_COMMAND_ALLOWLIST_RULES, MAX_COMMAND_ALLOWLIST_RULE_CHARS } from './command-allowlist.js';

export const EXECUTION_PROTOCOL = 2;
export const CORE_EXECUTION_TOOLS = ['read', 'view_image', 'find', 'apply_patch', 'exec_command', 'write_stdin'] as const;
export type CoreExecutionTool = typeof CORE_EXECUTION_TOOLS[number];
export const isCoreExecutionTool = (name: string): name is CoreExecutionTool =>
  (CORE_EXECUTION_TOOLS as readonly string[]).includes(name);
export const EXECUTION_REQUEST_BYTES = 36 * 1024 * 1024;
export const EXECUTION_RESPONSE_BYTES = 20 * 1024 * 1024;
export const executionTokenSchema = z.string().trim().min(32).max(8192).regex(/^[\x21-\x7e]+$/);

export const executionUrlSchema = z.string().trim().min(1).max(2048).refine(value => {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash && !url.search &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}, 'Use an HTTPS execution service or an SSH-forwarded localhost URL.').transform(value => new URL(value).href);

export const remoteDirectorySchema = z.string().min(2).max(4096).refine(value =>
  value.startsWith('/') && !value.endsWith('/') && !value.includes('\\') &&
  !/[\x00-\x1f\x7f]/.test(value) && value.split('/').slice(1).every(part => part && part !== '.' && part !== '..'),
  'Enter an absolute Linux project path, without .. or a trailing slash.');

export const manualCoreRemoteBindingSchema = z.object({
  kind: z.literal('core'), url: executionUrlSchema, serverId: z.string().uuid(), credentialId: z.string().uuid()
}).strict();
export type ManualCoreRemoteBinding = z.infer<typeof manualCoreRemoteBindingSchema>;
export const managedCoreRemoteBindingSchema = z.object({ kind: z.literal('core'), hostId: z.string().uuid() }).strict();
export type ManagedCoreRemoteBinding = z.infer<typeof managedCoreRemoteBindingSchema>;
export const coreRemoteBindingSchema = z.union([manualCoreRemoteBindingSchema, managedCoreRemoteBindingSchema]);
export type CoreRemoteBinding = z.infer<typeof coreRemoteBindingSchema>;

// 旧绑定只为保留项目和历史而读取，不再赋予 CodexPro 执行权限。
export const legacyRemoteBindingSchema = z.object({
  pluginId: z.string().uuid(), workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  endpointId: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export const remoteBindingSchema = z.union([coreRemoteBindingSchema, legacyRemoteBindingSchema]);
export type RemoteBinding = z.infer<typeof remoteBindingSchema>;
export { isCoreRemote } from './projects.js';

export const connectRemoteProjectSchema = z.object({
  url: executionUrlSchema, token: executionTokenSchema, directory: remoteDirectorySchema,
  replace: z.object({ projectId: z.string().uuid(), path: remoteDirectorySchema, binding: remoteBindingSchema }).strict().optional()
}).strict();
export type ConnectRemoteProject = z.infer<typeof connectRemoteProjectSchema>;

export const executionWorkspaceSchema = z.object({
  protocol: z.literal(EXECUTION_PROTOCOL), serverId: z.string().uuid(), epoch: z.string().uuid(),
  root: remoteDirectorySchema, platform: z.enum(['linux', 'darwin'])
}).strict();
export type ExecutionWorkspace = z.infer<typeof executionWorkspaceSchema>;
export const executionServiceSchema = z.object({
  protocol: z.literal(EXECUTION_PROTOCOL), serverId: z.string().uuid(), epoch: z.string().uuid(),
  platform: z.enum(['linux', 'darwin']), roots: z.array(remoteDirectorySchema).min(1).max(64)
}).strict();
export type ExecutionService = z.infer<typeof executionServiceSchema>;

export const executionPolicySchema = z.object({
  caps: z.record(z.enum(CAPABILITIES), z.boolean()), readOnly: z.boolean(),
  commandPolicy: z.object({ enabled: z.boolean(), mode: z.enum(['allow', 'deny']),
    rules: z.array(z.string().max(MAX_COMMAND_ALLOWLIST_RULE_CHARS)).max(MAX_COMMAND_ALLOWLIST_RULES) }).strict()
}).strict();
export const executionScopeSchema = z.object({
  protocol: z.literal(EXECUTION_PROTOCOL), serverId: z.string().uuid(), epoch: z.string().uuid(),
  clientId: z.string().uuid(), projectId: z.string().uuid(), sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  directory: remoteDirectorySchema, roots: z.array(remoteDirectorySchema).min(1).max(64).optional(), policy: executionPolicySchema
}).strict();
export type ExecutionScope = z.infer<typeof executionScopeSchema>;

const HANDLE = /^cos:([a-f0-9-]{36}):([a-f0-9-]{36}):([0-9]{1,10}):([0-9]{1,16})$/;
export const remoteProcessHandleSchema = z.string().max(128).regex(HANDLE);
export function remoteProcessHandle(serverId: string, epoch: string, id: number, incarnation: number): string {
  return `cos:${serverId}:${epoch}:${id}:${incarnation}`;
}
export function parseRemoteProcessHandle(value: unknown): { serverId: string; epoch: string; id: number; incarnation: number } | null {
  if (typeof value !== 'string') return null;
  const match = HANDLE.exec(value);
  if (!match || !z.string().uuid().safeParse(match[1]).success || !z.string().uuid().safeParse(match[2]).success) return null;
  const id = Number(match[3]), incarnation = Number(match[4]);
  return Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647 && Number.isSafeInteger(incarnation) && incarnation > 0
    ? { serverId: match[1]!, epoch: match[2]!, id, incarnation } : null;
}

export const executionResultSchema = z.object({
  content: z.array(z.union([
    z.object({ type: z.literal('text'), text: z.string() }).strict(),
    z.object({ type: z.literal('image'), data: z.string(), mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']) }).strict()
  ])).max(256), structuredContent: z.record(z.string(), z.unknown()).optional(), isError: z.boolean().optional()
}).strict();

export const processCompletionSchema = z.object({
  exitCode: z.number().int().nullable(), completedAt: z.number().finite(), durationMs: z.number().finite(),
  benignExit: z.boolean().optional()
});

export const executionMetadataSchema = z.object({
  serverId: z.string().uuid(), epoch: z.string().uuid(), hasCompletion: z.boolean(),
  outcome: z.enum(['ok', 'process_exit_nonzero', 'tool_rejected', 'tool_execution_error', 'tool_internal_error']),
  evidence: z.object({
    changes: z.array(z.object({ path: z.string().max(32768), added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(), approximate: z.boolean() }).strict()).max(10000),
    reviews: z.array(z.object({ changeIndex: z.number().int().nonnegative(), before: z.string().max(4 * 1024 * 1024),
      after: z.string().max(4 * 1024 * 1024) }).strict()).max(10000),
    assets: z.array(z.never()).max(0), count: z.number().finite().nullable(), detail: z.string().max(16000).nullable(),
    exitCode: z.number().int().nullable(), benignExit: z.boolean().optional(), timedOut: z.boolean(),
    durationMs: z.number().finite().nullable(), running: z.boolean().nullable(),
    processSessionId: remoteProcessHandleSchema.nullable()
  }).strict()
}).strict();
