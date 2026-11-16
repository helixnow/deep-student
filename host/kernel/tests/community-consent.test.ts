import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalPermissions, CommunityConsentLedger, permissionsDigest, releaseContentDigest } from '../community-consent.ts';

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

describe('consent bound to release content', () => {
  let dir: string;
  let ledger: CommunityConsentLedger;
  const subject = { id: 'community.example', version: '1.0.0', permissions: ['service:log'] };
  const a = releaseContentDigest({ 'package.json': '1'.repeat(64), 'index.mjs': '2'.repeat(64) });
  const b = releaseContentDigest({ 'package.json': '1'.repeat(64), 'index.mjs': '3'.repeat(64) });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'community-consent-content-'));
    ledger = new CommunityConsentLedger(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('digests a release by its locked files, independent of key order', () => {
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(releaseContentDigest({ 'index.mjs': '2'.repeat(64), 'package.json': '1'.repeat(64) })).toBe(a);
    expect(b).not.toBe(a);
    expect(releaseContentDigest({ 'package.json': '1'.repeat(64) })).not.toBe(a);
  });

  it('matches the approved content after reopening and rejects any other content', async () => {
    const record = await ledger.grant({ ...subject, contentDigest: a }, { trust: 'full', source: 'workshop' });
    expect(record.contentDigest).toBe(a);
    const reopened = new CommunityConsentLedger(dir);
    expect(await reopened.evaluate({ ...subject, contentDigest: a })).toMatchObject({ matched: true, reason: null, trust: 'full', source: 'workshop' });
    expect(await reopened.evaluate({ ...subject, contentDigest: b })).toMatchObject({ matched: false, code: 'CONSENT_REQUIRED', reason: 'content' });
    // A subject whose content cannot be identified is not covered by a content-bound consent.
    expect(await reopened.evaluate(subject)).toMatchObject({ matched: false, code: 'CONSENT_REQUIRED', reason: 'content' });
  });

  it('reports version and permission changes before content, and keeps unbound records matching as before', async () => {
    await ledger.grant({ ...subject, contentDigest: a });
    expect(await ledger.evaluate({ ...subject, version: '1.0.1', contentDigest: a })).toMatchObject({ matched: false, reason: 'version' });
    expect(await ledger.evaluate({ ...subject, permissions: ['service:log', 'service:network'], contentDigest: a })).toMatchObject({ matched: false, reason: 'permissions' });
    await ledger.grant(subject);
    expect((await ledger.read())[0]).not.toHaveProperty('contentDigest');
    expect(await ledger.evaluate({ ...subject, contentDigest: b })).toMatchObject({ matched: true });
  });

  it('restores a bound record unchanged and refuses a malformed digest', async () => {
    const record = await ledger.grant({ ...subject, contentDigest: a }, { trust: 'full', source: 'workshop' });
    await ledger.grant({ ...subject, contentDigest: b });
    await ledger.restore(subject.id, record);
    expect(await ledger.read()).toEqual([record]);
    await expect(ledger.grant({ ...subject, contentDigest: 'not-a-digest' })).rejects.toThrow('invalid consent content digest');
    await writeFile(ledger.path, JSON.stringify({ schemaVersion: 1, records: [{ ...record, contentDigest: 'ABC' }] }));
    await expect(ledger.read()).rejects.toThrow('invalid consent content digest');
  });
});
