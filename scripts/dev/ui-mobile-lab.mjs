#!/usr/bin/env node
/**
 * ui-mobile-lab — 一键启动 Deep Student 移动 UI 审查环境
 *
 *   npm run ui:lab
 *
 * 会做：
 *   1. 启动 ui-bridge-server（17423）
 *   2. 以手机比例窗口 + VITE_DS_UI_BRIDGE=1 启动 tauri dev
 *
 * 选项：
 *   --device android-default | android-compact | …  （见 ui_devices）
 *   --no-tauri   只启动 bridge（已有 dev 实例时）
 *   --bridge-only  同 --no-tauri
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEVICES } from './ui-drive-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const BRIDGE_LOG = '/tmp/ds-ui-bridge.log';
const DEV_LOG = '/tmp/ds-ui-dev.log';
const PID_FILE = '/tmp/ds-ui-lab.pids.json';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const deviceArg = args.find((a) => !a.startsWith('--') && !a.startsWith('-'));
const device = deviceArg && DEVICES[deviceArg] ? deviceArg : 'android-default';
const bridgeOnly = flags.has('--no-tauri') || flags.has('--bridge-only');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitBridge(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch('http://127.0.0.1:17423/status');
      const json = await res.json();
      if (json.connected) return true;
    } catch {
      /* retry */
    }
    await sleep(400);
  }
  return false;
}

function spawnDetached(cmd, cmdArgs, env, logFile) {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(cmd, cmdArgs, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  return child.pid;
}

async function main() {
  console.log('Deep Student UI Lab');
  console.log(`  device preset: ${device} (${DEVICES[device].w}x${DEVICES[device].h})`);
  console.log(`  bridge log: ${BRIDGE_LOG}`);
  if (!bridgeOnly) console.log(`  dev log: ${DEV_LOG}`);

  // bridge
  const bridgePid = spawnDetached('node', ['scripts/dev/ui-bridge-server.mjs'], {}, BRIDGE_LOG);
  console.log(`  bridge pid: ${bridgePid}`);

  let devPid = null;
  if (!bridgeOnly) {
    const cfg = path.join(ROOT, 'config/dev-phone-window.json');
    const cfgObj = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    cfgObj.app.windows[0].width = DEVICES[device].w;
    cfgObj.app.windows[0].height = DEVICES[device].h;
    const runtimeCfg = '/tmp/ds-phone-window.runtime.json';
    fs.writeFileSync(runtimeCfg, JSON.stringify(cfgObj, null, 2));

    devPid = spawnDetached(
      'npm',
      ['run', 'dev:tauri', '--', '--config', runtimeCfg],
      { VITE_DS_UI_BRIDGE: '1' },
      DEV_LOG,
    );
    console.log(`  tauri dev pid: ${devPid}`);
  }

  fs.writeFileSync(PID_FILE, JSON.stringify({ bridgePid, devPid, device }, null, 2));

  console.log('\nWaiting for bridge…');
  const connected = await waitBridge(bridgeOnly ? 5000 : 120000);
  if (connected) {
    console.log('🟢 ui-bridge connected');
  } else {
    console.log('🟡 bridge up but app not connected yet — wait for tauri dev to finish compiling');
    console.log(`   tail -f ${DEV_LOG}`);
  }

  console.log('\nNext steps:');
  console.log('  • Enable MCP: node scripts/dev/mcp-ui-drive.mjs  (see docs/dev/ui-drive.md)');
  console.log('  • CLI: node scripts/dev/ui-drive.mjs status');
  console.log('  • CLI: node scripts/dev/ui-drive.mjs snapshot --text');
  console.log('  • Stop: npm run ui:lab:stop');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
