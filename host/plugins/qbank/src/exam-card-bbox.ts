/**
 * `ExamCardBBox`（dstu-core/src/models.rs:300-305）四个字段都是 f32：serde 按 f32 最短表示输出，
 * 整数值带 `.0`（`0.0`、`50.0`），不是 JS number 经 `JSON.stringify` 得到的 `0`/`50`。
 */
import type { JsonValue } from '../../../platform/errors/api.ts';
import { f32Atom } from '../../../platform/serde-compat/index.ts';

export interface ExamCardBBox { x: number; y: number; width: number; height: number }

/** `serde_json::to_value(&ExamCardBBox)`. */
export function examCardBBoxJson(bbox: ExamCardBBox): JsonValue {
  return {
    x: f32Atom(bbox.x), y: f32Atom(bbox.y), width: f32Atom(bbox.width), height: f32Atom(bbox.height),
  } as unknown as JsonValue;
}

/** `ExamCardBBox::default()` 的 serde 输出。 */
export function defaultExamCardBBoxJson(): JsonValue {
  return examCardBBoxJson({ x: 0, y: 0, width: 0, height: 0 });
}
