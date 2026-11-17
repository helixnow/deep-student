// Use native Node imports for newly installed on-disk plugins, as in recovery-probe.mjs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('delegated lifecycle uses the real package manager, activated service, recovery and persisted state', async () => {
  const result = await promisify(execFile)(process.execPath, ['--test-reporter=tap', fileURLToPath(new URL('./delegated-lifecycle-probe.ts', import.meta.url))], { timeout: 35_000 });
  expect(result.stdout).toContain('# pass 10');
}, 40_000);
