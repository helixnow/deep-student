import { describe, expect, it } from 'vitest';
import { mergeProfileJsonForSync } from '../api.ts';
import { emptyProfile, learnerProfileFromJson, learnerProfileToJson } from '../src/learner-profile.ts';

// R4-SYNC-05: the public api.ts export L20 consumes, checked with the Rust vector
// src-tauri/src/sync_app_tests.rs:13-50 (regression_j8c_resources_data_merges_learner_profiles).
describe('memory api mergeProfileJsonForSync', () => {
  it('merges local v3 and remote v4 profiles into v5 keeping both goals', () => {
    const local = { ...emptyProfile(), version: 3, updated_at: '2026-07-19T10:00:00+00:00',
      goals: [{ goal: '本地目标', deadline: null }] };
    const remote = { ...emptyProfile(), version: 4, updated_at: '2026-07-19T11:00:00+00:00',
      goals: [{ goal: '远端目标', deadline: null }] };

    const result = mergeProfileJsonForSync(learnerProfileToJson(local), learnerProfileToJson(remote));

    expect(result).not.toBeNull();
    const merged = learnerProfileFromJson(result!)!;
    expect(merged.version).toBe(5);
    expect(merged.goals.some(goal => goal.goal === '本地目标')).toBe(true);
    expect(merged.goals.some(goal => goal.goal === '远端目标')).toBe(true);
  });

  it('returns null when either side is not a learner profile JSON', () => {
    const profile = learnerProfileToJson({ ...emptyProfile(), version: 1 });
    expect(mergeProfileJsonForSync('plain note text', profile)).toBeNull();
    expect(mergeProfileJsonForSync(profile, '{"title":"note"}')).toBeNull();
  });
});
