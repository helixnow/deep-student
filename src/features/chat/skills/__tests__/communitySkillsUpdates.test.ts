import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  buildSkillMarketUpdateCheckResult,
  checkSkillUpdates,
  isSkillMarketVersionOutdated,
  selectOutdatedSkillMarketUpdates,
  type SkillUpdateCheckResult,
} from '../api';
import {
  formatSkillUpdateDrift,
  selectAvailableSkillUpdates,
} from '../communitySkillsUi';

describe('SkillMarket update check', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('marks outdated when remote version differs from installed', () => {
    expect(isSkillMarketVersionOutdated('1.0.0', '1.1.0')).toBe(true);
    expect(isSkillMarketVersionOutdated('1.1.0', '1.1.0')).toBe(false);
    expect(isSkillMarketVersionOutdated('1.0.0', '')).toBe(false);
    expect(isSkillMarketVersionOutdated('', '1.0.0')).toBe(true);
  });

  it('buildSkillMarketUpdateCheckResult flags outdated from detail version', () => {
    const result = buildSkillMarketUpdateCheckResult({
      skillId: 'sonoscli',
      sourceDetail: 'skill_market:sonoscli@1.0.0',
      installedVersion: '1.0.0',
      remoteVersion: '1.2.0',
    });
    expect(result).toMatchObject({
      skillId: 'sonoscli',
      checkable: true,
      updateAvailable: true,
      sourceKind: 'skill_market',
      currentVersion: '1.0.0',
      remoteVersion: '1.2.0',
      remoteSha256: null,
      error: null,
    });
  });

  it('buildSkillMarketUpdateCheckResult keeps latest when versions match', () => {
    const result = buildSkillMarketUpdateCheckResult({
      skillId: 'sonoscli',
      sourceDetail: 'skill_market:sonoscli@1.2.0',
      installedVersion: '1.2.0',
      remoteVersion: '1.2.0',
    });
    expect(result.updateAvailable).toBe(false);
    expect(result.checkable).toBe(true);
  });

  it('checkSkillUpdates surfaces skill_market outdated entries from skill_check_updates', async () => {
    const skill_marketOutdated: SkillUpdateCheckResult = {
      skillId: 'sonoscli',
      checkable: true,
      updateAvailable: true,
      sourceKind: 'skill_market',
      sourceSummary: 'skill_market:sonoscli@1.0.0',
      currentSha256: 'abc123',
      remoteSha256: null,
      currentVersion: '1.0.0',
      remoteVersion: '1.1.0',
      error: null,
    };
    const urlLatest: SkillUpdateCheckResult = {
      skillId: 'other',
      checkable: true,
      updateAvailable: false,
      sourceKind: 'url',
      sourceSummary: 'https://example.com/pkg.zip',
      currentSha256: 'aaa',
      remoteSha256: 'aaa',
      error: null,
    };
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'skill_check_updates') {
        return [skill_marketOutdated, urlLatest];
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const results = await checkSkillUpdates();
    expect(invokeMock).toHaveBeenCalledWith('skill_check_updates', { skillIds: null });
    expect(selectOutdatedSkillMarketUpdates(results)).toEqual([skill_marketOutdated]);
    expect(results.find((r) => r.sourceKind === 'skill_market')?.updateAvailable).toBe(true);
  });

  it('does not treat skill_market error rows as outdated', () => {
    const failed = buildSkillMarketUpdateCheckResult({
      skillId: 'broken',
      sourceDetail: 'skill_market:broken@1.0.0',
      installedVersion: '1.0.0',
      remoteVersion: null,
      error: 'RATE_LIMITED: …',
    });
    expect(failed.updateAvailable).toBe(false);
    expect(selectOutdatedSkillMarketUpdates([failed])).toEqual([]);
  });

  it('maps skill_market_skill_detail version into update check (handoff of detail → outdated)', async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { slug?: string }) => {
      if (cmd === 'skill_market_skill_detail') {
        expect(args?.slug).toBe('sonoscli');
        return {
          slug: 'sonoscli',
          displayName: 'Sonos CLI',
          summary: 's',
          description: 'd',
          version: '1.3.0',
          downloads: 10,
          stars: 1,
          ownerHandle: 'acme',
          ownerDisplayName: 'Acme',
        };
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const { skillMarketSkillDetail } = await import('../api');
    const detail = await skillMarketSkillDetail('sonoscli');
    const check = buildSkillMarketUpdateCheckResult({
      skillId: 'sonoscli',
      sourceDetail: 'skill_market:sonoscli@1.0.0',
      installedVersion: '1.0.0',
      remoteVersion: detail.version,
    });
    expect(check.updateAvailable).toBe(true);
    expect(check.remoteVersion).toBe('1.3.0');
    expect(selectOutdatedSkillMarketUpdates([check])).toHaveLength(1);
  });

  it('surfaces RATE_LIMITED from skill_check_updates without marking outdated', async () => {
    const rateLimited: SkillUpdateCheckResult = {
      skillId: 'sonoscli',
      checkable: true,
      updateAvailable: false,
      sourceKind: 'skill_market',
      sourceSummary: 'skill_market:sonoscli@1.0.0',
      currentSha256: 'abc123',
      remoteSha256: null,
      currentVersion: '1.0.0',
      remoteVersion: null,
      error: 'RATE_LIMITED: SkillMarket rate limit exceeded (Retry-After=30)',
    };
    invokeMock.mockResolvedValueOnce([rateLimited]);

    const results = await checkSkillUpdates(['sonoscli']);
    expect(results[0]?.error).toMatch(/^RATE_LIMITED:/);
    expect(selectOutdatedSkillMarketUpdates(results)).toEqual([]);
    expect(selectAvailableSkillUpdates(results)).toEqual([]);
  });

  it('outdated badge drift text uses versions for skill_market (not sha truncation)', () => {
    const result = buildSkillMarketUpdateCheckResult({
      skillId: 'sonoscli',
      sourceDetail: 'skill_market:sonoscli@1.0.0',
      installedVersion: '1.0.0',
      remoteVersion: '2.0.0-beta.1',
    });
    expect(result.updateAvailable).toBe(true);
    expect(formatSkillUpdateDrift(result)).toBe('1.0.0 → 2.0.0-beta.1');
    // trust 正交：outdated 行本身不携带 trust 字段
    expect(result).not.toHaveProperty('trustStatus');
  });
});
