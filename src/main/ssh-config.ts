import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sshAliasSchema, type SshHostChoices } from '../shared/remote-hosts.js';

export const MANAGED_SSH_SUPPORTED = process.platform === 'darwin' || process.platform === 'linux';
export const SSH_PROGRAM = '/usr/bin/ssh';
export const SSH_OPTIONS = [
  '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ControlPersist=no', '-o', 'ForkAfterAuthentication=no', '-o', 'ClearAllForwardings=yes',
  '-o', 'PermitLocalCommand=no', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
  '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2'
];

/** 这里只枚举配置中的具体别名；真正的 Host/Match/认证语义由系统 OpenSSH 解释。 */
export function sshConfigWords(line: string): string[] {
  const words: string[] = []; let word = '', quote = '', escaped = false;
  for (const ch of line.trim()) {
    if (escaped) { word += ch; escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ''; else word += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#') break;
    if (/\s/.test(ch) || (ch === '=' && words.length === 0)) {
      if (word) { words.push(word); word = ''; }
    } else word += ch;
  }
  if (word) words.push(word);
  return words;
}

export async function listSshHosts(home = os.homedir()): Promise<SshHostChoices> {
  if (!MANAGED_SSH_SUPPORTED) return { supported: false, hosts: [] };
  const directory = path.join(home, '.ssh');
  const visited = new Set<string>(), hosts = new Set<string>();
  let bytes = 0;
  const read = async (file: string, depth: number): Promise<void> => {
    if (depth > 12 || visited.size >= 64) throw new Error('SSH configuration includes exceed the discovery limit.');
    let real: string;
    try { real = await fs.realpath(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (visited.has(real)) return;
    visited.add(real);
    const stat = await fs.stat(real);
    if (!stat.isFile()) return;
    if (stat.size > 256 * 1024 || bytes + stat.size > 2 * 1024 * 1024) throw new Error('SSH configuration is too large.');
    const handle = await fs.open(real, 'r');
    let text: string;
    try {
      const buffer = Buffer.alloc(256 * 1024 + 1);
      const result = await handle.read(buffer, 0, buffer.length, 0);
      if (result.bytesRead > 256 * 1024) throw new Error('SSH configuration is too large.');
      bytes += result.bytesRead;
      text = buffer.subarray(0, result.bytesRead).toString('utf8');
    } finally { await handle.close(); }
    for (const line of text.split(/\r?\n/)) {
      const [keyword, ...args] = sshConfigWords(line);
      if (keyword?.toLowerCase() === 'host') {
        for (const arg of args) if (sshAliasSchema.safeParse(arg).success) hosts.add(arg);
      } else if (keyword?.toLowerCase() === 'include') {
        for (const arg of args) {
          const expanded = arg.startsWith('~/') ? path.join(home, arg.slice(2)) : path.resolve(directory, arg);
          for await (const included of fs.glob(expanded)) await read(included, depth + 1);
        }
      }
      if (hosts.size > 200) throw new Error('Too many SSH hosts are configured.');
    }
  };
  await read(path.join(directory, 'config'), 0);
  return { supported: true, hosts: [...hosts].sort((a, b) => a.localeCompare(b)) };
}

export function runSsh(args: string[], signal?: AbortSignal, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(SSH_PROGRAM, args, { timeout: timeoutMs, maxBuffer: 256 * 1024, encoding: 'utf8', signal }, (error, stdout) => {
      if (error) reject(new Error('SSH failed. Check the saved host, its host key and unlocked key in your terminal.'));
      else resolve(stdout);
    });
  });
}

export function sshTargetKey(configuration: string, alias: string): string {
  // 别名本身不决定目标；代理、主机密钥、身份文件等所有有效选项均参与身份。
  const identity = configuration.split(/\r?\n/).filter(line => line && !line.startsWith('host '))
    .map(line => line.replaceAll('%n', alias)).join('\n');
  if (!/^hostname .+/m.test(identity) || !/^user .+/m.test(identity) || !/^port \d+/m.test(identity))
    throw new Error('OpenSSH did not return a valid host configuration.');
  return createHash('sha256').update(identity).digest('hex');
}

export async function resolveSshHost(alias: string, signal?: AbortSignal): Promise<string> {
  sshAliasSchema.parse(alias);
  const available = await listSshHosts();
  if (!available.supported) throw new Error('Managed SSH requires macOS or Linux.');
  if (!available.hosts.includes(alias)) throw new Error('Choose a host from your SSH configuration.');
  return sshTargetKey(await runSsh(['-G', ...SSH_OPTIONS, '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '--', alias], signal), alias);
}
