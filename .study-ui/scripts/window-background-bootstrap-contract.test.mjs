import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = '/Users/ba7mlv/Documents/ui/study-ui';

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
}

function mergePatch(target, patch) {
  if (Array.isArray(patch) || patch === null || typeof patch !== 'object') {
    return structuredClone(patch);
  }

  const source = target && typeof target === 'object' && !Array.isArray(target) ? target : {};
  const result = structuredClone(source);

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
      continue;
    }

    if (Array.isArray(value) || typeof value !== 'object') {
      result[key] = structuredClone(value);
      continue;
    }

    result[key] = mergePatch(result[key], value);
  }

  return result;
}


test('main window is created from native bootstrap instead of auto-starting with a fixed transparent config', () => {
  const baseConfig = readJson('src-tauri/tauri.conf.json');

  assert.equal(
    baseConfig.app.windows[0].create,
    false,
    'the main window should be created in Rust after reading the persisted window background preference',
  );
});


test('platform window overrides preserve manual bootstrap fields after Tauri merge', () => {
  const baseConfig = readJson('src-tauri/tauri.conf.json');
  const macosConfig = readJson('src-tauri/tauri.macos.conf.json');
  const windowsConfig = readJson('src-tauri/tauri.windows.conf.json');

  const mergedMacosWindow = mergePatch(baseConfig, macosConfig).app.windows[0];
  const mergedWindowsWindow = mergePatch(baseConfig, windowsConfig).app.windows[0];

  assert.equal(mergedMacosWindow.create, false, 'macOS overrides must keep native bootstrap window creation disabled');
  assert.equal(mergedMacosWindow.title, '', 'macOS overrides should suppress the native window title text');
  assert.equal(mergedMacosWindow.decorations, true, 'macOS overrides should keep native window decorations enabled');
  assert.equal(mergedMacosWindow.titleBarStyle, 'Overlay', 'macOS overrides should use overlay titlebar chrome so web content and traffic lights share a fullsize content view');
  assert.equal(mergedMacosWindow.hiddenTitle, true, 'macOS overrides should hide the native title text');
  assert.equal(mergedMacosWindow.transparent, true, 'macOS overrides should preserve transparent capability so the Rust bootstrap can open the same translucent sidebar material as the JS runtime');
  assert.equal('trafficLightPosition' in mergedMacosWindow, false, 'macOS overrides should let the system place traffic lights natively');
  assert.equal('windowEffects' in mergedMacosWindow, false, 'macOS overrides should not enable transparent-window vibrancy on the decorated shell');
  assert.equal(mergedWindowsWindow.create, false, 'Windows overrides must keep native bootstrap window creation disabled');
  assert.equal(mergedWindowsWindow.title, 'Deep Student', 'Windows overrides must keep the main window metadata');
});
