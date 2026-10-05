/**
 * The one `UnifiedExecProcessManager` for this app.
 *
 * Codex hangs the manager off `session.services`, so every `exec_command` and `write_stdin` in a
 * conversation shares it and a session id stays meaningful between calls. This connector has one
 * long-lived main process rather than a per-conversation session object, so the manager is a
 * module singleton -- the same lifetime, reached the same way.
 */

import {
  DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS
} from './unified-exec-constants.js';
import { UnifiedExecProcessManager } from './unified-exec.js';

export const unifiedExecManager = new UnifiedExecProcessManager(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS);

export { DEFAULT_TRUNCATION_POLICY, EXEC_OUTPUT_CEILING_POLICY } from './unified-exec-constants.js';
