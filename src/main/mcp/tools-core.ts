import { rawPromises as fs } from '../rawfs.js';
import { formatBytes } from '../fsops.js';
import { exportImage, ImageExportError, type ImageExportResult } from '../image-export.js';
import { saveImageFile } from '../image-file.js';
import { connectorName } from '../../shared/connector-names.js';
import { unifiedExecManager } from '../codex/manager.js';
import { registerExecutionTools } from './tools-execution.js';
import { processCustody, executionPrincipal } from '../codex/ownership.js';
import { hasRemoteProjects, sessionProjectBinding } from '../projects.js';
import { callRemoteCore } from '../remote-workspace.js';
import { isCoreExecutionTool } from '../../shared/remote-execution.js';
import { toolDeclaration } from './tool-declarations.js';
import { registerPlanTool } from './plan-tool.js';
import { goalWorkerChat, imageExportCapable } from '../bridge.js';
import { announceSessionFinish, sessionFinishDeadline } from '../session/finish.js';
import { effectiveCapabilities, getConfig } from '../config.js';
/** Core 对外保持一个入口，文件执行与会话编排各有唯一宿主。 */
import { z } from 'zod';
import { logInfo, logWarn } from '../logger.js';
import { currentWorkspace } from '../workspace.js';
import { REASONING_EFFORTS } from '../../shared/session.js';

import { agentForCaller, agentFamiliesForCaller, reconcileAgentRequestOwners, noteAgentContextTokens, persistCriticalSwarmNow, PRIME_ID, requestWorkerBootstraps, requestWorkerRevivals, statusForCaller, stageFinishAgent, stageMessages, stagePrimeMessage, stageSpawn, swarmRunning, swarmStateForCaller, type Caller } from '../agents.js';
import { repairPrimeFromResumeShadow } from '../session/continuation.js';
import { currentCall, currentCaller, runInCallContext } from './call-context.js';
import { awaitFreshCallOrigin, recordAgentMessage } from '../session/recorder.js';
import { findSessionByConversation, readRecentEvents } from '../session/store.js';
import { awaitRequestCorrelation, requestCorrelation } from '../session/correlation.js';
import { assertRemoteCallerLive, adoptAgent, ok, fail, failIdentity, friendlyError, guard, IDENTITY_EVIDENCE_MS, PRIME_EVIDENCE_MS, SPAWN_EVIDENCE_MS, resolveCwd, resolveIn, type SurfaceRegistrar } from './kernel.js';

/** One stable owner for the running model turn, upgraded lazily when page proof arrives. */
function execPrincipal(): string | null {
  const caller = currentCaller();
  return executionPrincipal(
    caller.requestId,
    caller.sessionId ?? null,
    currentCall()?.allowUnattributed ?? getConfig().multiAgent.allowUnattributedCalls
  );
}

export function registerCoreTools(reg: SurfaceRegistrar): void {
  const { ctx, caps, exposedCaps } = reg;
  registerExecutionTools(reg, {
    custody: processCustody, manager: unifiedExecManager, principal: execPrincipal,
    commandPolicy: () => getConfig().commandAllowlist,
    workspace: currentWorkspace, requiresWorkspace: swarmRunning,
    guard, friendlyError, failIdentity, resolveCwd,
    resolveIn: (roots, path, options) => resolveIn(roots, path, /^\/(?:skills|user-skills)(?:\/|$)/.test(path)
      ? { ...options, base: null } : options),
    route: async (name, args, local) => {
      const context = currentCall();
      const sessionId = context?.caller.sessionId;
      if (!sessionId || !await hasRemoteProjects()) return local();
      const project = sessionId ? await sessionProjectBinding(sessionId) : null;
      if (!project?.remote || !sessionId || !context || !isCoreExecutionTool(name)) return local();
      // Skills 的显式虚拟命名空间属于 Mac；混合请求必须拆开，不能靠文件是否存在猜执行位置。
      const paths = name === 'read' && Array.isArray((args as { paths?: unknown }).paths) ? (args as { paths: string[] }).paths
        : name === 'view_image' ? [(args as { path: string }).path] : [];
      const desktopSkills = paths.filter(path => /^\/(?:skills|user-skills)(?:\/|$)/.test(path));
      if (desktopSkills.length === paths.length && paths.length > 0) return local();
      if (desktopSkills.length > 0) return fail('Read desktop Skills and remote project files in separate tool calls.');
      return guard(name, () => callRemoteCore(project, sessionId, name, args, () => assertRemoteCallerLive(context)));
    },
    awaitIdentity: async () => {
      const caller = currentCaller();
      if (caller.requestId) await awaitFreshCallOrigin('write_stdin', currentCall()?.startedAt ?? Date.now(),
        IDENTITY_EVIDENCE_MS, { exact: true, requestId: caller.requestId });
    }
  });
  // -------------------------------------------------------------- save_image
  //
  // The original of an image ChatGPT generated in this chat, saved into an approved folder (#889).
  // The chat's own page fetches it; see image-export.ts.
  if (exposedCaps.create) {
    reg.register(
      'save_image',
      toolDeclaration('save_image', () => ({
        description: 'Save the original file of an image ChatGPT generated in this chat (not a screenshot or preview) to a new file in an approved folder. ' +
          'Never replaces an existing file. The chat must be open in the browser with the image on its page.',
        inputSchema: z
          .object({
            path: z.string().describe('New file path in an approved folder, for example /workspace/images/logo.png. Without an extension the image\'s own (.png, .jpg or .webp) is added.'),
            image: z.string().optional().describe('Which image: the message id or file id ChatGPT gave it. Omit for the latest image generated in this chat.')
          })
          .strict()
      })),
      async ({ path, image }) =>
        guard('save_image', async () => {
          if (!caps.create) {
            return fail('TOOL_DISABLED: save_image is disabled by the current Chat On Steroids permissions. Ask the user to enable creating files in the app.');
          }
          const caller = currentCaller();
          const conversationId = caller.conversationId ??
            (caller.requestId ? (await awaitRequestCorrelation(caller.requestId, 20_000))?.conversationId ?? null : null);
          // Never guessed from recent activity: a wrong guess would save another chat's image.
          if (!conversationId) {
            // Name the Core that answered: with one ChatGPT account on several computers, ChatGPT
            // may send a chat's call to another computer's Core, which never sees that chat (#1097).
            return fail(`${connectorName('core', getConfig().connectorSuffix)} could not tell which chat this save_image call came from, ` +
              'so it does not know which image to save. If the chat belongs to another computer, call save_image of that ' +
              'computer\'s Chat On Steroids Core instead. Otherwise call save_image directly as its own tool call, not from ' +
              'inside a JavaScript or exec step, and try again.');
          }
          if (!imageExportCapable()) {
            return fail('save_image needs the Chat On Steroids browser extension to be connected and up to date, so the chat\'s page can hand over the image.');
          }
          const session = await findSessionByConversation(conversationId);
          const recorded = session ? await readRecentEvents(session.id, 400, { kinds: ['native_image'] }) : [];
          const images = recorded.filter((event): event is Extract<typeof event, { kind: 'native_image' }> =>
            event.kind === 'native_image' && event.providerStatus !== 'in_progress');
          const wanted = image?.trim();
          const chosen = wanted
            ? images.filter(event => event.messageId === wanted || event.providerAssetId === wanted).at(-1)
            : images.at(-1);
          if (!chosen) {
            return fail(wanted
              ? `save_image found no generated image "${wanted}" in this chat. Omit image to save the latest one.`
              : 'save_image found no image generated in this chat yet.');
          }
          const context = currentCall();
          const project = caller.sessionId ? await sessionProjectBinding(caller.sessionId) : null;
          const target = project?.remote ? null : await resolveIn(ctx.roots, path, { allowMissing: true });
          if (target) {
            try {
              await fs.lstat(target.real);
              return fail(`${target.virtual} already exists. save_image never replaces a file; choose another name.`);
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
          try {
            const saved = await exportImage({ conversationId, messageId: chosen.messageId, assetId: chosen.providerAssetId }, async bytes => {
              const write = async (): Promise<ImageExportResult> => {
                if (!effectiveCapabilities(getConfig()).create) throw new ImageExportError('Creating files was disabled before the image arrived.');
                if (project?.remote) {
                  if (!context || !caller.sessionId) throw new ImageExportError('The remote image needs an exact session identity.');
                  const result = await callRemoteCore(project, caller.sessionId, 'cos_save_image', { path, data: bytes.toString('base64') },
                    () => assertRemoteCallerLive(context));
                  if (result.isError) throw new ImageExportError(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
                  return z.object({ virtual: z.string(), format: z.string(), width: z.number(), height: z.number(), bytes: z.number() }).parse(result.structuredContent);
                }
                if (caller.sessionId) {
                  const latest = await sessionProjectBinding(caller.sessionId);
                  if (latest?.id !== project?.id || latest?.path !== project?.path || latest?.remote)
                    throw new ImageExportError('The project changed before the image arrived.');
                }
                const currentTarget = await resolveIn(getConfig().roots, path, { allowMissing: true });
                return saveImageFile(bytes, currentTarget);
              };
              return context ? runInCallContext(context, write) : write();
            });
            logInfo(`tool save_image ${saved.virtual} (${formatBytes(saved.bytes)})`);
            return ok(`Saved ${saved.virtual} (${saved.width}x${saved.height} ${saved.format.toUpperCase()}, ${formatBytes(saved.bytes)}), the original file ChatGPT generated.`);
          } catch (error) {
            if (error instanceof ImageExportError) return fail(`save_image did not save the image: ${error.message}`);
            throw error;
          }
        })
    );
  }

  // ------------------------------------------------------- plan and finish

  if (reg.sessionToolsExposed) {
    registerPlanTool(reg);
  }
  if (reg.ctx.exposedFinishTool ?? getConfig().ui.finishTool === true) {
    reg.register('session_finish', toolDeclaration('session_finish', () => ({
      description: 'Only when explicitly requested by a user prompt, with any model. Call near actual completion, after implementing the requested work. Receives queued instructions; complete and verify them before calling again. Do not use for progress updates or queue collection. While HELD with no work remaining, call to wait. Each call waits at most 25 seconds.',
      inputSchema: z.object({ summary: z.string().min(1).max(1000) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    })), async ({ summary }) => {
      if (!getConfig().ui.finishTool) return { content: [{ type: 'text' as const, text: 'RELEASED: The user disabled finish hold. You may write your final answer.' }] };
      const caller = currentCaller();
      if (!caller.sessionId || !caller.conversationId) return failIdentity('Exact session identity is required');
      if (goalWorkerChat(caller.conversationId)) return fail('Session finish hold is not applicable to workers or decision helpers. Workers report with agents action=finish; decision helpers answer normally.');
      const deadline = sessionFinishDeadline(currentCall()?.startedAt ?? Date.now());
      return guard('session_finish', async () => ({ content: [{ type: 'text', text: await announceSessionFinish(caller.sessionId!, summary, deadline) }] }));
    });
  }

  // ----------------------------------------------------------------- agents

  if (reg.agentToolsExposed) registerAgentsTool(reg);
}

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

/**
 * One tool, four actions, registered only while multi-agent mode is on. Fresh installs enable
 * it; existing configs keep their stored choice, so a user who has it off never sees this schema.
 *
 * Caller identity comes from transport/page evidence, never model arguments. When permitted,
 * an unresolved request can own a provisional prime family. The same broker later attaches it
 * to the real session's frontend, preserving every worker and any existing fleets. Workers
 * retain their app-proven conversation binding. run_id selects an owned family, not a role.
 *
 * Every result here also carries `structuredContent`. The text half is what the model should
 * act on and is kept to a sentence or two; ids, states and counts are machine state and belong
 * in a shape the caller can read without parsing English.
 */
/**
 * Re-measures how full each sleeping worker's chat is, before the prime may wake one.
 *
 * The context ceiling is what makes a stop final, and it is measured from the app's own
 * durable session for that conversation rather than from anything a model reported. The
 * broker keeps the figure in memory and in its snapshot, but a chat that grew while this app
 * was not running — or one whose snapshot predates the measurement entirely — would otherwise
 * be woken into a conversation with no room left in it. Reading it here, on the one call that
 * can wake a worker, is what makes the ceiling survive a crash rather than a restart quietly
 * handing back a worker the prime was already told was finished.
 */
async function measureSleepingWorkers(caller: Caller): Promise<void> {
  const state = swarmStateForCaller(caller);
  if (state.agents.length === 0) return;
  for (const info of state.agents) {
    if (info.role !== 'worker' || info.state !== 'sleeping' || !info.conversationId) continue;
    const summary = await findSessionByConversation(info.conversationId, { requireUnique: true }).catch(() => null);
    if (summary) noteAgentContextTokens(info.conversationId, summary.contextTokens);
  }
  // Measurement is usually telemetry, but crossing the worker ceiling revokes durable revival
  // authority and can terminalize a parked worker. `status` also calls this helper, so there is
  // no later message/spawn acceptance barrier we can rely on: make every critical revision seen
  // through the end of measurement durable before publishing the resulting state to the model.
  try {
    if (!(await persistCriticalSwarmNow())) {
      throw new Error('the broker has no immediate durable persistence sink');
    }
  } catch (error) {
    throw new Error(
      `Worker context/revival state could not cross its durable barrier. Retry the agents call. (${error instanceof Error ? error.message : String(error)})`
    );
  }
}

/** Publish a staged broker mutation only after its exact revision is durable. */
async function acceptAgentMutation(
  staged: { commit(): void | boolean; rollback(): void },
  failure: string,
  commitFailure: string = failure
): Promise<void> {
  try {
    let durable: boolean;
    try {
      durable = await persistCriticalSwarmNow();
    } catch (error) {
      throw new Error(`${failure} (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!durable) throw new Error(failure);
    if (staged.commit() === false) throw new Error(commitFailure);
  } catch (error) {
    staged.rollback();
    throw error;
  }
}

function registerAgentsTool(reg: SurfaceRegistrar): void {
  reg.register(
    'agents',
    toolDeclaration('agents', () => ({
      title: 'Multi-agent run',
      description:
        'Run ChatGPT workers. Omit model and reasoning_effort unless the user explicitly requests an override; saved app defaults apply. Do not ask the user to choose them. Reuse a suitable sleeping worker with message before spawn. ' +
        'message: prime↔worker. Reports ride tool results, never restart primes. Use status once to collect pending reports before finalizing; otherwise state that review is pending. Never poll repeatedly. ' +
        'status: your active, sleeping/revivable and terminal workers, including parked families. finish: record the report, then normally sleep.',
      inputSchema: z.object({
        action: z.enum(['spawn', 'message', 'status', 'finish']).describe('What to do.'),
        run_id: z.string().uuid().optional().describe('Select your returned worker family when status lists several; never grants another caller’s workers.'),
        context: z
          .string()
          .max(4000)
          .optional()
          .describe(
            'spawn: shared instructions prepended to every task, e.g. repo, conventions, edit limits and validation.'
          ),
        workers: z
          .array(
            z.object({
              label: z.string().max(60).optional().describe('Short name shown to the user, e.g. "Security".'),
              task: z
                .string()
                .min(1)
                .max(4000)
                .describe(
                  'This worker\'s job: objective, relevant files, constraints and expected handoff.'
                ),
              model: z
                .string()
                .max(80)
                .optional()
                .describe(
                  'Omit unless explicitly requested by the user; app settings supply defaults. Use an exact account-observed model id or provider alias. Invalid overrides return observed ids before opening; the browser confirms availability before Send.'
                ),
              reasoning_effort: z
                .enum(REASONING_EFFORTS)
                .optional()
                .describe(
                  'Omit unless explicitly requested by the user; app settings supply defaults. Do not ask just to spawn a worker. This selects reasoning only, never a model.'
                )
            }).strict()
          )
          .min(1)
          .max(8)
          .optional()
          .describe(
            'spawn: fresh workers to create only after checking status for a suitable sleeping worker; revive one explicitly with message.'
          ),
        messages: z
          .array(
            z.object({
              to: z.string().min(1).max(40).describe('Recipient.'),
              text: z.string().min(1).max(4000).describe('What to say.')
            }).strict()
          )
          .min(1)
          .max(16)
          .optional()
          .describe(
            'message: atomic batch; prefer this to one call per recipient.'
          ),
        to: z
          .string()
          .min(1)
          .max(40)
          .optional()
          .describe('message: one recipient; messaging a sleeping worker wakes it.'),
        target_run_id: z
          .string()
          .min(1)
          .max(36)
          .optional()
          .describe('message: existing prime run id; prime-only, no worker/status access.'),
        text: z.string().min(1).max(4000).optional().describe('message: what to say.'),
        result: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe(
            'finish: factual handoff under RESULT / CHANGES / VALIDATION / BLOCKERS.'
          )
      })
      .superRefine((input, ctx) => {
        const reject = (field: 'context' | 'workers' | 'messages' | 'to' | 'target_run_id' | 'text' | 'result', message: string): void => {
          if (input[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], message });
        };
        if (input.action !== 'spawn') {
          reject('context', 'context is only valid with action=spawn');
          reject('workers', 'workers is only valid with action=spawn');
        }
        if (input.action !== 'message') {
          reject('messages', 'messages is only valid with action=message');
          reject('to', 'to is only valid with action=message');
          reject('target_run_id', 'target_run_id is only valid with action=message');
          reject('text', 'text is only valid with action=message');
        }
        if (input.action !== 'finish') reject('result', 'result is only valid with action=finish');
      })
      .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    })),
    async (input) => {
      // One clock for one MCP call. The dispatcher owns startedAt and the recorder later uses
      // that exact value to consume any page request reserved while proving caller identity.
      // Taking a second Date.now() here made callerNow reserve evidence under one timestamp
      // and recordToolCall look for it under another, leaving the first request permanently
      // reserved until TTL and breaking the very next worker control call.
      const startedAt = currentCall()?.startedAt ?? Date.now();
      return guard('agents', async () => {
        if (!reg.agentToolsLive) return reg.featureDisabled('Multi-agent mode', 'Multi-agent mode (experimental)');

        if (input.action === 'spawn') {
          if (!input.workers) return fail('agents action=spawn requires workers.');
          // Reserve under exact chat proof or the permitted transport request, atomically.
          // The request remains the reachable prime before browser attachment; later proof
          // changes its frontend projection without recreating workers or replaying spawn.
          const staged = stageSpawn({
            workers: input.workers,
            context: input.context ?? null,
            caller: await callerNow(startedAt, { exact: true, runId: input.run_id })
          });
          await acceptAgentMutation(staged,
            'The worker run could not cross its durable acceptance barrier. The spawn was rolled back; retry this same request.');
          const { created, becamePrime, runId, defaultNotes } = staged;
          if (currentCall()) currentCall()!.caller.runId = runId;
          // Browser tabs are a publication side effect, never part of planning. They become
          // visible only after the exact broker revision above is durable.
          requestWorkerBootstraps(created.map((worker) => worker.id), runId);
          await adoptAgent(PRIME_ID);
          const invited = created.filter((worker) => worker.state === 'invited');
          const sleeping = created.filter((worker) => worker.state === 'sleeping' && worker.revivable);
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  (becamePrime ? `This ${currentCaller().conversationId ? 'conversation' : 'request'} is now the prime agent of run ${runId}. ` : '') +
                  `${created.length} worker(s) matched: ${created.map((info) => `${info.id} (${info.label}, ${info.state}${info.model ? `, model ${info.model}` : ''}${info.reasoningEffort ? `, reasoning ${info.reasoningEffort}` : ''})`).join(', ')}. ` +
                  (invited.length > 0 ? 'New worker chats are opening with their briefs already in them. ' : '') +
                  (defaultNotes?.length ? `${defaultNotes.join(' ')} ` : '') +
                  (sleeping.length > 0
                    ? `${sleeping.map((worker) => worker.id).join(', ')} already finished that earlier piece and is sleeping in its existing chat; wake it with action=message instead of spawning a duplicate. `
                    : '') +
                  'Carry on with your own work — results and ' +
                  'messages arrive at the end of later tool results, so there is nothing to wait for and never anything ' +
                  'to poll. A short correction with action=message while a worker is still going is far cheaper than ' +
                  'the alternative.'
              }
            ],
            structuredContent: {
              action: 'spawn',
              run_id: runId,
              self: PRIME_ID,
              became_prime: becamePrime,
              workers: created.map((info) => ({ id: info.id, label: info.label, state: info.state, model: info.model, reasoning_effort: info.reasoningEffort }))
            }
          };
        }

        if (input.action === 'message') {
          if (input.target_run_id) {
            if (input.messages?.length) {
              return fail('agents action=message with target_run_id takes one text message, not messages[].');
            }
            if (input.to && input.to !== PRIME_ID) {
              return fail('agents action=message with target_run_id can address only the destination prime.');
            }
            if (!input.text) {
              return fail('agents action=message with target_run_id requires text.');
            }
            const caller = await callerNow(startedAt, { runId: input.run_id, member: true });
            const staged = stagePrimeMessage(caller, input.target_run_id, input.text);
            await acceptAgentMutation(staged,
              'The prime message could not cross its durable acceptance barrier. Nothing was queued; retry the same message request.',
              'TARGET_RUN_UNAVAILABLE: the destination prime family changed before acceptance. Nothing was queued.');
            if (currentCall()) currentCall()!.caller.runId = staged.sourceRunId;
            await recordAgentMessage(staged.message, 'sent', caller.conversationId);
            return {
              content: [{
                type: 'text' as const,
                text:
                  `Queued for prime family ${staged.targetRunId}. The recipient can reply with target_run_id=${staged.sourceRunId}.`
              }],
              structuredContent: {
                action: 'message',
                run_id: staged.sourceRunId,
                target_run_id: staged.targetRunId,
                queued: [{ to: PRIME_ID }]
              }
            };
          }

          // Two spellings of one operation. A single message is the common case and stays a
          // pair of scalars; `messages` is the same thing in bulk. Both in one call is a
          // request whose intended order nobody can read, so it is refused rather than
          // guessed at.
          const batch = input.messages ?? [];
          const single = input.to && input.text ? [{ to: input.to, text: input.text }] : [];
          if (batch.length > 0 && single.length > 0) {
            return fail('agents action=message takes either to+text or messages, not both.');
          }
          const items = batch.length > 0 ? batch : single;
          if (items.length === 0) return fail('agents action=message requires to and text, or a messages array.');
          // Before any slot is reserved: a sleeping worker whose chat has since crossed the
          // context ceiling is not revivable, and this is the call that would otherwise wake it.
          const caller = await callerNow(startedAt, { runId: input.run_id, member: true });
          await measureSleepingWorkers(caller);
          // One call, one identity resolution, one all-or-nothing delivery: a prime
          // redirecting its whole run cannot end up with two of its three messages sent.
          const staged = stageMessages(caller, items);
          await acceptAgentMutation(staged,
            'The agent message could not cross its durable acceptance barrier. Nothing was queued; retry the same message request.');
          const sent = staged.messages;
          const woken = staged.waking;
          // Reopening a sleeping worker's chat is a browser side effect, so it happens only
          // after the broker revision that reserved its slot is durable — exactly as a spawn's
          // tabs do. Nothing has been typed into that chat yet at this point.
          const runId = staged.runId;
          if (currentCall()) currentCall()!.caller.runId = runId;
          if (woken.length > 0 && runId) requestWorkerRevivals(woken, runId);
          for (const message of sent) await recordAgentMessage(message, 'sent', caller.conversationId);
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Queued for ${[...new Set(sent.map((message) => message.to))].join(', ')}.` +
                  (woken.length > 0
                    ? ` Waking ${woken.join(', ')} in ${woken.length === 1 ? 'the same chat' : 'their existing chats'}.`
                    : '')
              }
            ],
            structuredContent: {
              action: 'message',
              run_id: runId,
              queued: sent.map((message) => ({ to: message.to })),
              waking: woken
            }
          };
        }

        if (input.action === 'finish') {
          if (!input.result) {
            return fail(
              'agents action=finish requires result: the report the prime reads in your place — what you changed, what you verified and what is left. Send it as result and call finish again.'
            );
          }
          const staged = stageFinishAgent(await callerNow(startedAt, { runId: input.run_id, member: true }), input.result);
          if (!staged.repeat) {
            await acceptAgentMutation(staged,
              'The worker finish could not cross its durable acceptance barrier. Nothing was published; retry the same finish result.');
          }
          const { info, report, repeat } = staged;
          if (report) await recordAgentMessage(report, 'sent', info.conversationId);
          // A retry is answered as a retry. Repeating "marked finished" would read as a
          // second finish and invite the model to keep going until it gets a different
          // answer, which is how one lost result became a queue of identical reports.
          return {
            content: [
              {
                type: 'text' as const,
                text: repeat
                  ? `${info.id} was already ${info.state}; the previous result was already recorded for the prime, so nothing was ` +
                    'queued again. This acknowledgment does not confirm delivery to the prime. Stop working and stop calling tools.'
                  : info.state === 'finished'
                    ? `${info.id} is finished. Your result was recorded for the prime. This acknowledgment does not confirm delivery to the prime. This chat has also reached its context ` +
                      'limit, so there will be no more work in it: stop working and stop calling tools.'
                    : `${info.id} reported and is now asleep but remains reusable. Your result was recorded for the prime. ` +
                      'This acknowledgment does not confirm delivery to the prime. Your worker slot is free. Stop working and stop calling tools; for related follow-up work the ' +
                      'prime should wake this same chat with agents action=message before spawning a replacement.'
              }
            ],
            structuredContent: { action: 'finish', self: info.id, state: info.state, repeat }
          };
        }

        // Status describes only this exact caller's family. No family is a normal empty
        // result, independent of whether another prime has workers; discovery grants no role.
        const caller = await callerNow(startedAt, { runId: input.run_id });
        await measureSleepingWorkers(caller);
        const status = statusForCaller(caller);
        const me = status.self;
        const state = status.state;
        const families = agentFamiliesForCaller(caller);
        const familyNotice = families.length > 1
          ? `\n\nYour worker families: ${families.map(family => `${family.run_id} (${family.running ? 'active' : 'retained'})`).join(', ')}. Use run_id to select a family; worker names are local to that family.`
          : '';
        if (!me) return {
          content: [{ type: 'text' as const, text: families.length
            ? `Select one of your worker families with run_id.${familyNotice}`
            : 'No workers or retained worker history belong to this caller. Use agents action=spawn if the task needs workers.' }],
          structuredContent: { action: 'status', run_id: null, self: null, agents: [], free_worker_slots: status.freeWorkerSlots,
            ...(families.length > 1 ? { available_runs: families } : {}) }
        };
        const failed = state.agents.filter((info) => info.state === 'failed');
        // The word the model reads here is the whole answer to "may I use this worker again".
        // A sleeping worker is not a spent one, and calling it finished in this table is what
        // sends a prime off to spawn a fourth chat for work its first worker already knows the
        // background to.
        const shown = (info: { state: string; revivable: boolean }): string =>
          info.state === 'sleeping'
            ? info.revivable
              ? 'sleeping (reusable; wake with action=message)'
              : 'sleeping'
            : info.state === 'waking'
              ? 'waking (your message is being delivered to its chat)'
              : info.state === 'finished'
                ? 'finished (not reusable)'
              : info.state;
        const asleep = state.agents.filter((info) => info.state === 'sleeping' && info.revivable);
        const slots = status.freeWorkerSlots;
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `You are ${me.id}.\n` +
                state.agents
                  .map(
                    (info) =>
                      `${info.id}  ${info.role}  ${shown(info)}  waiting ${info.pending}  ${info.label}` +
                      (info.model ? `  model ${info.model}` : '') +
                      (info.reasoningEffort ? `  reasoning ${info.reasoningEffort}` : '') +
                      (info.result
                        ? `\n    ${info.state === 'failed' ? 'failure' : info.state === 'finished' ? 'result' : 'latest result'}: ${info.result.slice(0, 300)}`
                        : '')
                  )
                  .join('\n') +
                (me.id === PRIME_ID
                  ? `\n\n${slots} of your worker slots ${slots === 1 ? 'is' : 'are'} free.` +
                    (asleep.length > 0
                      ? ` REUSE FIRST: ${asleep.map((info) => info.id).join(', ')} ${asleep.length === 1 ? 'is' : 'are'} asleep and ` +
                        'can be woken with agents action=message, in the chat they already have and with everything ' +
                        'they learned there still in it. For related follow-up work, do this before action=spawn' +
                        (slots === 0 ? ', once a slot frees up.' : '.')
                      : '')
                  : '') +
                // Said in words as well as in the table: a failed worker will not report, and
                // waiting for it is the mistake this line prevents.
                (failed.length > 0
                  ? `\n\n${failed.map((info) => info.id).join(', ')} will not report. Do that work yourself or wake ` +
                    'another worker; do not wait for them.'
                  : '') +
                // A status check is a glance, not a stopping point. Without this the table reads
                // like an answer to hand back to the user, and a prime that has just looked at its
                // workers stops mid-run to report what it saw.
                familyNotice + '\n\nThis is the current stats, keep working.'
            }
          ],
          structuredContent: {
            action: 'status',
            run_id: status.runId,
            self: me.id,
            free_worker_slots: slots,
            ...(families.length > 1 ? { available_runs: families } : {}),
            agents: state.agents.map((info) => ({
              id: info.id,
              role: info.role,
              label: info.label,
              model: info.model,
              reasoning_effort: info.reasoningEffort,
              state: info.state,
              revivable: info.revivable,
              waiting: info.pending,
              result: info.result ?? null
            }))
          }
        };
      });
    }
  );
}

/**
 * Who is making this `agents` call, established for this call alone.
 *
 * The prime holds no credential by design, and the dispatcher deliberately hands ordinary
 * tool calls no authority from "the only chat that has been active lately" — that is not
 * proof that the chat made this call, and stale page state once authenticated prime calls as
 * worker-1. So identity is proven here per call by joining ChatGPT's inbound MCP HTTP
 * `x-request-id` to the same request id reported from one concrete conversation's message
 * model. The page evidence may arrive just before or just after the MCP request; the id, not
 * timing, is the join. If its exact mate never appears, the broker refuses the operation.
 * Missing request-id evidence never falls back to a visible row, active/generating chat,
 * agent key, or recent browser state.
 *
 * The proven identity is then adopted for the rest of the call, so this result is recorded
 * against the right agent and carries the right inbox.
 */
async function callerNow(startedAt: number, options: { exact?: boolean; runId?: string; member?: boolean } = {}): Promise<Caller> {
  const base = currentCaller();
  // `exact` marks the one action that binds a run: spawn. It is the call whose refusal the
  // model cannot absorb, so it gets the longer ceiling; every other `agents` action can be
  // declined and asked again on the next tool call.
  const window = base.requestId ? (options.exact ? SPAWN_EVIDENCE_MS : IDENTITY_EVIDENCE_MS) : PRIME_EVIDENCE_MS;
  const allowRequest = Boolean(base.requestId && (currentCall()?.allowUnattributed ?? getConfig().multiAgent.allowUnattributedCalls));
  const requestOwnsTarget = !options.member || agentFamiliesForCaller(base).length > 0;
  const resolved =
    base.conversationId ??
    requestCorrelation(base.requestId)?.conversationId ??
    (allowRequest && requestOwnsTarget ? null : await awaitFreshCallOrigin('agents', startedAt, window, {
      ...options,
      // ChatGPT's own id for this request, when it sent one. It names the conversation
      // outright, so two workers calling at the same moment are no longer a hard case.
      requestId: base.requestId
    }));
  const caller: Caller = {
    ...base,
    conversationId: resolved,
    runId: options.runId
  };
  const call = currentCall();
  if (call) call.caller.runId = options.runId;
  if (resolved) {
    const call = currentCall();
    if (call) call.caller.conversationId = resolved;
    const proof = requestCorrelation(base.requestId);
    if (proof?.conversationId === resolved) {
      caller.sessionId = proof.sessionId;
      if (call) call.caller.sessionId = proof.sessionId;
    }
    // A pre-fix Compact & Resume can leave this exact app-opened replacement chat with its own
    // shadow session while the reusable-worker run is still bound to the source chat. Repair
    // only that durably-proven historical failure before membership is evaluated; unrelated
    // conversations still hit AGENTS_BUSY exactly as before.
    await repairPrimeFromResumeShadow(resolved);
  }
  if (!resolved && !allowRequest) {
    logWarn(
      base.requestId
        ? `agents caller not identified: no page evidence matched HTTP request ${base.requestId.slice(0, 20)}…`
        : 'agents caller not identified: this MCP request carried no request id and page evidence was insufficient'
    );
  }
  await reconcileAgentRequestOwners();
  await adoptAgent(agentForCaller(caller));
  return caller;
}

// ---------------------------------------------------------------------------
// apply_patch adapter helpers
// ---------------------------------------------------------------------------
