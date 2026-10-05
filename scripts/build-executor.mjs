import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rm } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await rm(path.join(root, 'out/executor'), { recursive: true, force: true });
const built = await build({
  absWorkingDir: root, entryPoints: ['src/executor/index.ts'], outfile: 'out/executor/index.cjs',
  bundle: true, packages: 'external', platform: 'node', target: 'node22', format: 'cjs',
  sourcemap: false, metafile: true, logLevel: 'info'
});
// 无界面执行器不能偷偷拉入 Electron 或桌面上的会话、队列和编排。
const forbidden = Object.keys(built.metafile.inputs).filter(name =>
  /^src\/main\/(?:session\/|agents\.ts|bridge\.ts|secrets\.ts|ipc\.ts|mcp\/kernel\.ts)/.test(name));
if (forbidden.length) throw new Error(`Desktop ownership leaked into the execution service: ${forbidden.join(', ')}`);
