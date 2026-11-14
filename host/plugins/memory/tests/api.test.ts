import { expect, it } from 'vitest';
import type { FlushExtraction, LearnerProfile } from '../api.ts';

it('published memory DTOs preserve Rust snake_case profile and nullable flush folder', () => {
  const extraction: FlushExtraction = { facts: [{ title: 'a', content: 'b', folder: null }], activities: [] };
  const profile: LearnerProfile = {
    version: 0, updated_at: '', weak_points: [], goals: [], recent_status: null,
    preferences: { explanation_style: null, language: null, pace: null, others: [] },
  };
  expect(extraction.facts[0]!.folder).toBeNull();
  expect(profile.preferences.explanation_style).toBeNull();
});
