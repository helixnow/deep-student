// Fixed-version macOS main entry. Runs after copying the app/flipping framework
// fuses, before electron-builder signs it. Never patches the shared distribution.
'use strict';
const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { Arch } = require('builder-util');

function installMacMainEntry(context, run = execFileSync) {
  if (context.electronPlatformName !== 'darwin') return;
  const version = context.packager.info.framework.version;
  if (version !== '45.2.1') throw new Error(`mac main stub requires Electron 45.2.1; review upstream entry before using ${version}`);
  const arch = context.arch === Arch.arm64 ? 'arm64' : context.arch === Arch.x64 ? 'x86_64' : null;
  if (arch === null) throw new Error(`mac main stub supports arm64/x64 only, not arch ${context.arch}`);
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const executable = join(app, 'Contents', 'MacOS', context.packager.appInfo.productFilename);
  if (run('lipo', ['-archs', executable], { encoding: 'utf8' }).trim() !== arch) {
    throw new Error(`mac main stub target ${arch} does not match the packaged main executable`);
  }
  const commands = run('otool', ['-l', executable], { encoding: 'utf8' });
  const minOS = /\bminos\s+(\d+(?:\.\d+){1,2})\b/.exec(commands)?.[1];
  if (!minOS) throw new Error('cannot read packaged main deployment target');
  const temp = mkdtempSync(join(context.appOutDir, '.mac-main-stub-'));
  try {
    const output = join(temp, 'main');
    run('clang++', ['-std=c++17', '-nostdlib++', '-arch', arch, `-mmacosx-version-min=${minOS}`, '-Os',
      join(__dirname, '..', 'native', 'mac-main-45.2.1.cc'),
      '-F', join(app, 'Contents', 'Frameworks'), '-framework', 'Electron Framework',
      '-Wl,-rpath,@executable_path/../Frameworks', '-o', output], { stdio: 'pipe' });
    // Replace, never rename/keep the old executable as an alternate entry.
    copyFileSync(output, executable);
    copyFileSync(join(__dirname, '..', 'native', 'LICENSE.electron'), join(app, 'Contents', 'Resources', 'licenses', 'Electron-main-stub-MIT.txt'));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { installMacMainEntry };
