import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runSmoke(electron: string | undefined) {
  const fixture = mkdtempSync(path.join(tmpdir(), 'cos-packaging-version-'));
  try {
    mkdirSync(path.join(fixture, 'scripts'));
    for (const name of ['smoke-packaged-runtime.mjs', 'packaging-targets.mjs', 'packaging-versions.mjs']) {
      copyFileSync(path.join(root, 'scripts', name), path.join(fixture, 'scripts', name));
    }
    writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ version: '2.2.3', devDependencies: { electron } }));
    const unpacked = path.join(fixture, 'unpacked');
    const result = spawnSync(process.execPath, [path.join(fixture, 'scripts', 'smoke-packaged-runtime.mjs'),
      '--platform', 'linux', '--arch', 'x64', '--root', unpacked], { encoding: 'utf8' });
    return { ...result, missingArtifact: path.join(unpacked, 'resources', 'app.asar') };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

const currentElectron = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies.electron;

it.each(['44.9.3', currentElectron, '46.0.0-beta.2', '46.0.0-nightly.20261025'])(
  'accepts exact Electron %s at the real packaging smoke entry', (version) => {
    const result = runSmoke(version);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('Electron must be pinned');
    // 空夹具必须继续走到产物检查，不能把版本校验通过当成安装包验收通过。
    expect(result.stderr).toContain('ENOENT');
    expect(result.stderr).toContain(result.missingArtifact);
  });

it.each(['^46.0.0-alpha.1', '~46.0.0', '>=46.0.0', '46.x', 'latest', '46.0.0-', '46.0.0-alpha..1', undefined])(
  'rejects non-exact Electron %s before inspecting packaged artifacts', (version) => {
    const result = runSmoke(version);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Electron must be pinned to an exact release version');
    expect(result.stderr).not.toContain(result.missingArtifact);
  });
