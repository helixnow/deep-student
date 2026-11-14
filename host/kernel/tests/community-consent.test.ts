import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalPermissions, CommunityConsentLedger, permissionsDigest } from '../community-consent.ts';

describe('RF-W32-community-consent-ledger: K3 Host-owned community consent ledger', () => {
  let dir: string;
  let ledger: CommunityConsentLedger;
  const subject = { id: 'community.example', version: '1.0.0', permissions: ['service:log', 'service:storage'] };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'community-consent-'));
    ledger = new CommunityConsentLedger(dir);
  });
  afterEach(async () => {
    await chmod(dir, 0o700);
    await rm(dir, { recursive: true, force: true });
  });

  it('canonicalizes sets without changing permission identity', () => {
    expect(canonicalPermissions(['service:z', 'service:a', 'service:z'])).toEqual(['service:a', 'service:z']);
    expect(permissionsDigest(['service:a', 'service:z'])).toBe(permissionsDigest(['service:z', 'service:a', 'service:a']));
    expect(permissionsDigest(['service:A'])).not.toBe(permissionsDigest(['service:a']));
    expect(() => canonicalPermissions([' service:a'])).toThrow();
  });

  it('does not infer consent from profile metadata or a ledger placed under plugins', async () => {
    await mkdir(join(dir, 'plugins'));
    await writeFile(join(dir, 'plugins', 'user.profile.json'), JSON.stringify({ plugins: [{ ...subject, consent: true }] }));
    await writeFile(join(dir, 'plugins', 'community-consent.json'), JSON.stringify({ schemaVersion: 1, records: [{ ...subject, permissionsDigest: permissionsDigest(subject.permissions) }] }));
    expect(ledger.path).toBe(join(dir, 'community-consent.json'));
    expect(await ledger.evaluate(subject)).toMatchObject({ matched: false, code: 'CONSENT_REQUIRED', reason: 'missing', grantedPermissions: [] });
  });

  it('persists a private real file and matches after reopening with reordered permissions', async () => {
    await ledger.grant(subject);
    const reopened = new CommunityConsentLedger(dir);
    expect(await reopened.evaluate({ ...subject, permissions: [...subject.permissions].reverse() })).toMatchObject({
      matched: true, code: null, reason: null, grantedPermissions: subject.permissions,
    });
    expect((await stat(ledger.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['community-consent.json']);
  });

  it('requires consent for another ID and a changed version', async () => {
    await ledger.grant(subject);
    expect(await ledger.evaluate({ ...subject, id: 'community.other' })).toMatchObject({ reason: 'missing', grantedPermissions: [] });
    expect(await ledger.evaluate({ ...subject, version: '1.0.1' })).toMatchObject({
      matched: false, code: 'CONSENT_REQUIRED', reason: 'version', grantedPermissions: subject.permissions,
    });
  });

  it.each([
    { permissions: [...subject.permissions, 'service:network'], intersection: subject.permissions },
    { permissions: ['service:log'], intersection: ['service:log'] },
    { permissions: ['service:network'], intersection: [] },
  ])('requires consent on permission change: $permissions', async ({ permissions, intersection }) => {
    await ledger.grant(subject);
    expect(await ledger.evaluate({ ...subject, permissions })).toMatchObject({
      matched: false, code: 'CONSENT_REQUIRED', reason: 'permissions', grantedPermissions: intersection,
    });
  });

  it('reconsent replaces old permissions instead of accumulating grants', async () => {
    await ledger.grant(subject);
    await ledger.grant({ ...subject, version: '2.0.0', permissions: ['service:log'] });
    expect(await ledger.evaluate(subject)).toMatchObject({ code: 'CONSENT_REQUIRED', grantedPermissions: ['service:log'] });
    expect(await ledger.read()).toHaveLength(1);
  });

  it('RF-P1-plugin-trust: defaults legacy records to restricted/package and persists explicit workshop trust', async () => {
    await writeFile(ledger.path, JSON.stringify({ schemaVersion: 1, records: [{ ...subject, permissionsDigest: permissionsDigest(subject.permissions) }] }));
    expect(await ledger.evaluate(subject)).toMatchObject({ matched: true, trust: 'restricted', source: 'package' });
    await ledger.grant(subject, { trust: 'full', source: 'workshop' });
    expect(await new CommunityConsentLedger(dir).evaluate(subject)).toMatchObject({ matched: true, trust: 'full', source: 'workshop' });
    await ledger.grant({ ...subject, version: '2.0.0' });
    expect(await ledger.evaluate({ ...subject, version: '2.0.0' })).toMatchObject({ trust: 'full', source: 'workshop' });
    expect(await ledger.evaluate(subject)).toMatchObject({ matched: false, reason: 'version' });
  });

  it('preserves different IDs across concurrent Host instances', async () => {
    await Promise.all([
      ledger.grant(subject),
      new CommunityConsentLedger(dir).grant({ ...subject, id: 'community.other' }),
    ]);
    expect((await ledger.read()).map(r => r.id).sort()).toEqual(['community.example', 'community.other']);
  });

  it('rejects invalid JSON and corrupt permission digests without overwriting evidence', async () => {
    await writeFile(ledger.path, '{broken');
    await expect(ledger.evaluate(subject)).rejects.toThrow();
    await expect(ledger.grant(subject)).rejects.toThrow();
    expect(await readFile(ledger.path, 'utf8')).toBe('{broken');
    await writeFile(ledger.path, JSON.stringify({ schemaVersion: 1, records: [{ ...subject, permissionsDigest: 'wrong' }] }));
    await expect(ledger.evaluate(subject)).rejects.toThrow('invalid community consent record');
  });

  it('a real persistence failure keeps prior consent and does not poison subsequent writes', async () => {
    await ledger.grant(subject);
    const before = await readFile(ledger.path, 'utf8');
    await chmod(dir, 0o500);
    try {
      await expect(ledger.grant({ ...subject, permissions: [...subject.permissions, 'service:network'] })).rejects.toThrow();
      expect(await readFile(ledger.path, 'utf8')).toBe(before);
      expect(await ledger.evaluate({ ...subject, permissions: ['service:network'] })).toMatchObject({ code: 'CONSENT_REQUIRED', grantedPermissions: [] });
    } finally {
      await chmod(dir, 0o700);
    }
    await ledger.grant({ ...subject, version: '2.0.0' });
    expect((await ledger.evaluate({ ...subject, version: '2.0.0' })).matched).toBe(true);
    expect(await readdir(dir)).toEqual(['community-consent.json']);
  });
});
