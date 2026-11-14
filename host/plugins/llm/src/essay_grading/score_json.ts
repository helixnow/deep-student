/** Rust `serde_json` spelling of essay scores (`f32` fields keep `.0`). */
import type { JsonValue } from '../../../../platform/errors/api.ts';
import { rs, toRustJson } from '../../../../platform/serde-compat/index.ts';

/** dstu-tutor essay_grading/types.rs:44 `ParsedScore`, :57 `DimensionScore`. */
const PARSED_SCORE = rs.struct({
  total: rs.f32,
  max_total: rs.f32,
  grade: rs.string,
  dimensions: rs.vec(rs.struct({ name: rs.string, score: rs.f32, max_score: rs.f32, comment: rs.option(rs.string) })),
});

/**
 * A stored `dimension_scores` Value (parsed `ParsedScore` text): typed where the shape matches,
 * any other stored JSON re-serialized as a plain Value.
 */
const STORED_PARSED_SCORE = rs.union(
  rs.valueObject({ total: rs.f32, max_total: rs.f32, dimensions: rs.vec(rs.valueObject({ score: rs.f32, max_score: rs.f32 })) }),
  rs.value(),
);

/** types.rs:10 `ScoreDimension`, :21 `GradingMode`; custom_modes.rs:31 `CustomModesConfig`. */
const CUSTOM_MODES_CONFIG = rs.struct({
  modes: rs.vec(rs.struct({
    id: rs.string, name: rs.string, description: rs.string, system_prompt: rs.string,
    score_dimensions: rs.vec(rs.struct({ name: rs.string, max_score: rs.f32, description: rs.option(rs.string) })),
    total_max_score: rs.f32, is_builtin: rs.bool, created_at: rs.string, updated_at: rs.string,
  })),
});

/** custom_modes.rs:116 `serde_json::to_string_pretty(config)`. */
export function customModesConfigJson(config: JsonValue): string {
  return toRustJson(config, CUSTOM_MODES_CONFIG, { pretty: true });
}

/** pipeline.rs:474 `serde_json::to_string(&parsed_score)`. */
export function parsedScoreJson(score: JsonValue): string {
  return toRustJson(score, PARSED_SCORE);
}

/** essay_grading/mod.rs:118 `serde_json::to_string(&essay.dimension_scores)`. */
export function storedDimensionScoresJson(value: JsonValue): string {
  return toRustJson(value, STORED_PARSED_SCORE);
}
