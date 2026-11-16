/**
 * The user profile and the consent ledger are replaced by rename while other requests read them (the manager's
 * inventory refresh, a workshop card's status poll). On Windows a rename over a file that is open fails with EPERM;
 * the writers retry (RF-W07) instead of failing a plain 停用/启用 with PROFILE_WRITE_FAILED.
 * On other platforms the rename succeeds at once and these tests simply pass.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UserProfileStore } from '../profile-store.ts';
import { CommunityConsentLedger } from '../community-consent.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dstu-profile-rename-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Holds a read handle on `path` (as a concurrent readFile does) and releases it after `ms`. */
async function holdOpen(path: string, ms: number): Promise<{ released: Promise<void> }> {
  const handle = await open(path, 'r');
  // Wrapped: an async function returning a bare promise would make the caller wait for the release.
  return { released: new Promise<void>(resolve => setTimeout(() => { void handle.close().then(resolve); }, ms)) };
}

describe('profile writers while the file is being read', () => {
  it('UserProfileStore.mutate replaces the profile once a concurrent reader lets go', async () => {
    const dir = tempDir();
    const path = join(dir, 'user.profile.json');
    await writeFile(path, `${JSON.stringify({ extends: 'official', plugins: [{ id: 'workshop.a', module: './a/index.mjs' }] }, null, 2)}\n`);
    const store = new UserProfileStore(path, join(dir, 'official.json'));
    const { revision } = await store.read();
    const { released } = await holdOpen(path, 300);
    await store.mutate(revision, file => { file.plugins[0]!.disabled = true; });
    await released;
    expect((await store.read()).file.plugins[0]).toMatchObject({ id: 'workshop.a', disabled: true });
  });

  it('CommunityConsentLedger.grant replaces the ledger once a concurrent reader lets go', async () => {
    const dir = tempDir();
    const ledger = new CommunityConsentLedger(dir);
    await ledger.grant({ id: 'workshop.a', version: '1.0.0', permissions: [] }, { trust: 'full', source: 'workshop' });
    const { released } = await holdOpen(ledger.path, 300);
    await ledger.grant({ id: 'workshop.b', version: '1.0.0', permissions: [] }, { trust: 'full', source: 'workshop' });
    await released;
    expect((await ledger.read()).map(record => record.id).sort()).toEqual(['workshop.a', 'workshop.b']);
  });
});
