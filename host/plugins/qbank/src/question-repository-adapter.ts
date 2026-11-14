/**
 * Wire (`*__De`) → L11 `QuestionRepository` value adapters.
 *
 * Generated IPC types accept serde's externally tagged enum form (`{new: null}`),
 * while src-tauri 的仓储层在进入 SQL 前已归一化为字符串枚举。L11 的 conn-bound
 * API 接收归一化后的值，因此 qbank 必须在调用边界做同一转换，不能把对象直接
 * 绑定到 SQLite 参数。
 */
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { QuestionRepository } from '../../vfs-repos/api.ts';
import type {
  CreateQuestionParams, QuestionFilters, QuestionSearchFilters, UpdateQuestionParams,
} from '../api.ts';
import { toDifficulty, toQuestionType, toStatus, toSourceType } from './question-enums.ts';

type VfsFilters = Parameters<QuestionRepository['listQuestions']>[2];
type VfsSearchFilters = Parameters<QuestionRepository['searchQuestions']>[3];
type VfsCreateParams = Parameters<QuestionRepository['createQuestion']>[1];
type VfsUpdateParams = Parameters<QuestionRepository['updateQuestion']>[2];

function statuses(values: QuestionFilters['status']): VfsFilters['status'] {
  if (values == null) return null;
  return values.map(value => toStatus(value));
}
function difficulties(values: QuestionFilters['difficulty']): VfsFilters['difficulty'] {
  if (values == null) return null;
  return values.map(value => toDifficulty(value));
}
function questionTypes(values: QuestionFilters['question_type']): VfsFilters['question_type'] {
  if (values == null) return null;
  return values.map(value => toQuestionType(value));
}

export function vfsFilters(filters: QuestionFilters): VfsFilters {
  return {
    status: statuses(filters.status),
    difficulty: difficulties(filters.difficulty),
    question_type: questionTypes(filters.question_type),
    tags: filters.tags ?? null,
    search: filters.search ?? null,
    is_favorite: filters.is_favorite ?? null,
    is_bookmarked: filters.is_bookmarked ?? null,
  } as VfsFilters;
}

export function vfsSearchFilters(filters: QuestionSearchFilters): VfsSearchFilters {
  return {
    status: statuses(filters.status),
    difficulty: difficulties(filters.difficulty),
    question_type: questionTypes(filters.question_type),
    tags: filters.tags ?? null,
    search: filters.search ?? null,
    is_favorite: filters.is_favorite ?? null,
    is_bookmarked: filters.is_bookmarked ?? null,
    sort_by: filters.sort_by ?? null,
  } as VfsSearchFilters;
}

export function vfsCreateParams(params: CreateQuestionParams): VfsCreateParams {
  return {
    ...params,
    question_type: params.question_type == null ? undefined : toQuestionType(params.question_type),
    difficulty: params.difficulty == null ? undefined : toDifficulty(params.difficulty),
    source_type: params.source_type == null ? undefined : toSourceType(params.source_type),
    // IPC JSON null 在 Rust serde 中就是 None；保留题型的 stale 清理规则由 L11 处理。
    structured_data: params.structured_data == null
      ? undefined : params.structured_data as JsonValue,
  } as VfsCreateParams;
}

export function vfsUpdateParams(params: UpdateQuestionParams): VfsUpdateParams {
  const structured = params.structured_data;
  return {
    ...params,
    question_type: params.question_type == null ? undefined : toQuestionType(params.question_type),
    difficulty: params.difficulty == null ? undefined : toDifficulty(params.difficulty),
    status: params.status == null ? undefined : toStatus(params.status),
    structured_data: structured == null ? undefined : structured as JsonValue,
  } as VfsUpdateParams;
}
