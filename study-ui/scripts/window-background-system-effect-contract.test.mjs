import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = '/Users/ba7mlv/Documents/ui/study-ui';

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
}

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

test('tauri config keeps macOS native overlay chrome with an opaque shell while moving Windows to a mica-first default', () => {
  const baseConfig = readJson('src-tauri/tauri.conf.json');
  const macosConfig = readJson('src-tauri/tauri.macos.conf.json');
  const windowsConfig = readJson('src-tauri/tauri.windows.conf.json');
  const rustSource = read('src-tauri/src/window_background.rs');

  assert.equal(baseConfig.app.macOSPrivateApi, true, 'macOS native titlebar customization still depends on macOSPrivateApi');
  assert.equal(baseConfig.app.windows[0].transparent, true, 'the shared base config keeps transparent capability for platform overrides that need native effects');
  assert.equal(macosConfig.app.windows[0].transparent, false, 'macOS translucent mode should keep the decorated shell opaque so traffic lights do not float over other apps');
  assert.equal('windowEffects' in macosConfig.app.windows[0], false, 'macOS decorated chrome should not opt into transparent-window vibrancy');
  assert.equal(macosConfig.app.windows[0].titleBarStyle, 'Overlay', 'macOS should keep native overlay titlebar chrome so traffic lights stay inside the same window shell');
  assert.equal('trafficLightPosition' in macosConfig.app.windows[0], false, 'macOS should keep system traffic-light placement instead of custom coordinates');
  assert.deepEqual(
    windowsConfig.app.windows[0].windowEffects,
    { effects: ['mica'] },
    'Windows should default to the native Mica material',
  );
  assert.equal(
    rustSource.includes('effects: vec![WindowEffect::WindowBackground]'),
    true,
    'macOS runtime config should use a single WindowBackground material',
  );
  assert.equal(
    rustSource.includes('FollowsWindowActiveState'),
    true,
    'macOS runtime WindowBackground material should follow the window active state',
  );
  assert.equal(
    rustSource.includes('traffic_light_position = Some(LogicalPosition { x: 16.0, y: 17.0 })'),
    true,
    'macOS runtime should nudge the native traffic lights slightly downward to align with the shared chrome centerline',
  );
  assert.equal(
    rustSource.includes('effects: vec![WindowEffect::Mica]'),
    true,
    'runtime window config should match the mica-first startup strategy',
  );
  assert.equal(
    rustSource.includes('WindowEffect::Blur'),
    true,
    'runtime config should retain a blur fallback path for unsupported Mica environments',
  );
  assert.equal(
    rustSource.includes('WindowEffect::Sidebar'),
    false,
    'macOS runtime config should not switch to Sidebar material in translucent mode',
  );
  assert.equal(
    rustSource.includes('WindowEffect::ContentBackground'),
    false,
    'macOS runtime config should not switch to ContentBackground material in translucent mode',
  );
});

test('translucent mode leaves the root surfaces transparent so platform background layers can show through', () => {
  const styles = read('src/styles/app.css');

  assert.equal(
    styles.includes('html[data-window-background="translucent"],') &&
      styles.includes('html[data-window-background="translucent"] body,') &&
      styles.includes('html[data-window-background="translucent"] #root {') &&
      styles.includes('background: transparent;'),
    true,
    'translucent mode should make the root window surfaces transparent',
  );
});
