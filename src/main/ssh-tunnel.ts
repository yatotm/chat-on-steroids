import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { runSsh, SSH_OPTIONS, SSH_PROGRAM } from './ssh-config.js';

let leaseRoot: string | null = null;
let leaseRecoveryError: string | null = null;
interface SocketIdentity { dev: number; ino: number; birthtimeMs: number }
const sameSocket = (left: SocketIdentity, right: SocketIdentity) =>
  left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;

async function controlListenerActive(socket: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection({ path: socket });
    const finish = (active: boolean, error?: Error) => { connection.destroy(); error ? reject(error) : resolve(active); };
    connection.once('connect', () => finish(true));
    connection.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') finish(false);
      else finish(false, new Error('The SSH control socket could not be inspected.'));
    });
    connection.setTimeout(1000, () => finish(false, new Error('The SSH control socket did not answer.')));
  });
}

async function closeOwnedSocket(directory: string, expected?: SocketIdentity): Promise<void> {
  const socket = path.join(directory, 'c');
  const stat = await fs.lstat(socket).catch(() => null);
  if (!stat) return;
  if (!expected || !stat.isSocket() || !sameSocket(stat, expected))
    throw new Error('An SSH control socket changed ownership. It was not stopped.');
  try { await runSsh(['-F', '/dev/null', '-S', socket, '-O', 'exit', '--', 'localhost'], undefined, 1500); }
  catch {
    // 控制命令超时不等于 master 已退出；能建立 Unix 连接时保留租约并报告清理失败。
    if (!await controlListenerActive(socket)) return;
    throw new Error('The previous CoS SSH connection could not be closed.');
  }
  const deadline = Date.now() + 2000;
  while (await controlListenerActive(socket)) {
    if (Date.now() >= deadline) throw new Error('The previous CoS SSH connection has not exited.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** 启动时只回收本 userData 留下、且套接字身份仍匹配的租约，不按端口或进程名杀进程。 */
export async function initializeSshTunnels(userData: string): Promise<void> {
  leaseRecoveryError = 'Previous CoS SSH resources could not be recovered. Restart after resolving the saved lease error.';
  const root = path.join('/tmp', `cos-ssh-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(path.resolve(userData)).digest('hex').slice(0, 16)}`);
  const previous = await fs.lstat(root).catch(() => null);
  if (previous && (!previous.isDirectory() || previous.isSymbolicLink() || previous.uid !== process.getuid?.()))
    throw new Error('The CoS SSH lease directory is not owned by this user.');
  await fs.mkdir(root, { recursive: true, mode: 0o700 }); await fs.chmod(root, 0o700);
  leaseRoot = await fs.realpath(root);
  const entries = await fs.readdir(leaseRoot, { withFileTypes: true });
  if (entries.length > 128) throw new Error('Too many retained SSH leases.');
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^lease-[A-Za-z0-9]+$/.test(entry.name)) continue;
    const directory = path.join(leaseRoot, entry.name);
    const file = path.join(directory, 'lease.json');
    const metadata = await fs.lstat(file).catch(() => null);
    if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > 2048) continue;
    let saved: { owner?: string; socket?: SocketIdentity };
    try { saved = JSON.parse(await fs.readFile(file, 'utf8')); } catch { continue; }
    if (saved.owner !== 'chat-on-steroids-ssh-v1') continue;
    if (saved.socket) {
      if (![saved.socket.dev, saved.socket.ino, saved.socket.birthtimeMs].every(value => typeof value === 'number' && Number.isFinite(value))) continue;
      await closeOwnedSocket(directory, saved.socket);
    } else if (await fs.lstat(path.join(directory, 'c')).then(() => true, () => false)) continue;
    await fs.rm(directory, { recursive: true, force: true });
  }
  leaseRecoveryError = null;
}

/** 只看管自身 SSH 进程组。主进程管道断开即清理，不保存项目、令牌或连接状态。 */
export const SSH_GUARDIAN = String.raw`
const {spawn}=require('node:child_process');
const [program,...args]=process.argv.slice(1);
let child,stopping=false,timer;
const stop=()=>{
  if(stopping)return; stopping=true;
  timer=setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL')}catch{process.exit(1)}},2000);
  try{process.kill(-process.pid,'SIGTERM')}catch{}
};
process.stdin.on('end',stop); process.stdin.on('error',stop); process.stdin.resume();
process.on('SIGTERM',stop);process.on('SIGINT',stop);
child=spawn(program,args,{detached:false,stdio:['ignore','ignore','pipe']});
let bytes=0;
child.stderr.on('data',b=>{if(bytes<8192){process.stderr.write(b.subarray(0,8192-bytes));bytes+=b.length}});
child.once('error',()=>{clearTimeout(timer);process.exit(1)});
child.once('exit',stop);
`;

export interface SshTunnel {
  url: string; port: number; guardianPid: number; closed: Promise<void>; alive(): boolean; stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(error => error ? reject(error) : address && typeof address !== 'string' ? resolve(address.port) : reject(new Error('No local SSH port is available.')));
    });
  });
}

export async function openSshTunnel(alias: string, remotePort: number, signal: AbortSignal): Promise<SshTunnel> {
  signal.throwIfAborted();
  if (leaseRecoveryError) throw new Error(leaseRecoveryError);
  const directory = await fs.mkdtemp(path.join(leaseRoot ?? os.tmpdir(), leaseRoot ? 'lease-' : 'cos-ssh-'));
  await fs.chmod(directory, 0o700);
  const socket = path.join(directory, 'c');
  let socketIdentity: SocketIdentity | undefined;
  await fs.writeFile(path.join(directory, 'lease.json'), JSON.stringify({ owner: 'chat-on-steroids-ssh-v1' }), { flag: 'wx', mode: 0o600 });
  let child: ChildProcessWithoutNullStreams | null = null, ended = false, stopping: Promise<void> | null = null;
  let resolveExit!: () => void;
  const closed = new Promise<void>(resolve => { resolveExit = resolve; });
  const stop = (): Promise<void> => stopping ??= (async () => {
    const waitForGuardian = async () => {
    if (child && !ended) {
      child.stdin.end();
      child.kill('SIGCONT');
      const force = setTimeout(() => { if (!ended) child?.kill('SIGKILL'); }, 4000);
      let deadline: ReturnType<typeof setTimeout>;
      try { await Promise.race([closed, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('The SSH guardian did not exit.')), 6000);
      })]); } finally { clearTimeout(force); clearTimeout(deadline!); }
    }
    };
    await waitForGuardian();
    if (socketIdentity) await closeOwnedSocket(directory, socketIdentity);
    await fs.rm(directory, { recursive: true, force: true });
  })().catch(error => { stopping = null; throw error; });
  const abort = () => { void stop().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    child = spawn(process.execPath, ['-e', SSH_GUARDIAN, SSH_PROGRAM, '-N', '-T', '-M', '-S', socket,
      ...SSH_OPTIONS, '--', alias], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'pipe' });
    child.stdin.on('error', () => {});
    child.stdout.resume(); child.stderr.resume();
    const exited = () => { ended = true; resolveExit(); };
    child.once('error', exited); child.once('exit', exited);
    // 控制套接字确认本代自有 master 就绪；不复用用户已有的 ControlMaster。
    const deadline = Date.now() + 12_000;
    while (true) {
      signal.throwIfAborted();
      if (ended) throw new Error('SSH connection failed. First verify this host and unlock its key in your terminal.');
      if (await fs.stat(socket).then(() => true, () => false)) {
        await runSsh(['-F', '/dev/null', '-S', socket, '-O', 'check', '--', alias], signal);
        const stat = await fs.lstat(socket);
        socketIdentity = { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
        await fs.writeFile(path.join(directory, 'lease.json'), JSON.stringify({ owner: 'chat-on-steroids-ssh-v1', socket: socketIdentity }), { mode: 0o600 });
        break;
      }
      if (Date.now() >= deadline) throw new Error('SSH connection timed out.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const port = await freePort(); signal.throwIfAborted();
    // 转发控制请求只发送一次；丢失确认时关闭整个自有 master，不能另开端口留下重复映射。
    await runSsh(['-F', '/dev/null', '-S', socket, '-O', 'forward', '-L', `127.0.0.1:${port}:127.0.0.1:${remotePort}`, '--', alias], signal);
    signal.throwIfAborted();
    return { url: `http://127.0.0.1:${port}/mcp`, port, guardianPid: child.pid!, closed, alive: () => !ended, stop };
  } catch (error) { await stop(); throw error; }
  finally { signal.removeEventListener('abort', abort); }
}
