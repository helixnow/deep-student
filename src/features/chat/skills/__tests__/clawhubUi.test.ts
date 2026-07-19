import { describe, expect, it } from 'vitest';
import {
  classifyClawHubSearchError,
  formatSkillUpdateDrift,
  isOutdatedUpdateRow,
  resolveClawHubSearchSuccess,
  selectAvailableSkillUpdates,
} from '../clawhubUi';
import type { SkillUpdateCheckResult } from '../api';

const sampleCard = {
  slug: 'sonoscli',
  displayName: 'Sonoscli',
  summary: 's',
  version: '1.0.0',
  downloads: 1,
  ownerHandle: 'acme',
  stars: 0,
};

describe('ClawHub search UI state machine helpers', () => {
  it('classifies RATE_LIMITED separately from network errors', () => {
    expect(
      classifyClawHubSearchError(
        new Error('RATE_LIMITED: ClawHub rate limit exceeded (Retry-After=30)'),
      ),
    ).toBe('rate_limited');
    expect(classifyClawHubSearchError('rate limit exceeded')).toBe('rate_limited');
    expect(classifyClawHubSearchError(new Error('error sending request for url'))).toBe(
      'network_error',
    );
    expect(classifyClawHubSearchError(new Error('Failed to fetch'))).toBe('network_error');
  });

  it('treats empty item lists as empty, not success', () => {
    expect(resolveClawHubSearchSuccess([])).toBe('empty');
    expect(resolveClawHubSearchSuccess([sampleCard])).toBe('success');
  });

  it('never marks error / rate-limit rows as outdated', () => {
    const outdated: SkillUpdateCheckResult = {
      skillId: 'sonoscli',
      checkable: true,
      updateAvailable: true,
      sourceKind: 'clawhub',
      sourceSummary: 'clawhub:sonoscli@1.0.0',
      currentSha256: '1.0.0',
      remoteSha256: '1.1.0',
      error: null,
    };
    const rateLimited: SkillUpdateCheckResult = {
      ...outdated,
      skillId: 'limited',
      updateAvailable: true, // 即使错误地同时置位，也应被过滤
      error: 'RATE_LIMITED: …',
    };
    const latest: SkillUpdateCheckResult = {
      ...outdated,
      skillId: 'latest',
      updateAvailable: false,
      remoteSha256: '1.0.0',
    };

    expect(isOutdatedUpdateRow(outdated)).toBe(true);
    expect(isOutdatedUpdateRow(rateLimited)).toBe(false);
    expect(selectAvailableSkillUpdates([outdated, rateLimited, latest])).toEqual([outdated]);
  });

  it('formats clawhub drift as full versions, url as sha prefix', () => {
    expect(
      formatSkillUpdateDrift({
        skillId: 'sonoscli',
        checkable: true,
        updateAvailable: true,
        sourceKind: 'clawhub',
        sourceSummary: 'clawhub:sonoscli@1.0.0',
        currentSha256: '1.0.0',
        remoteSha256: '1.2.0',
        error: null,
      }),
    ).toBe('1.0.0 → 1.2.0');

    const sha = 'abcdef0123456789'.repeat(4);
    expect(
      formatSkillUpdateDrift({
        skillId: 'pkg',
        checkable: true,
        updateAvailable: true,
        sourceKind: 'url',
        sourceSummary: 'https://example.com/a.zip',
        currentSha256: sha,
        remoteSha256: `ffff${sha.slice(4)}`,
        error: null,
      }),
    ).toBe(`${sha.slice(0, 12)} → ffff${sha.slice(4, 12)}`);
  });
});
