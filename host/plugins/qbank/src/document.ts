import { AppError, CommandError } from '../../../platform/errors/api.ts';
import type { DraftQuestion, QuestionDocument, SourceRef } from '../api.ts';
import { validateSmiles } from './generation-validation.ts';
import { jsonValueAsF64 } from './raw-json-number.ts';

const QUESTION_TYPES = ['single_choice', 'multiple_choice', 'indefinite_choice', 'fill_blank', 'short_answer',
  'essay', 'calculation', 'proof', 'true_false', 'matching', 'ordering', 'numeric', 'other'];

function invalid(message: string): CommandError {
  return new CommandError(AppError.validation(`题目文档校验失败: ${message}`));
}

function validateRefs(refs: SourceRef[]): void {
  for (const ref of refs) {
    const bbox = ref.bbox;
    if (ref.source_id === '' || ref.page === 0 || (bbox !== null && (bbox.some(n => !Number.isFinite(n) || !(n >= 0 && n <= 1))
      || bbox[0]! >= bbox[2]! || bbox[1]! >= bbox[3]!))) {
      throw new CommandError(AppError.validation('来源定位或bbox无效'));
    }
  }
}

function validateStructured(question: DraftQuestion): void {
  const data = (question.structured_data ?? null) as Record<string, unknown> | null;
  const get = (key: string) => data?.[key];
  const failed = () => invalid(`${question.local_id} 的 structured_data 不完整或无效`);
  switch (question.question_type) {
    case 'numeric': {
      const answerValue = jsonValueAsF64(get('answer_value'));
      const tolerance = jsonValueAsF64(get('tolerance'));
      if (answerValue === null || !Number.isFinite(answerValue)
        || (tolerance !== null && (!Number.isFinite(tolerance) || tolerance < 0))) throw failed();
      return;
    }
    case 'ordering': {
      const items = get('items');
      const order = get('correct_order');
      if (!Array.isArray(items) || !Array.isArray(order)) throw failed();
      const keys = new Set(items.map(item => (item as Record<string, unknown> | null)?.key).filter((key): key is string => typeof key === 'string'));
      const chosen = new Set(order.filter((key): key is string => typeof key === 'string'));
      if (keys.size !== items.length || chosen.size !== order.length || keys.size !== chosen.size
        || [...keys].some(key => !chosen.has(key)) || keys.size < 2) throw failed();
      return;
    }
    case 'matching': {
      const left = get('left');
      const right = get('right');
      const pairs = get('pairs');
      if (!Array.isArray(left) || !Array.isArray(right) || !Array.isArray(pairs)) throw failed();
      const l = new Set(left.map(item => (item as Record<string, unknown> | null)?.key).filter((key): key is string => typeof key === 'string'));
      const r = new Set(right.map(item => (item as Record<string, unknown> | null)?.key).filter((key): key is string => typeof key === 'string'));
      if (l.size !== left.length || r.size !== right.length || pairs.length !== left.length
        || pairs.some(pair => {
          const value = (pair ?? {}) as Record<string, unknown>;
          return typeof value.left !== 'string' || !l.has(value.left)
            || typeof value.right !== 'string' || !r.has(value.right);
        })) throw failed();
      return;
    }
    default: return;
  }
}

// qbank_document.rs:117-298
export function validateDocument(doc: QuestionDocument): void {
  if (doc.schema_version !== 2 || (doc.mode !== 'extract' && doc.mode !== 'generate')) {
    throw invalid('版本或任务模式不支持');
  }
  if (!doc.questions.length) throw invalid('没有可作答题目');

  const all = new Set<string>();
  for (const id of [...doc.materials.map(m => m.local_id), ...doc.groups.map(g => g.local_id), ...doc.questions.map(q => q.local_id)]) {
    if (!id.trim() || all.has(id)) throw invalid('local_id 为空或重复');
    all.add(id);
  }
  const materials = new Set(doc.materials.map(m => m.local_id));
  const groups = new Map(doc.groups.map(group => [group.local_id, group]));
  const questions = new Map(doc.questions.map(question => [question.local_id, question]));

  for (const group of doc.groups) {
    const members = new Set<string>();
    const refs = new Set<string>();
    if (!group.question_ids.length) throw invalid('题组没有子题');
    for (const id of group.material_ids) {
      if (!materials.has(id)) {
        throw invalid(`groups[${group.local_id}].material_ids 引用了不存在的材料 ${id}；请在 materials 中提供该 local_id 的完整正文，不要删除材料引用或只重发子题`);
      }
      if (refs.has(id)) throw invalid(`groups[${group.local_id}].material_ids 重复引用材料 ${id}`);
      refs.add(id);
    }
    for (const id of group.question_ids) {
      if (members.has(id) || questions.get(id)?.group_id !== group.local_id) {
        throw invalid(`groups[${group.local_id}].question_ids 的成员 ${id} 缺失、重复或其 group_id 不一致`);
      }
      members.add(id);
    }
  }

  for (const material of doc.materials) {
    if (!material.content.trim() && !material.images.length) throw invalid('共享材料为空');
    validateRefs(material.source_refs);
  }

  for (const question of doc.questions) {
    if (question.parent_local_id != null
      && (question.parent_local_id === question.local_id || !questions.has(question.parent_local_id))) {
      throw invalid('变式父题临时身份不存在或自引用');
    }
    if (!question.content.trim() || !QUESTION_TYPES.includes(question.question_type)) {
      throw invalid('题干为空或题型无效');
    }
    if (question.group_id != null) {
      const group = groups.get(question.group_id);
      if (!group || !group.question_ids.includes(question.local_id)) {
        throw invalid(`questions[${question.local_id}].group_id=${question.group_id} 没有对应的题组成员身份`);
      }
    }
    validateRefs(question.source_refs);
    validateRefs(question.answer_source_refs);
    if (question.difficulty != null && !['easy', 'medium', 'hard', 'very_hard'].includes(question.difficulty)) {
      throw invalid('难度无效');
    }
    if (['single_choice', 'multiple_choice', 'indefinite_choice'].includes(question.question_type)) {
      const options = question.options ?? [];
      const keys = new Set<string>();
      if (options.length < 2) throw invalid('选择题至少需要两个选项');
      for (const option of options) {
        if (!option.key.trim() || !option.content.trim() || keys.has(option.key)) {
          throw invalid('选项键/内容为空或重复');
        }
        keys.add(option.key);
      }
      const answer = question.answer?.trim() ? question.answer : null;
      if (answer !== null) {
        const answers = answer.split(/[,\s|、]/u).filter(Boolean);
        let count: number;
        if (keys.has(answer)) {
          count = 1;
        } else if (answers.length > 1) {
          if (answers.some(item => !keys.has(item))) throw invalid('答案引用不存在的选项');
          count = answers.length;
        } else {
          if ([...answer].some(char => !keys.has(char))) throw invalid('答案引用不存在的选项');
          count = [...answer].length;
        }
        if (question.question_type === 'single_choice' && count !== 1) throw invalid('单选题答案必须唯一');
      }
    }
    if (question.question_type === 'true_false' && question.answer != null
      && question.answer !== 'true' && question.answer !== 'false') {
      throw invalid('判断题答案必须为true/false');
    }
    if (doc.mode === 'generate' && (!question.answer || !question.answer.trim())
      && !['matching', 'ordering', 'numeric'].includes(question.question_type)) {
      throw invalid('新命题缺少答案');
    }
    if (question.smiles != null) {
      try {
        validateSmiles(question.smiles);
      } catch (error) {
        throw invalid(error instanceof Error ? error.message : String(error));
      }
    }
    validateStructured(question);
  }
}

// qbank_document.rs:299-303
export function documentNeedsReview(doc: QuestionDocument): boolean {
  return doc.issues.length > 0 || doc.unmatched_answers.length > 0
    || doc.coverage.some(entry => (entry as Record<string, unknown> | null)?.status !== 'processed');
}
