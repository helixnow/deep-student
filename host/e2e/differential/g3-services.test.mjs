// Scenario services wiring that needs no fixed port: the MCP OAuth stand-in browser on the app's PATH
// (mcp README G3 接线 9) for A, A2 and B.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserPath, opensBrowser } from '../../../scripts/electron-migration/record/g3-services.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const OAUTH_SUITE = 'host/plugins/mcp/equivalence/pending-runner/mcp-oauth-browser.json';

test('MCP OAuth scenarios (and only they) start the app with the stand-in browser first on PATH', async t => {
  const suite = JSON.parse(readFileSync(join(REPO, OAUTH_SUITE), 'utf8'));
  assert.deepEqual(suite.scenarios.map(opensBrowser), suite.scenarios.map(() => true), 'the OAuth suite\'s scenarios');
  const step = args => ({ cmd: 'a', args });
  assert.equal(opensBrowser({ steps: [step({ url: '${mcp.oauth.url}' })] }), true);
  assert.equal(opensBrowser({ mcp: { scripts: ['success'] }, steps: [step({ args: '${mcp.success.args}' })] }), false, 'other MCP scenarios keep the PATH');
  assert.equal(opensBrowser({ mcp: { oauth: true }, steps: [step({ id: 'x' })] }), false, 'no MCP service runs, so there is no stand-in');
  assert.deepEqual(browserPath({ PATH: '/usr/bin:/bin', HOME: '/h' }, '/m/bin'), { PATH: '/m/bin:/usr/bin:/bin', HOME: '/h' });
  assert.deepEqual(browserPath({ HOME: '/h' }, '/m/bin'), { PATH: '/m/bin', HOME: '/h' });

  mkdirSync('/tmp/opencode', { recursive: true });
  const logDir = mkdtempSync('/tmp/opencode/w13-browser-');
  t.after(() => rmSync(logDir, { recursive: true, force: true }));
  const { startMcpService } = await import('../../plugins/mcp/equivalence/mcp-service.ts');
  const service = await startMcpService({ host: '127.0.0.1', port: 0, logDir, nodeCommand: process.execPath, selfContained: true });
  try {
    const { pathDir, command } = service.browserLaunch();
    const env = browserPath({ PATH: process.env.PATH }, pathDir);
    const found = spawnSync('sh', ['-c', 'command -v xdg-open'], { env, encoding: 'utf8' });
    assert.equal(found.stdout.trim(), command, 'the opener the app spawns by name is the stand-in');
    assert.equal(command, join(pathDir, 'xdg-open'));
  } finally { await service.stop(); }
});
