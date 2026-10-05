import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SSH_GUARDIAN, openSshTunnel, initializeSshTunnels } from '../src/main/ssh-tunnel.js';
import { makeTempDir, removeTempDir } from './helpers.js';
const children: ChildProcessWithoutNullStreams[] = [], directories: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    child.stdin.end(); await new Promise<void>(resolve => child.once('exit', () => resolve()));
  }
  await Promise.all(directories.splice(0).map(removeTempDir));
});
const posix = process.platform !== 'win32';

it.skipIf(!posix)('reaps only its own SSH process group when the parent lifetime pipe ends', async () => {
  const directory = await makeTempDir('cos-ssh-guardian-'); directories.push(directory);
  const receipt = path.join(directory, 'child.json');
  const code = 'const fs=require("node:fs"),net=require("node:net");const server=net.createServer();server.listen(0,"127.0.0.1",()=>fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,port:server.address().port})));';
  const guardian = spawn(process.execPath, ['-e', SSH_GUARDIAN, process.execPath, '-e', code, receipt], { stdio: 'pipe', detached: true });
  children.push(guardian); guardian.stdout.resume(); guardian.stderr.resume();
  let child!: { pid: number; port: number };
  await expect.poll(async () => {
    try { child = JSON.parse(await fs.readFile(receipt, 'utf8')); return true; } catch { return false; }
  }).toBe(true);
  expect(() => process.kill(child.pid, 0)).not.toThrow();
  const exited = new Promise<void>(resolve => guardian.once('exit', () => resolve()));
  guardian.stdin.end(); await exited;
  expect(() => process.kill(child.pid, 0)).toThrow();
  await expect(fetch('http://127.0.0.1:' + child.port)).rejects.toThrow();
});

it.skipIf(!posix || !process.env.COS_TEST_SSH_HOST)('opens a real isolated SSH mapping and releases its listening port', async () => {
  const tunnel = await openSshTunnel(process.env.COS_TEST_SSH_HOST!, 18787, new AbortController().signal);
  try {
    expect(tunnel.alive()).toBe(true);
    const response = await fetch(tunnel.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(401);
  } finally { await tunnel.stop(); }
  expect(tunnel.alive()).toBe(false);
  await expect(fetch(tunnel.url)).rejects.toThrow();
}, 25000);

it.skipIf(!posix)('kills a descendant that ignores TERM even after the SSH leader has exited', async () => {
  const directory = await makeTempDir('cos-ssh-descendant-'); directories.push(directory);
  const receipt = path.join(directory, 'descendant.json');
  const descendant = 'const fs=require("node:fs"),net=require("node:net");process.on("SIGTERM",()=>{});const server=net.createServer();server.listen(0,"127.0.0.1",()=>fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,port:server.address().port})));';
  const leader = 'const fs=require("node:fs"),{spawn}=require("node:child_process");spawn(process.execPath,["-e",process.argv[1],process.argv[2]],{stdio:"ignore"});setInterval(()=>{if(fs.existsSync(process.argv[2]))process.exit(0)},10);';
  const guardian = spawn(process.execPath, ['-e', SSH_GUARDIAN, process.execPath, '-e', leader, descendant, receipt], { stdio: 'pipe', detached: true });
  children.push(guardian); guardian.stdout.resume(); guardian.stderr.resume();
  const exited = new Promise<void>(resolve => guardian.once('exit', () => resolve()));
  let child!: { pid: number; port: number };
  await expect.poll(async () => {
    try { child = JSON.parse(await fs.readFile(receipt, 'utf8')); return true; } catch { return false; }
  }).toBe(true);
  expect(() => process.kill(child.pid, 0)).not.toThrow();
  await exited;
  await expect.poll(() => { try { process.kill(child.pid, 0); return true; } catch { return false; } }).toBe(false);
  await expect(fetch('http://127.0.0.1:' + child.port)).rejects.toThrow();
});

it.skipIf(!posix || !process.env.COS_TEST_SSH_HOST)('recovers its socket-owned SSH master when the guardian dies unexpectedly', async () => {
  const directory = await makeTempDir('cos-ssh-recovery-'); directories.push(directory);
  await initializeSshTunnels(directory);
  const tunnel = await openSshTunnel(process.env.COS_TEST_SSH_HOST!, 18787, new AbortController().signal);
  try {
    process.kill(tunnel.guardianPid, 'SIGKILL'); await tunnel.closed;
    await initializeSshTunnels(directory);
    await expect.poll(async () => {
      try { await fetch(tunnel.url); return false; } catch { return true; }
    }).toBe(true);
  } finally { await tunnel.stop(); }
}, 25000);
