import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 独立 Node 进程验证真正的执行边界，不用应用进程里的另一个状态副本。 */
export async function executorFixture(directory: string, roots: string[]) {
  const token = randomUUID() + randomUUID();
  const tokenFile = path.join(directory, 'executor-token');
  await fs.writeFile(tokenFile, token, { mode: 0o600 });
  const child = spawn(process.execPath, [path.resolve('out/executor/index.cjs'),
    ...roots.flatMap(root => ['--root', root]), '--port', '0', '--token-file', tokenFile,
    '--state-dir', path.join(directory, 'executor-state')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '', output = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-3000); });
  const ready = await new Promise<{ port: number; serverId: string }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Execution fixture startup timed out: ' + diagnostics)); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Execution fixture exited ${code}: ${diagnostics}`)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      const line = output.split('\n')[0];
      if (!line || !output.includes('\n')) return;
      try { const value = JSON.parse(line); if (value.service === 'chat-on-steroids-executor') { clearTimeout(timer); resolve(value); } }
      catch { /* 等待完整的启动行；诊断输出不包含令牌。 */ }
    });
  });
  return {
    ...ready, url: `http://127.0.0.1:${ready.port}/mcp`, token,
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise<void>(resolve => {
        const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('exit', () => { clearTimeout(deadline); resolve(); });
        child.kill('SIGTERM');
      });
    }
  };
}
