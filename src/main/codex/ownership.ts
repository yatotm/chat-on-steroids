import { onRequestCorrelation, requestCorrelation } from '../session/correlation.js';
import { unifiedExecManager } from './manager.js';
import { createProcessCustody } from './process-custody.js';
export { MAX_UNREAD_EXEC_RESULTS_PER_CONVERSATION, UNATTENDED_EXEC_NOTICE_MS } from './process-custody.js';

/** 本机执行沿用原有请求到会话的精确归属，远程执行器使用同一实现。 */
export const processCustody = createProcessCustody(unifiedExecManager, requestCorrelation);
onRequestCorrelation(processCustody.reconcileExecRequestOwner);
export const {
  onBackgroundExecChange, runningExecProcesses, stopExecProcess,
  executionPrincipal,
  provenConversation,
  provenSession,
  noteExecOwner,
  noteExecAttended,
  forgetExecOwner,
  execOwner,
  backgroundExecObligations,
  backgroundExecRecoveryNotices,
  acknowledgeBackgroundExecOutput,
  offerBackgroundExecOutput,
  execOwnershipFailure,
  resetExecOwnershipForTests,
  backdateExecAttendanceForTests
} = processCustody;
