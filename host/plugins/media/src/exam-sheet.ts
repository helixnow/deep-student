/**
 * `dstu-vision/src/exam_sheet_service.rs`: exam-name arbitration when an import
 * completes. `None` means "the caller did not intend to rename", a blank string
 * means "clear the name"; keeping the distinction stops card-only updates from
 * wiping names (识别导入完成页取消勾选题目).
 *
 * The rest of the service needs the vision database, FileManager and VFS and is
 * not migrated.
 */
import { rustTrim } from '../../../platform/util/portable.ts';

export interface ExamNameState {
  summary: string | null;
  preview: string | null;
}

function trimOwned(input: string): string | null {
  const trimmed = rustTrim(input);
  return trimmed === '' ? null : trimmed;
}

/** 按请求更新题目集名称，返回是否有变化。 */
export function applyExamNameUpdate(state: ExamNameState, requested: string | null): boolean {
  if (requested === null) return false;
  const name = trimOwned(requested);
  if (name !== null) {
    // 仅比较 summary；preview 不一致时也保持 Rust 的“无变化”语义。
    if (state.summary === name) return false;
    state.summary = name;
    state.preview = name;
    return true;
  }
  if (state.summary === null) return false;
  state.summary = null;
  state.preview = null;
  return true;
}
