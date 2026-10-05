import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { executionUrlSchema, EXECUTION_REQUEST_BYTES, EXECUTION_RESPONSE_BYTES, type ExecutionScope } from '../shared/remote-execution.js';

export class ExecutionTransportError extends Error {}

const requests = new Map<http.ClientRequest, boolean>();
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 128, maxTotalSockets: 128, maxFreeSockets: 4 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128, maxTotalSockets: 128, maxFreeSockets: 4 });
let stopped = false;

/** 只发送一次。连接中断不能证明远端没有执行，尤其不能自动重放写入或命令。 */
export function executionRpc(url: string, token: string, name: string, args: Record<string, unknown>, scope?: ExecutionScope,
  options: { completion?: boolean; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
  if (stopped) return Promise.reject(new ExecutionTransportError('The remote execution transport is shutting down.'));
  const endpoint = new URL(executionUrlSchema.parse(url));
  const id = randomUUID();
  const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {
    name, arguments: args, ...(scope ? { _meta: { cosExecution: scope } } : {})
  } });
  if (Buffer.byteLength(body) > EXECUTION_REQUEST_BYTES) return Promise.reject(new ExecutionTransportError('Remote request is too large. No operation was dispatched.'));
  const completion = options.completion === true;
  const occupied = [...requests.values()].filter(wait => wait === completion).length;
  if (occupied >= (completion ? 64 : 32)) return Promise.reject(new ExecutionTransportError('The remote execution connection limit was reached. No operation was dispatched.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); requests.delete(request);
      if (error) reject(error); else resolve(value!);
    };
    const request = (endpoint.protocol === 'https:' ? https : http).request(endpoint, {
      agent: endpoint.protocol === 'https:' ? httpsAgent : httpAgent,
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        accept: 'application/json', 'content-length': Buffer.byteLength(body) }
    }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > EXECUTION_RESPONSE_BYTES) {
          finish(new ExecutionTransportError('Remote result exceeded its transport limit. Inspect existing work before taking further action.'));
          response.destroy(); return;
        }
        chunks.push(chunk);
      });
      response.on('error', () => finish(new ExecutionTransportError('Remote response was interrupted. The operation may have executed; it was not retried.')));
      response.on('aborted', () => finish(new ExecutionTransportError('Remote response was interrupted. The operation may have executed; it was not retried.')));
      response.on('end', () => {
        if (settled) return;
        if (response.statusCode !== 200) {
          finish(new ExecutionTransportError(response.statusCode === 401 ? 'The execution service rejected its access token. Reconnect the remote project.'
            : `Remote execution returned HTTP ${response.statusCode ?? 'unknown'}. Check existing work before retrying.`));
          return;
        }
        try {
          const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          if (!value || value.jsonrpc !== '2.0' || value.id !== id || !value.result || typeof value.result !== 'object' || Array.isArray(value.result))
            throw new ExecutionTransportError('Invalid remote response.');
          finish(undefined, value.result);
        } catch { finish(new ExecutionTransportError('The service did not return a valid CoS execution response. The call was not retried.')); }
      });
    });
    // 进程结束订阅随真实进程或应用退出结束；它不是轮询，也不会读取终端输出。
    const deadline = options.completion ? undefined : setTimeout(() => {
      finish(new ExecutionTransportError('Remote execution timed out. Its outcome is unconfirmed; do not repeat the operation automatically.'));
      request.destroy();
    }, options.timeoutMs ?? (['cos_info', 'cos_workspace', 'cos_background'].includes(name) ? 10_000 : 345_000));
    deadline?.unref();
    requests.set(request, completion);
    request.on('error', () => finish(new ExecutionTransportError('The CoS execution service is unreachable. The operation may have executed; it was not retried.')));
    request.end(body);
  });
}

/** 关闭的是 Mac 的传输；Linux 进程仍由执行服务管理，重开应用可使用原有有效句柄。 */
export function closeExecutionTransport(): void {
  stopped = true;
  for (const request of requests.keys()) request.destroy();
  requests.clear();
  httpAgent.destroy(); httpsAgent.destroy();
}
