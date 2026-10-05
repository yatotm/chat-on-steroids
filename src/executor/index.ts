import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EXECUTION_PROTOCOL } from '../shared/remote-execution.js';
import { startExecutionServer } from './server.js';
import { initLogFile, flushLogBeforeExit } from '../main/logger.js';

async function main() {
  const { values } = parseArgs({ options: {
    root: { type: 'string', multiple: true }, port: { type: 'string', default: '18787' },
    'token-file': { type: 'string' }, 'state-dir': { type: 'string' }, help: { type: 'boolean', default: false }
  } });
  if (values.help) {
    process.stdout.write('Usage: node out/executor/index.cjs --root /srv/project --token-file /private/token [--port 18787] [--state-dir /private/state]\n');
  } else {
    try {
      if (!values.root?.length || !values['token-file']) throw new Error('--root and --token-file are required.');
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
      const tokenPath = path.resolve(values['token-file']);
      const tokenInfo = await fs.stat(tokenPath);
      if (!tokenInfo.isFile() || tokenInfo.size > 8192 || (tokenInfo.mode & 0o077) !== 0)
        throw new Error('The token file must be an owner-only regular file (chmod 600), at most 8192 bytes.');
      const token = (await fs.readFile(tokenPath, 'utf8')).trim();
      const directory = path.resolve(values['state-dir'] ?? path.join(os.homedir(), '.local/state/chat-on-steroids-executor'));
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const identityPath = path.join(directory, 'identity.json');
      try { await fs.writeFile(identityPath, JSON.stringify({ serverId: randomUUID() }), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const identity = z.object({ serverId: z.string().uuid() }).strict().parse(JSON.parse(await fs.readFile(identityPath, 'utf8')));
      initLogFile(path.join(directory, 'executor.log'));
      const service = await startExecutionServer({ roots: values.root, token, serverId: identity.serverId, port });
      process.stdout.write(JSON.stringify({ service: 'chat-on-steroids-executor', protocol: EXECUTION_PROTOCOL, port: service.port, serverId: service.serverId }) + '\n');
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        const deadline = setTimeout(() => process.exit(1), 20_000);
        deadline.unref();
        void service.stop().then(async () => { await flushLogBeforeExit(); process.exit(0); }, () => process.exit(1));
      };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    } catch (error) {
      process.stderr.write(`CoS execution service did not start: ${error instanceof Error ? error.message : 'invalid configuration'}\n`);
      process.exitCode = 1;
    }
  }

}
void main().catch(() => { process.stderr.write('CoS execution service could not initialize.\n'); process.exitCode = 1; });
