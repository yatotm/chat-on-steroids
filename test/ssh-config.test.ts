import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listSshHosts, sshConfigWords, sshTargetKey, MANAGED_SSH_SUPPORTED } from '../src/main/ssh-config.js';
import { makeTempDir, removeTempDir } from './helpers.js';
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(removeTempDir)); });

it.skipIf(!MANAGED_SSH_SUPPORTED)('discovers concrete SSH aliases through bounded Includes without reading identity files', async () => {
  const home = await makeTempDir('cos-ssh-config-'); homes.push(home);
  await fs.mkdir(path.join(home, '.ssh', 'hosts'), { recursive: true });
  await fs.writeFile(path.join(home, '.ssh', 'config'), 'Host main alias\n HostName example.test\n IdentityFile ~/.ssh/do-not-open\nInclude hosts/*.conf\nHost * !blocked *.internal\n User root\n');
  await fs.writeFile(path.join(home, '.ssh', 'hosts', 'one.conf'), 'Host "second"\nInclude config\nHost=third # comment\n');
  expect((await listSshHosts(home)).hosts).toEqual(['alias', 'main', 'second', 'third']);
  expect(sshConfigWords('Include "host files/*.conf" # ignored')).toEqual(['Include', 'host files/*.conf']);
});

it('deduplicates aliases but distinguishes routes and host-key identities', () => {
  const config = 'host first\nhostname server.test\nuser root\nport 22\nproxyjump bastion\nhostkeyalias production\n';
  expect(sshTargetKey(config, 'first')).toBe(sshTargetKey(config.replace('host first', 'host second'), 'second'));
  expect(sshTargetKey(config, 'first')).not.toBe(sshTargetKey(config.replace('bastion', 'another-route'), 'first'));
  expect(sshTargetKey(config, 'first')).not.toBe(sshTargetKey(config.replace('production', 'staging'), 'first'));
  expect(sshTargetKey(config + 'proxycommand connect %n\n', 'first')).not.toBe(sshTargetKey(config + 'proxycommand connect %n\n', 'second'));
});
