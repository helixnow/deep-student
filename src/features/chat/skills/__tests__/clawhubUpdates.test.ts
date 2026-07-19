import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  buildClawhubUpdateCheckResult,
  checkSkillUpdates,
  isClawhubVersionOutdated,
  selectOutdatedClawhubUpdates,
  type SkillUpdateCheckResult,
} from '../api';
import {
  formatSkillUpdateDrift,
  selectAvailableSkillUpdates,
} from '../clawhubUi';

describe('ClawHub update check', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('marks outdated when remote version differs from installed', () => {
    expect(isClawhubVersionOutdated('1.0.0', '1.1.0')).toBe(true);
    expect(isClawhubVersionOutdated('1.1.0', '1.1.0')).toBe(false);
    expect(isClawhubVersionOutdated('1.0.0', '')).toBe(false);
    expect(isClawhubVersionOutdated('', '1.0.0')).toBe(true);
  });

  it('buildClawhubUpdateCheckResult flags outdated from detail version', () => {
    const result = buildClawhubUpdateCheckResult({
      skillId: 'sonoscli',
      sourceDetail: 'clawhub:sonoscli@1.0.0',
      installedVersion: '1.0.0',
      remoteVersion: '1.2.0',
    });
    expect(result).toMatchObject({
      skillId: 'sonoscli',
      checkable: true,
      updateAvailable: true,
      sourceKind: 'clawhub',
      currentSha256: '1.0.0',
      remoteSha256: '1.2.0',
      error: null,
    });
  });

  it('buildClawhubUpdateCheckResult keeps latest when versions match', () => {
    const result = buildClawhubUpdateCheckResult({
      skillId: 'sonoscli',
      sourceDetail: 'clawhub:sonoscli@1.2.0',
      installedVersion: '1.2.0',
      remoteVersion: '1.2.0',
    });
    expect(result.updateAvailable).toBe(false);
    expect(result.checkable).toBe(true);
  });

  it('checkSkillUpdates surfaces clawhub outdated entries from skill_check_updates', async () => {
    const clawhubOutdated: SkillUpdateCheckResult = {
      skillId: 'sonoscli',
      checkable: true,
      updateAvailable: true,
      sourceKind: 'clawhub',
      sourceSummary: 'clawhub:sonoscli@1.0.0',
      currentSha256: '1.0.0',
      remoteSha256: '1.1.0',
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
        return [clawhubOutdated, urlLatest];
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const results = await checkSkillUpdates();
    expect(invokeMock).toHaveBeenCalledWith('skill_check_updates', { skillIds: null });
    expect(selectOutdatedClawhubUpdates(results)).toEqual([clawhubOutdated]);
    expect(results.find((r) => r.sourceKind === 'clawhub')?.updateAvailable).toBe(true);
  });

  it('does not treat clawhub error rows as outdated', () => {
    const failed = buildClawhubUpdateCheckResult({
      skillId: 'broken',
      sourceDetail: 'clawhub:broken@1.0.0',
      installedVersion: '1.0.0',
      remoteVersion: null,
      error: 'RATE_LIMITED: …',
    });
    expect(failed.updateAvailable).toBe(false);
    expect(selectOutdatedClawhubUpdates([failed])).toEqual([]);
  });

  it('maps clawhub_skill_detail version into update check (handoff of detail → outdated)', async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { slug?: string }) => {
      if (cmd === 'clawhub_skill_detail') {
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

    const { clawhubSkillDetail } = await import('../api');
    const detail = await clawhubSkillDetail('sonoscli');
    const check = buildClawhubUpdateCheckResult({
      skillId: 'sonoscli',
      sourceDetail: 'clawhub:sonoscli@1.0.0',
      installedVersion: '1.0.0',
      remoteVersion: detail.version,
    });
    expect(check.updateAvailable).toBe(true);
    expect(check.remoteSha256).toBe('1.3.0');
    expect(selectOutdatedClawhubUpdates([check])).toHaveLength(1);
  });

  it('surfaces RATE_LIMITED from skill_check_updates without marking outdated', async () => {
    const rateLimited: SkillUpdateCheckResult = {
      skillId: 'sonoscli',
      checkable: true,
      updateAvailable: false,
      sourceKind: 'clawhub',
      sourceSummary: 'clawhub:sonoscli@1.0.0',
      currentSha256: '1.0.0',
      remoteSha256: null,
      error: 'RATE_LIMITED: ClawHub rate limit exceeded (Retry-After=30)',
    };
    invokeMock.mockResolvedValueOnce([rateLimited]);

    const results = await checkSkillUpdates(['sonoscli']);
    expect(results[0]?.error).toMatch(/^RATE_LIMITED:/);
    expect(selectOutdatedClawhubUpdates(results)).toEqual([]);
    expect(selectAvailableSkillUpdates(results)).toEqual([]);
  });

  it('outdated badge drift text uses versions for clawhub (not sha truncation)', () => {
    const result = buildClawhubUpdateCheckResult({
      skillId: 'sonoscli',
      sourceDetail: 'clawhub:sonoscli@1.0.0',
      installedVersion: '1.0.0',
      remoteVersion: '2.0.0-beta.1',
    });
    expect(result.updateAvailable).toBe(true);
    expect(formatSkillUpdateDrift(result)).toBe('1.0.0 → 2.0.0-beta.1');
    // trust 正交：outdated 行本身不携带 trust 字段
    expect(result).not.toHaveProperty('trustStatus');
  });
});
