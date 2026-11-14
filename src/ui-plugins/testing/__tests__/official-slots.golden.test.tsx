/**
 * FE-A3 evidence: the complete slot inventory after all official UI plugins are installed (the glob
 * installer plus the official chat plugin, wired to the real chat registries), and the kernel-owned chat
 * block / event / mode entries.
 *
 * Captured on the pre-FE-A3 tree; the full-stack tests compare the default-profile reconciliation result
 * against the same file. Capture: W17_CAPTURE_OFFICIAL_SLOTS=1 (write-once).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { installOfficialChatUiPlugin } from '@/features/chat/plugins';
import { UiKernel } from '@/ui-kernel/kernel';
import { installOfficialUiPlugins } from '../../official/install';
import { chatLegacyRegistries, kernelSnapshot, OFFICIAL_SLOTS_GOLDEN } from '../slot-snapshot';

it('records every official slot entry and kernel-owned chat registry entry', async () => {
  const kernel = new UiKernel({ legacyRegistries: chatLegacyRegistries() });
  try {
    await installOfficialUiPlugins(kernel);
    await installOfficialChatUiPlugin(kernel);
    const actual = kernelSnapshot(kernel);
    if (process.env.W17_CAPTURE_OFFICIAL_SLOTS === '1') writeFileSync(OFFICIAL_SLOTS_GOLDEN, `${JSON.stringify(actual, null, 1)}\n`, { flag: 'wx' });
    expect(actual).toEqual(JSON.parse(readFileSync(OFFICIAL_SLOTS_GOLDEN, 'utf8')));
  } finally {
    await kernel.dispose();
  }
}, 30_000);
