#!/usr/bin/env node
/** Stop processes started by ui-mobile-lab.mjs */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const PID_FILE = '/tmp/ds-ui-lab.pids.json';

if (!fs.existsSync(PID_FILE)) {
  console.log('No ui-lab pid file; trying pkill fallback');
  try {
    execSync('pkill -f "scripts/dev/ui-bridge-server.mjs" || true');
    execSync('pkill -f "target/debug/deep-student" || true');
  } catch {
    /* ignore */
  }
  process.exit(0);
}

const { bridgePid, devPid } = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
for (const pid of [devPid, bridgePid]) {
  if (!pid) continue;
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`stopped pid ${pid}`);
  } catch {
    console.log(`pid ${pid} already gone`);
  }
}
fs.unlinkSync(PID_FILE);
