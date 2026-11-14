import fs from 'node:fs';
import { expect, it } from 'vitest';
import { BASE, consumerMatrix, INPUTS, TARGETS } from './consumerGoldenHarness';

const golden = 'src/shared/resource-types/__golden__/consumer-functions.json';

it('matches actual consumer outputs captured from e73e0d98 (not the new capability table)', async () => {
  if (process.env.W37_CAPTURE_BASELINE === BASE) {
    // Write-once, and ALWAYS execute the frozen baseline declarations, never HEAD.
    fs.writeFileSync(golden, `${JSON.stringify({ baseline: BASE, inputs: INPUTS, consumers: await consumerMatrix(true) }, null, 2)}\n`, { flag: 'wx' });
  }
  const expected = JSON.parse(fs.readFileSync(golden, 'utf8'));
  expect(expected.baseline).toBe(BASE);
  expect(expected.inputs).toEqual(INPUTS);
  expect(Object.keys(expected.consumers)).toHaveLength(TARGETS.length);
  const actual = await consumerMatrix(false) as Record<string, Record<string, unknown>>;
  // Study Space mounts added an explicit `folder` icon (`FolderSimple`) after `e73e0d98`
  // (previously fell through to `FileIcon`); keep the frozen golden intact while verifying
  // all remaining consumers and inputs match `e73e0d98`.
  const groupIconKey = 'src/features/chat/components/groups/GroupEditorDialog.tsx:getResourceTypeIcon';
  expect(actual[groupIconKey]?.folder).toEqual({ result: '<function:FolderSimple>', calls: [] });
  const normalized = structuredClone(actual);
  normalized[groupIconKey]!.folder = expected.consumers[groupIconKey].folder;
  expect(normalized).toEqual(expected.consumers);
}, 60_000);

it('reproduces the frozen consumer evidence from the original git blobs', async () => {
  const expected = JSON.parse(fs.readFileSync(golden, 'utf8'));
  expect(await consumerMatrix(true)).toEqual(expected.consumers);
}, 60_000);

it('detects the audited inherited-key regression in the delivered 6992cdc0 consumers', async () => {
  const expected = JSON.parse(fs.readFileSync(golden, 'utf8')).consumers;
  const delivered = await consumerMatrix(false, '6992cdc0', TARGETS.filter(target =>
    target.file.endsWith('/ContextRefChips.tsx')));
  for (const name of ['getTypeIcon', 'getTypeColorClass']) {
    const consumer = `src/features/chat/components/input-bar/ContextRefChips.tsx:${name}`;
    for (const key of ['__proto__', 'constructor']) {
      expect(delivered[consumer][key]).not.toEqual(expected[consumer][key]);
    }
  }
}, 60_000);
