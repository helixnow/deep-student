import { describe, expect, it } from 'vitest';
import { skillMarketVersionOutdated } from '../src/skill-market.ts';
import {
  isRefetchableKind, isValidSkillId, parseStoredProvenance, refetchPackageBytes,
  resolveSkillMarketIdentity, type StoredProvenance,
} from '../src/skill-updates.ts';
import { buildZip, readZipEntries } from '../src/zip.ts';

describe('skill_updates.rs', () => {
  it('provenance_json_roundtrip_matches_installer_shape', () => {
    const raw = `{
      "sourceKind": "url",
      "sourceDetail": "https://example.com/pkg.zip",
      "packageSha256": "abc",
      "riskLevel": "low",
      "installedAt": "2026-07-18T00:00:00Z",
      "sessionId": "sess_x"
    }`;
    const parsed = parseStoredProvenance(raw);
    expect(parsed.sourceKind).toBe('url');
    expect(parsed.sourceDetail).toBe('https://example.com/pkg.zip');
    expect(parsed.packageSha256).toBe('abc');
  });

  it('skill_id_validation_rejects_path_like_ids', () => {
    expect(isValidSkillId('pdf-tools')).toBe(true);
    expect(isValidSkillId('skill_1')).toBe(true);
    expect(isValidSkillId('')).toBe(false);
    expect(isValidSkillId('../evil')).toBe(false);
    expect(isValidSkillId('a/b')).toBe(false);
  });

  it('skill_market_provenance_identity_prefers_explicit_fields', () => {
    const provenance = {
      sourceKind: 'skill_market',
      sourceDetail: 'skill_market:old-slug@0.9.0',
      packageSha256: 'abc',
      riskLevel: 'low',
      installedAt: '',
      sessionId: '',
      marketSlug: 'sonoscli',
      marketVersion: '1.0.0',
    };
    const [slug, version] = resolveSkillMarketIdentity(provenance);
    expect(slug).toBe('sonoscli');
    expect(version).toBe('1.0.0');
  });

  it('skill_market_is_refetchable_kind', () => {
    expect(isRefetchableKind('skill_market')).toBe(true);
    expect(isRefetchableKind('url')).toBe(true);
    expect(isRefetchableKind('runtime_path')).toBe(false);
  });

  it('skill_market_provenance_json_roundtrip_keeps_version_fields', () => {
    const raw = `{
      "sourceKind": "skill_market",
      "sourceDetail": "skill_market:sonoscli@1.0.0",
      "packageSha256": "abc",
      "riskLevel": "low",
      "installedAt": "2026-07-18T00:00:00Z",
      "sessionId": "skills_management",
      "marketSlug": "sonoscli",
      "marketVersion": "1.0.0"
    }`;
    const parsed = parseStoredProvenance(raw);
    expect(parsed.sourceKind).toBe('skill_market');
    expect(parsed.marketSlug).toBe('sonoscli');
    expect(parsed.marketVersion).toBe('1.0.0');
    expect(skillMarketVersionOutdated(parsed.marketVersion ?? '', '1.1.0')).toBe(true);
  });

  it('tap_refetch_repacks_through_worker_and_returns_canonical_bytes', async () => {
    const repoZip = buildZip([
      {
        name: 'acme-skills-abc1234/skills/demo/SKILL.md',
        bytes: Buffer.from('---\nname: demo\n---\nbody\n'),
      },
      {
        name: 'acme-skills-abc1234/skills/demo/references/guide.md',
        bytes: Buffer.from('guide'),
      },
    ]);
    const provenance: StoredProvenance = {
      sourceKind: 'tap',
      sourceDetail: 'https://codeload.github.com/acme/skills/zip/abc1234#skills/demo',
      packageSha256: 'a'.repeat(64),
      riskLevel: 'low',
      installedAt: '2026-07-18T00:00:00Z',
      sessionId: 'skills_management',
    };
    const result = await refetchPackageBytes(
      provenance,
      () => { throw new Error('market client must not be used for a tap source'); },
      () => null,
      { warn: () => undefined },
      async () => [repoZip, 'https://codeload.github.com/acme/skills/zip/abc1234'],
    );
    expect(readZipEntries(result.bytes).map(entry => entry.name).sort())
      .toEqual(['demo/SKILL.md', 'demo/references/guide.md']);
  });
});
