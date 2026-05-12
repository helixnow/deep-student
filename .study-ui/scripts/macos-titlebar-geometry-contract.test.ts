import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  APP_LAYOUT_TOKENS,
  getFloatingSidebarTogglePosition,
  getOverlayLeadingInset,
  getSidebarHeaderHeight,
} from '../src/lib/app-shell.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

function readJson<T>(relativePath: string) {
  return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8')) as T;
}

test('tauri macOS config leaves traffic-light placement to the native overlay titlebar', () => {
  const macosConfig = readJson<{
    app: {
      windows: Array<Record<string, unknown>>;
    };
  }>('src-tauri/tauri.macos.conf.json');

  assert.equal(macosConfig.app.windows[0].titleBarStyle, 'Overlay');
  assert.equal(macosConfig.app.windows[0].transparent, true);
  assert.equal('trafficLightPosition' in macosConfig.app.windows[0], false);
});

test('macOS shell geometry keeps native transparent content clear of the traffic lights and on their centerline', () => {
  const nativeTrafficLightCenterline =
    APP_LAYOUT_TOKENS.MAC_TRAFFIC_LIGHTS_TOP_INSET +
    APP_LAYOUT_TOKENS.MAC_TRAFFIC_LIGHTS_VISUAL_SIZE / 2;
  const trafficLightClearance =
    APP_LAYOUT_TOKENS.MAC_TRAFFIC_LIGHTS_TRAILING_EDGE +
    APP_LAYOUT_TOKENS.MAC_TOGGLE_LEADING_OFFSET_FROM_TRAFFIC_LIGHTS;
  const nativeTransparentControlCenterline =
    (getSidebarHeaderHeight('native-transparent') - APP_LAYOUT_TOKENS.MAC_TITLEBAR_CONTROL_SIZE) / 2 +
    APP_LAYOUT_TOKENS.MAC_TITLEBAR_CONTROL_SIZE / 2;
  const overlayTogglePosition = getFloatingSidebarTogglePosition('native-overlay');

  assert.equal(getOverlayLeadingInset('native-overlay'), trafficLightClearance);
  assert.equal(getOverlayLeadingInset('native-transparent'), trafficLightClearance);
  assert.equal(nativeTransparentControlCenterline, nativeTrafficLightCenterline);
  assert.ok(overlayTogglePosition);
  assert.equal(
    overlayTogglePosition!.top + APP_LAYOUT_TOKENS.MAC_TITLEBAR_CONTROL_SIZE / 2,
    nativeTrafficLightCenterline,
  );
});
