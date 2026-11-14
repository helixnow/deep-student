import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('B5 real P1 install v1→v2→new Host→activation failure→restore and enable v1', async () => {
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./recovery-probe.mjs', import.meta.url))], { timeout: 30_000 });
  expect(JSON.parse(result.stdout)).toMatchObject({ restored: '1.0.0', running: true });
}, 35_000);
