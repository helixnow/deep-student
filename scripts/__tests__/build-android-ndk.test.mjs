import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const helperPath = join(testDir, '..', 'android-ndk-tools.sh');

function callHelper(functionName, ...args) {
  return execFileSync(
    'bash',
    [
      '-c',
      'source "$1"; function_name="$2"; shift 2; "$function_name" "$@"',
      'bash',
      helperPath,
      functionName,
      ...args,
    ],
    { encoding: 'utf-8' },
  ).trim();
}

test('NDK host tags cover supported macOS, Linux, and Windows shells', () => {
  assert.deepEqual(callHelper('android_ndk_host_tags', 'Darwin', 'arm64').split('\n'), [
    'darwin-arm64',
    'darwin-x86_64',
  ]);
  assert.equal(callHelper('android_ndk_host_tags', 'Darwin', 'x86_64'), 'darwin-x86_64');
  assert.equal(callHelper('android_ndk_host_tags', 'Linux', 'x86_64'), 'linux-x86_64');
  assert.equal(callHelper('android_ndk_host_tags', 'MINGW64_NT-10.0', 'x86_64'), 'windows-x86_64');
  assert.throws(() => callHelper('android_ndk_host_tags', 'Plan9', 'amd64'));
});

test('NDK discovery validates native tools and Windows wrapper extensions', () => {
  const root = mkdtempSync(join(tmpdir(), 'deep-student-ndk-'));
  try {
    const linuxBin = join(root, 'toolchains', 'llvm', 'prebuilt', 'linux-x86_64', 'bin');
    mkdirSync(linuxBin, { recursive: true });
    for (const tool of [
      'aarch64-linux-android21-clang',
      'aarch64-linux-android21-clang++',
      'llvm-ar',
    ]) {
      const toolPath = join(linuxBin, tool);
      writeFileSync(toolPath, '#!/usr/bin/env sh\n');
      chmodSync(toolPath, 0o755);
    }

    const linuxPrebuilt = callHelper('android_ndk_find_prebuilt', root, 'Linux', 'x86_64');
    assert.equal(linuxPrebuilt, dirname(linuxBin));
    assert.equal(
      callHelper('android_ndk_find_tool', linuxPrebuilt, 'aarch64-linux-android21-clang'),
      join(linuxBin, 'aarch64-linux-android21-clang'),
    );

    const windowsBin = join(root, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64', 'bin');
    mkdirSync(windowsBin, { recursive: true });
    writeFileSync(join(windowsBin, 'aarch64-linux-android21-clang.cmd'), '@echo off\r\n');
    writeFileSync(join(windowsBin, 'llvm-ar.exe'), 'fixture');
    const windowsPrebuilt = callHelper(
      'android_ndk_find_prebuilt',
      root,
      'MINGW64_NT-10.0',
      'x86_64',
    );
    assert.equal(
      callHelper('android_ndk_find_tool', windowsPrebuilt, 'aarch64-linux-android21-clang'),
      join(windowsBin, 'aarch64-linux-android21-clang.cmd'),
    );
    assert.equal(
      callHelper('android_ndk_find_tool', windowsPrebuilt, 'llvm-ar'),
      join(windowsBin, 'llvm-ar.exe'),
    );
    assert.throws(() => callHelper('android_ndk_find_tool', windowsPrebuilt, 'missing-tool'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
