#!/usr/bin/env node
/** Stop processes started by ui-mobile-lab.mjs */
import fs from 'node:fs';

const PID_FILE = '/tmp/ds-ui-lab.pids.json';

if (!fs.existsSync(PID_FILE)) {
  console.log('No ui-lab pid file.');
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
fs.renameSync(PID_FILE, `${PID_FILE}.${Date.now()}.stopped`);
