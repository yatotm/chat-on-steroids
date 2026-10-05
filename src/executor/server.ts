import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { CAPABILITIES, WRITE_CAPABILITIES, type Capabilities, type Root } from '../shared/types.js';
import { CORE_EXECUTION_TOOLS, EXECUTION_PROTOCOL, EXECUTION_REQUEST_BYTES, EXECUTION_RESPONSE_BYTES,
  executionScopeSchema, executionTokenSchema, remoteDirectorySchema, remoteProcessHandle, parseRemoteProcessHandle,
  type ExecutionScope } from '../shared/remote-execution.js';
import { registerExecutionTools, type ExecutionRegistrar, type CoreExecutionHost } from '../main/mcp/tools-execution.js';
import { toolSchemaJson } from '../main/mcp/tool-declarations.js';
import { fail } from '../main/mcp/execution-common.js';
import { emptyEvidence, noteOutcome, runInCallContext, type CallContext } from '../main/mcp/call-context.js';
import type { ToolResult } from '../main/mcp/kernel.js';
import { resolvePath, SandboxError } from '../main/sandbox.js';
import { UnifiedExecProcessManager } from '../main/codex/unified-exec.js';
import { DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS } from '../main/codex/unified-exec-constants.js';
import { createProcessCustody } from '../main/codex/process-custody.js';
import type { OutputPublication } from '../main/codex/unified-exec.js';
import { logWarn } from '../main/logger.js';
import { saveImageFile, ImageExportError, MAX_IMAGE_EXPORT_BYTES } from '../main/image-file.js';

interface ExecutorOptions {
  roots: string[];
  token: string;
  serverId: string;
  port?: number;
}
interface PublicationReceipt { principal: string; clientId: string; publication: OutputPublication }
const fullCapabilities = (): Capabilities => Object.fromEntries(CAPABILITIES.map(name => [name, !['screen', 'control', 'clipboardRead', 'clipboardWrite'].includes(name)])) as Capabilities;
const messageSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string().max(128), z.number().finite()]).optional(),
  method: z.string().max(80), params: z.record(z.string(), z.unknown()).optional()
}).strict();

/** 私有执行服务只持有真实文件、进程和输出；不创建聊天、队列、计划或 worker。 */
export async function startExecutionServer(options: ExecutorOptions) {
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('The execution service requires a POSIX host.');
  const serverId = z.string().uuid().parse(options.serverId);
  const token = executionTokenSchema.parse(options.token);
  if (!options.roots.length || options.roots.length > 64) throw new Error('Specify between 1 and 64 approved roots.');
  const approved: Root[] = [];
  for (const [index, root] of [...options.roots].entries()) {
    const real = await fs.realpath(remoteDirectorySchema.parse(root));
    if (!(await fs.stat(real)).isDirectory()) throw new Error('An approved root is not a directory.');
    approved.push({ name: `root${index}`, path: real });
  }
  const epoch = randomUUID();
  const unifiedExecManager = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);
  const handle = (id: number) => {
    const incarnation = unifiedExecManager.processIncarnation(id);
    if (incarnation === null) throw new SandboxError('This process instance is no longer retained.');
    return remoteProcessHandle(serverId, epoch, id, incarnation);
  };
  const custody = createProcessCustody(unifiedExecManager, () => null, handle);
  const receipts = new Map<string, PublicationReceipt>();
  const pendingRequests = new Map<Promise<void>, AbortController>();
  let active = 0, operations = 0, completionReads = 0, requestBytes = 0, stopping = false;
  let stopPromise: Promise<void> | null = null;

  const requireRunning = () => {
    if (stopping) throw new SandboxError('REMOTE_EXECUTOR_STOPPING: The service is shutting down. No new operation was dispatched.');
  };

  const workspace = async (directory: unknown) => {
    requireRunning();
    const requested = remoteDirectorySchema.parse(directory);
    const canonical = await fs.realpath(requested);
    if (!approved.some(root => canonical === root.path || canonical.startsWith(root.path + '/')))
      throw new SandboxError(`Remote directory "${requested}" is outside the service's approved directories: ${approved.map(root => root.path).join(', ')}`);
    const resolved = await resolvePath(approved, canonical);
    if (!(await fs.stat(resolved.real)).isDirectory()) throw new SandboxError('The remote project must be a directory.');
    requireRunning();
    return resolved.real;
  };
  const effectiveRoots = (roots: readonly string[]): string[] => {
    const intersection = new Set<string>();
    for (const root of roots) for (const allowed of approved) {
      if (root === allowed.path || root.startsWith(allowed.path + '/')) intersection.add(root);
      else if (allowed.path.startsWith(root + '/')) intersection.add(allowed.path);
    }
    return [...intersection].filter(root => ![...intersection].some(other => other !== root && root.startsWith(other + '/')));
  };
  const validateScope = async (meta: unknown) => {
    const scope = executionScopeSchema.parse(meta);
    if (scope.serverId !== serverId) throw new SandboxError('REMOTE_SERVER_MISMATCH: This is a different CoS execution service. No operation was dispatched.');
    if (scope.epoch !== epoch) throw new SandboxError('REMOTE_EXECUTOR_RESTARTED: The execution service restarted. Previous process handles cannot be reused. No operation was dispatched.');
    if (await workspace(scope.directory) !== scope.directory) throw new SandboxError('REMOTE_WORKSPACE_CHANGED: Reconnect this project before using it.');
    const roots = effectiveRoots(scope.roots ?? [scope.directory]);
    // 每个目录在实际使用时由同一 sandbox 检查；一个未使用的目录丢失不能使其他项目失效。
    if (!roots.some(root => scope.directory === root || scope.directory.startsWith(root + '/')))
      throw new SandboxError('The working directory is outside this connection\'s approved directories.');
    return { ...scope, roots };
  };
  const principalFor = (scope: ExecutionScope) => JSON.stringify([scope.projectId, scope.sessionId, scope.directory]);
  const processId = (scope: ExecutionScope, value: unknown) => {
    const parsed = parseRemoteProcessHandle(value);
    if (!parsed || parsed.serverId !== serverId || parsed.epoch !== epoch)
      throw new SandboxError('REMOTE_PROCESS_EXPIRED: This process handle belongs to another service or an earlier process lifetime. Do not rerun its command.');
    if (unifiedExecManager.processIncarnation(parsed.id) !== parsed.incarnation)
      throw new SandboxError('REMOTE_PROCESS_EXPIRED: This exact process instance is no longer retained. Do not rerun its command.');
    if (custody.execOwnershipFailure(parsed.id, principalFor(scope)))
      throw new SandboxError('REMOTE_PROCESS_NOT_OWNED: This process is unavailable to this project and session. No input was sent or output read.');
    return parsed.id;
  };
  const friendlyError = (error: unknown) => {
    if (error instanceof SandboxError || error instanceof ImageExportError) return error.message;
    if (error instanceof z.ZodError) return 'INVALID_ARGUMENTS: Invalid execution request.';
    const code = (error as NodeJS.ErrnoException)?.code;
    return typeof code === 'string' ? `Filesystem error (${code})` : 'The execution service could not complete this request.';
  };

  function register(scope: ExecutionScope, context: CallContext) {
    // 主目录只决定默认 cwd；其余明确授权目录保留稳定别名，增删列表不会把旧路径指向另一个目录。
    const roots = [{ name: 'project', path: scope.directory }, ...(scope.roots ?? [])
      .filter(root => root !== scope.directory)
      .map(root => ({ name: 'dir_' + createHash('sha256').update(root).digest('hex').slice(0, 12), path: root }))];
    const caps = { ...scope.policy.caps };
    for (const name of ['screen', 'control', 'clipboardRead', 'clipboardWrite'] as const) caps[name] = false;
    if (scope.policy.readOnly) for (const name of WRITE_CAPABILITIES) caps[name] = false;
    const guarded: CoreExecutionHost['guard'] = async (_name, run) => {
      try {
        requireRunning();
        const result = await run();
        noteOutcome(result.isError ? 'tool_rejected' : 'ok');
        return result;
      } catch (error) {
        const rejected = error instanceof SandboxError || error instanceof ImageExportError;
        if (!rejected) logWarn(`Execution handler failed: ${error instanceof Error ? error.stack ?? error.message : 'unknown error'}`);
        noteOutcome(rejected ? 'tool_rejected' : 'tool_internal_error');
        return fail(friendlyError(error));
      }
    };
    const resolveIn: CoreExecutionHost['resolveIn'] = async (_roots, requested, opts = {}) => {
      if (await workspace(scope.directory) !== scope.directory) throw new SandboxError('Remote workspace changed.');
      return resolvePath(roots, requested, { ...opts, base: opts.base === undefined ? '/project' : opts.base });
    };
    const entries = new Map<string, { schema: z.ZodType; declaration: object; run: (args: never) => Promise<ToolResult> }>();
    const reg: ExecutionRegistrar = {
      ctx: { roots, caps, readOnly: scope.policy.readOnly }, caps, exposedCaps: fullCapabilities(), findExposed: true,
      register(name, config, run) {
        entries.set(name, { schema: config.inputSchema, run: run as (args: never) => Promise<ToolResult>,
          declaration: { name, description: config.description, inputSchema: toolSchemaJson(config.inputSchema),
            ...(config.outputSchema ? { outputSchema: toolSchemaJson(config.outputSchema, 'output') } : {}),
            ...(config.annotations ? { annotations: config.annotations } : {}) } });
      },
      guarded(cap, name, run) {
        return guarded(name, () => caps[cap] ? run() : Promise.resolve(fail(`TOOL_DISABLED: ${name} is disabled by the current CoS permissions.`)));
      }
    };
    registerExecutionTools(reg, {
      custody, manager: unifiedExecManager, principal: () => principalFor(scope), commandPolicy: () => scope.policy.commandPolicy,
      workspace: () => ({ virtual: '/project', real: scope.directory }), requiresWorkspace: () => true,
      processHandle: handle, awaitIdentity: async () => {}, guard: guarded, failIdentity: fail, friendlyError, resolveIn,
      permissionRoots: () => scope.roots ?? [scope.directory],
      resolveCwd: async (_ctx, directory) => {
        const resolved = await resolveIn(roots, directory || '/project');
        if (!(await fs.stat(resolved.real)).isDirectory()) throw new SandboxError('workdir must be a folder');
        return { real: resolved.real, virtual: resolved.virtual, defaulted: !directory };
      }
    });
    const imageSchema = z.object({ path: z.string().min(1).max(4096),
      data: z.string().max(Math.ceil(MAX_IMAGE_EXPORT_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict();
    entries.set('cos_save_image', { schema: imageSchema,
      declaration: { name: 'cos_save_image', description: 'Save an original image supplied by the owning CoS Core.', inputSchema: toolSchemaJson(imageSchema) },
      run: input => reg.guarded('create', 'cos_save_image', async () => {
        const { path, data } = imageSchema.parse(input);
        const target = await resolveIn(roots, path, { allowMissing: true });
        const result = await saveImageFile(Buffer.from(data, 'base64'), target);
        return { content: [{ type: 'text', text: `Saved ${result.virtual}` }], structuredContent: { ...result } };
      }) });
    return { entries, context };
  }

  async function call(name: string, args: Record<string, unknown>, meta: unknown, signal: AbortSignal): Promise<unknown> {
    if (name === 'cos_info') {
      const input = z.object({ serverId: z.string().uuid().optional() }).strict().parse(args);
      if (input.serverId && input.serverId !== serverId) throw new SandboxError('REMOTE_SERVER_MISMATCH: This is a different execution service.');
      return { content: [], structuredContent: { protocol: EXECUTION_PROTOCOL, serverId, epoch, platform: process.platform, roots: approved.map(root => root.path) } };
    }
    if (name === 'cos_workspace') {
      const input = z.object({ directory: remoteDirectorySchema, serverId: z.string().uuid().optional(),
        create: z.boolean().optional(), roots: z.array(remoteDirectorySchema).min(1).max(64).optional() }).strict().parse(args);
      if (input.serverId !== undefined && input.serverId !== serverId) throw new SandboxError('REMOTE_SERVER_MISMATCH: Reconnect this project to its intended execution service.');
      if (input.create) {
        if (!input.serverId || !input.roots?.length) throw new SandboxError('Creating a directory requires the connected service and approved directories.');
        const roots = effectiveRoots(input.roots);
        const target = await resolvePath(roots.map((root, index) => ({ name: `approved${index}`, path: root })), input.directory, { allowMissing: true });
        requireRunning(); signal.throwIfAborted();
        await fs.mkdir(target.real, { recursive: true });
      }
      const root = await workspace(input.directory);
      if (input.roots && !input.roots.some(allowed => root === allowed || root.startsWith(allowed + '/')))
        throw new SandboxError(`The project is outside the approved remote directories: ${input.roots.join(', ')}`);
      return { content: [], structuredContent: { protocol: EXECUTION_PROTOCOL, serverId: serverId, epoch, root, platform: process.platform } };
    }
    const scope = await validateScope(meta);
    const principal = principalFor(scope);
    if (name === 'cos_completion') {
      const input = z.object({ session_id: z.string().max(128) }).strict().parse(args);
      const id = processId(scope, input.session_id);
      if (completionReads >= 64) throw new SandboxError('REMOTE_COMPLETION_BUSY: Too many process completion readers.');
      const completion = unifiedExecManager.completionFor(id, signal);
      if (!completion) throw new SandboxError('REMOTE_PROCESS_UNAVAILABLE: Inspect the original launch and results; do not repeat the command.');
      completionReads++;
      try { return { content: [], structuredContent: await completion }; }
      finally { completionReads--; }
    }
    if (name === 'cos_background') {
      const input = z.object({ phase: z.enum(['ack', 'offer']), acknowledged: z.array(z.string().uuid()).max(128).default([]),
        failed: z.array(z.string().uuid()).max(128).default([]), maxBytes: z.number().int().min(0).max(12000).default(12000),
        except: z.string().max(128).optional(), offerId: z.string().uuid().optional() }).strict().parse(args);
      if (input.phase === 'offer' && !input.offerId) throw new SandboxError('An output offer requires its sender-owned receipt ID.');
      for (const [id, held] of receipts) {
        const state = custody.backgroundExecObligations(held.principal);
        if ((!state.running.length && !state.exitedUnread.length) ||
            (held.principal === principal && held.clientId !== scope.clientId)) {
          held.publication.failed = true; receipts.delete(id);
        }
      }
      for (const id of [...input.acknowledged, ...input.failed]) {
        const held = receipts.get(id);
        if (!held || held.principal !== principal || held.clientId !== scope.clientId) continue;
        if (input.failed.includes(id)) held.publication.failed = true;
        else held.publication.completedAt = Date.now() - 1;
        receipts.delete(id);
      }
      const except = input.except ? processId(scope, input.except) : undefined;
      await custody.acknowledgeBackgroundExecOutput(principal, Date.now(), except);
      if (input.phase === 'ack' || receipts.size >= 512) return { content: [], structuredContent: { text: null, receiptId: null } };
      signal.throwIfAborted();
      if (receipts.has(input.offerId!)) throw new SandboxError('This output offer is already pending. Reconcile its receipt before offering another page.');
      const publication: OutputPublication = { completedAt: null, failed: false };
      const receipt = { principal, clientId: scope.clientId, publication };
      const cancelOffer = () => {
        publication.failed = true;
        if (receipts.get(input.offerId!) === receipt) receipts.delete(input.offerId!);
      };
      // 断线可能早于回执登记；同一个 HTTP 生命周期撤销输出占用，不依赖后续失败 ACK 的到达顺序。
      signal.addEventListener('abort', cancelOffer, { once: true });
      try {
        const output = await custody.offerBackgroundExecOutput(principal, publication, input.maxBytes);
        signal.throwIfAborted();
        const text = output ?? custody.backgroundExecRecoveryNotices(principal, publication).join('\n');
        const receiptId = text ? input.offerId! : null;
        if (receiptId) receipts.set(receiptId, receipt);
        else signal.removeEventListener('abort', cancelOffer);
        return { content: [], structuredContent: { text: text || null, receiptId } };
      } catch (error) {
        cancelOffer(); signal.removeEventListener('abort', cancelOffer); throw error;
      }
    }
    if (!(CORE_EXECUTION_TOOLS as readonly string[]).includes(name) && name !== 'cos_save_image') return fail('UNKNOWN_TOOL: This service only executes Core file and process tools.');
    if (operations >= 8) return fail('REMOTE_EXECUTOR_BUSY: Eight file or process calls are already running. No operation was dispatched.');
    operations++;
    const context: CallContext = { startedAt: Date.now(), transportKey: null, agent: null, allowUnattributed: false,
      caller: { transportKey: null, requestId: null, conversationId: null, sessionId: principal }, outcome: null, evidence: emptyEvidence() };
    try { return await runInCallContext(context, async () => {
      const { entries } = register(scope, context);
      const entry = entries.get(name)!;
      const bound = { ...args };
      if (name === 'write_stdin') {
        const id = processId(scope, args.session_id);
        if (typeof args.chars === 'string' && args.chars.length > 0) {
          const granted = unifiedExecManager.processPermissionRoots(id), current = scope.roots ?? [scope.directory];
          if (!granted || granted.some(root => !current.some(allowed => root === allowed || root.startsWith(allowed + '/'))))
            throw new SandboxError('REMOTE_PERMISSIONS_CHANGED: Directory access was reduced after this process started. No input was sent. Retained output can still be read.');
        }
        bound.session_id = id;
      }
      const parsed = await entry.schema.safeParseAsync(bound);
      const result = parsed.success ? await entry.run(parsed.data as never) : fail('INVALID_ARGUMENTS: Invalid Core tool arguments.');
      const { processCompletion: _completion, ...evidence } = context.evidence;
      // 历史补丁预览有独立上限；不截断真正的工具返回或伪造文件变化。
      let reviewBytes = 0;
      evidence.reviews = evidence.reviews.filter(review => {
        reviewBytes += Buffer.byteLength(review.before) + Buffer.byteLength(review.after);
        return reviewBytes <= 4 * 1024 * 1024;
      });
      if (evidence.reviews.length < context.evidence.reviews.length)
        evidence.detail = [evidence.detail, 'Some historical diff previews exceeded the remote preview limit.'].filter(Boolean).join(' ');
      return { ...result, _meta: { cosExecution: { serverId: serverId, epoch, evidence,
        outcome: context.outcome ?? (result.isError ? 'tool_rejected' : 'ok'), hasCompletion: !!_completion } } };
    }); } finally { operations--; }
  }

  const server = http.createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      if (res.destroyed) return;
      let body = JSON.stringify(value);
      if (Buffer.byteLength(body) > EXECUTION_RESPONSE_BYTES) {
        status = 500; body = JSON.stringify({ error: 'Remote result exceeded its transport bound. The operation may have completed; do not repeat it.' });
      }
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
      res.end(body);
    };
    if (stopping) return send(503, { error: 'executor_stopping' });
    if (req.headers.origin || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(req.headers.host ?? ''))
      return send(403, { error: 'forbidden_origin_or_host' });
    const supplied = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(401, { error: 'unauthorised' });
    if (req.url !== '/mcp' || req.method !== 'POST') return send(405, { error: 'Use POST /mcp.' });
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return send(415, { error: 'json_required' });
    if (active >= 80) return send(503, { error: 'executor_busy' });
    active++;
    const observation = new AbortController();
    let finishRequest!: () => void;
    const finished = new Promise<void>(resolve => { finishRequest = resolve; });
    pendingRequests.set(finished, observation);
    let workDone = false, responseDone = false, retired = false;
    const retire = () => {
      if (!workDone || !responseDone || retired) return;
      retired = true; active--; pendingRequests.delete(finished); finishRequest();
      res.off('finish', published); res.off('close', disconnected); res.off('error', disconnected);
    };
    const published = () => { responseDone = true; retire(); };
    const disconnected = () => { observation.abort(); responseDone = true; retire(); };
    res.once('finish', published);
    res.once('close', disconnected);
    res.once('error', disconnected);
    let id: string | number | null = null;
    let heldBytes = 0;
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const part of req) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        bytes += chunk.length;
        requestBytes += chunk.length; heldBytes += chunk.length;
        if (requestBytes > 64 * 1024 * 1024) return send(503, { error: 'executor_body_budget_full' });
        if (bytes > EXECUTION_REQUEST_BYTES) return send(413, { error: 'request_too_large' });
        chunks.push(chunk);
      }
      const message = messageSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      id = message.id ?? null;
      if (message.method === 'notifications/initialized' && message.id === undefined) { res.writeHead(202).end(); return; }
      if (message.id === undefined) return send(400, { error: 'request_id_required' });
      let result: unknown;
      if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} },
        serverInfo: { name: 'chat-on-steroids-executor', version: String(EXECUTION_PROTOCOL) } };
      else if (message.method === 'ping') result = {};
      else if (message.method === 'tools/list') {
        const root = approved[0]!.path;
        const context: CallContext = { startedAt: Date.now(), transportKey: null, agent: null,
          caller: { transportKey: null, requestId: null, conversationId: null }, outcome: null, evidence: emptyEvidence() };
        const { entries } = register({ protocol: EXECUTION_PROTOCOL, serverId: serverId, epoch, clientId: randomUUID(),
          projectId: randomUUID(), sessionId: 'discovery', directory: root,
          policy: { caps: fullCapabilities(), readOnly: false, commandPolicy: { enabled: false, mode: 'allow', rules: [] } } }, context);
        result = { tools: [...entries.values()].map(entry => entry.declaration).concat([
          { name: 'cos_info', description: 'Describe the connected CoS execution service.', inputSchema: { type: 'object', properties: { serverId: { type: 'string' } }, additionalProperties: false } },
          { name: 'cos_workspace', description: 'Validate a CoS execution workspace.', inputSchema: { type: 'object', properties: { directory: { type: 'string' }, serverId: { type: 'string' } }, required: ['directory'], additionalProperties: false } },
          { name: 'cos_completion', description: 'Read the owned process completion without consuming output.', inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'], additionalProperties: false } },
          { name: 'cos_background', description: 'Acknowledge or offer owned background output.', inputSchema: { type: 'object', properties: { phase: { type: 'string', enum: ['ack', 'offer'] } }, required: ['phase'] } }
        ]) };
      } else if (message.method === 'tools/call') {
        const params = z.object({ name: z.string().max(80), arguments: z.record(z.string(), z.unknown()).default({}),
          _meta: z.object({ cosExecution: z.unknown() }).optional() }).strict().parse(message.params);
        // 一次 HTTP 请求只分派一次；客户端不得自动重发结果不明的调用。
        result = await call(params.name, params.arguments, params._meta?.cosExecution, observation.signal).catch(error => fail(friendlyError(error)));
      } else return send(200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      send(200, { jsonrpc: '2.0', id, result });
    } catch (error) {
      send(200, { jsonrpc: '2.0', id, error: { code: -32600, message: friendlyError(error) } });
    } finally { requestBytes -= heldBytes; workDone = true; retire(); }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 18787, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Execution service did not bind.');
  return {
    port: address.port, serverId: serverId, epoch,
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopping = true;
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      for (const observation of pendingRequests.values()) observation.abort();
      const cleanup = unifiedExecManager.shutdown();
      let deadline: ReturnType<typeof setTimeout>;
      const drained = Promise.all([cleanup, ...pendingRequests.keys()]).then(async () => {
        receipts.clear(); server.closeAllConnections(); await closed;
      });
      stopPromise = Promise.race([drained, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Execution service shutdown did not finish within 15 seconds.')), 15000);
        deadline.unref();
      })]).finally(() => { clearTimeout(deadline); server.closeAllConnections(); });
      return stopPromise;
    }
  };
}
