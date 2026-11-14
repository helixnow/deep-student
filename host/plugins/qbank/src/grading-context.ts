/**
 * 判分上下文与提交版本快照（qbank_grading/context.rs）。
 *
 * 快照是判分版本的权威：显式 null 表示提交时字段就是空，必须覆盖 live 值；
 * 快照存在但损坏时显式报错，绝不静默退回 live 内容。
 */
import type {
  Question, QuestionImage, QuestionMaterial, QuestionOption, QuestionType, SourceRef,
} from '../api.ts';
import { questionTypeFrom } from './question-enums.ts';

export class GradingContextValidation extends Error {}

/** 进入多模态消息的一张图片（context.rs:26-31）。 */
export interface GradingImage {
  base64: string;
  mime: string;
  /** 给模型看的标签（题干配图 / 材料「…」配图 / 学生作答图 N）。 */
  label: string;
}

export interface GradingContextState {
  content: string;
  question_type: string;
  question_label: string | null;
  options: QuestionOption[] | null;
  structured_data: unknown;
  answer: string | null;
  explanation: string | null;
  materials: QuestionMaterial[];
  question_images: QuestionImage[];
  /** 取回内容后的多模态图片（材料图在前、题干图在后）。 */
  images: GradingImage[];
}

const QUESTION_TYPE_DEBUG: Record<QuestionType, string> = {
  single_choice: 'SingleChoice',
  multiple_choice: 'MultipleChoice',
  indefinite_choice: 'IndefiniteChoice',
  fill_blank: 'FillBlank',
  short_answer: 'ShortAnswer',
  essay: 'Essay',
  calculation: 'Calculation',
  proof: 'Proof',
  true_false: 'TrueFalse',
  matching: 'Matching',
  ordering: 'Ordering',
  numeric: 'Numeric',
  other: 'Other',
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(raw: string, message: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new GradingContextValidation(`${message}: ${errorText(error)}`);
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function questionOption(value: unknown): QuestionOption | null {
  const entry = object(value);
  if (entry === null || !isString(entry.key) || !isString(entry.content)) return null;
  return { key: entry.key, content: entry.content };
}

function questionImage(value: unknown): QuestionImage | null {
  const entry = object(value);
  if (entry === null || !isString(entry.id) || !isString(entry.name)
    || !isString(entry.mime) || !isString(entry.hash)) return null;
  const role = entry.role;
  if (role !== undefined && role !== null && !isString(role)) return null;
  return role === undefined ? { id: entry.id, name: entry.name, mime: entry.mime, hash: entry.hash }
    : { id: entry.id, name: entry.name, mime: entry.mime, hash: entry.hash, role };
}

function sourceRef(value: unknown): SourceRef | null {
  const entry = object(value);
  if (entry === null || !isString(entry.source_id)) return null;
  const page = entry.page;
  if (page !== undefined && page !== null && (typeof page !== 'number' || !Number.isInteger(page) || page < 0)) {
    return null;
  }
  const bbox = entry.bbox;
  if (bbox !== undefined && bbox !== null) {
    if (!Array.isArray(bbox) || bbox.length !== 4
      || bbox.some(item => typeof item !== 'number' || !Number.isFinite(item))) return null;
  }
  return { source_id: entry.source_id, page: page === undefined || page === null ? null : page,
    bbox: bbox === undefined || bbox === null ? null : bbox as number[] };
}

function questionMaterial(value: unknown): QuestionMaterial | null {
  const entry = object(value);
  if (entry === null || !isString(entry.id) || !isString(entry.content)) return null;
  const version = entry.version;
  if (typeof version !== 'number' || !Number.isInteger(version)) return null;
  const rawImages = entry.images ?? [];
  const rawRefs = entry.source_refs ?? [];
  if (!Array.isArray(rawImages) || !Array.isArray(rawRefs)) return null;
  const images: QuestionImage[] = [];
  for (const raw of rawImages) {
    const image = questionImage(raw);
    if (image === null) return null;
    images.push(image);
  }
  const sourceRefs: SourceRef[] = [];
  for (const raw of rawRefs) {
    const ref = sourceRef(raw);
    if (ref === null) return null;
    sourceRefs.push(ref);
  }
  return { id: entry.id, content: entry.content, images, source_refs: sourceRefs, version };
}

export class GradingContext {
  content: string;
  question_type: string;
  question_label: string | null;
  options: QuestionOption[] | null;
  structured_data: unknown;
  answer: string | null;
  explanation: string | null;
  materials: QuestionMaterial[];
  question_images: QuestionImage[];
  images: GradingImage[];

  constructor(state: GradingContextState) {
    this.content = state.content;
    this.question_type = state.question_type;
    this.question_label = state.question_label;
    this.options = state.options;
    this.structured_data = state.structured_data;
    this.answer = state.answer;
    this.explanation = state.explanation;
    this.materials = state.materials;
    this.question_images = state.question_images;
    this.images = state.images;
  }

  static fromQuestion(question: Question): GradingContext {
    return new GradingContext({
      content: question.content,
      question_type: QUESTION_TYPE_DEBUG[question.question_type],
      question_label: question.question_label,
      options: question.options === null ? null : [...question.options],
      structured_data: question.structured_data,
      answer: question.answer,
      explanation: question.explanation,
      materials: [],
      question_images: [...question.images],
      images: [],
    });
  }

  applySnapshots(questionSnapshot: string | null, materialSnapshot: string | null): void {
    if (questionSnapshot !== null) {
      const snapshot = object(parseJson(questionSnapshot, '作答提交快照损坏，无法复核本次判分'));
      if (snapshot !== null) {
        const content = snapshot.content;
        if (isString(content) && content.trim() !== '') this.content = content;
        if (Object.hasOwn(snapshot, 'question_label')) {
          this.question_label = isString(snapshot.question_label) ? snapshot.question_label : null;
        }
        if (Object.hasOwn(snapshot, 'question_type') && isString(snapshot.question_type)) {
          this.question_type = QUESTION_TYPE_DEBUG[questionTypeFrom(snapshot.question_type)];
        }
        if (Object.hasOwn(snapshot, 'options')) {
          if (snapshot.options === null) this.options = null;
          else if (!Array.isArray(snapshot.options)) {
            throw new GradingContextValidation('作答提交快照中的选项损坏: 期望数组或 null');
          } else {
            const options: QuestionOption[] = [];
            for (const raw of snapshot.options) {
              const option = questionOption(raw);
              if (option === null) {
                throw new GradingContextValidation('作答提交快照中的选项损坏: 选项缺少 key/content');
              }
              options.push(option);
            }
            this.options = options;
          }
        }
        if (Object.hasOwn(snapshot, 'answer')) {
          this.answer = isString(snapshot.answer) ? snapshot.answer : null;
        }
        if (Object.hasOwn(snapshot, 'explanation')) {
          this.explanation = isString(snapshot.explanation) ? snapshot.explanation : null;
        }
        if (Object.hasOwn(snapshot, 'structured_data')) {
          this.structured_data = snapshot.structured_data === undefined ? null : snapshot.structured_data;
        }
        if (Object.hasOwn(snapshot, 'images')) {
          if (snapshot.images === null) this.question_images = [];
          else if (!Array.isArray(snapshot.images)) {
            throw new GradingContextValidation('作答提交快照中的题目图片损坏: 期望数组或 null');
          } else {
            const images: QuestionImage[] = [];
            for (const raw of snapshot.images) {
              const image = questionImage(raw);
              if (image === null) {
                throw new GradingContextValidation('作答提交快照中的题目图片损坏: 图片字段缺失');
              }
              images.push(image);
            }
            this.question_images = images;
          }
        }
      }
    }
    if (materialSnapshot !== null) {
      const snapshot = parseJson(materialSnapshot, '作答材料快照损坏，无法复核本次判分');
      let value: unknown;
      if (snapshot === null) value = null;
      else if (Array.isArray(snapshot)) value = snapshot;
      else if (object(snapshot) !== null) value = object(snapshot)!.materials ?? null;
      else throw new GradingContextValidation('作答材料快照内容损坏: 期望数组或 {materials:[]} 对象');
      if (value === null) {
        this.materials = [];
      } else if (!Array.isArray(value)) {
        throw new GradingContextValidation('作答材料快照内容损坏: materials 不是数组');
      } else {
        const materials: QuestionMaterial[] = [];
        for (const raw of value) {
          const material = questionMaterial(raw);
          if (material === null) {
            throw new GradingContextValidation('作答材料快照内容损坏: 材料字段缺失');
          }
          materials.push(material);
        }
        this.materials = materials;
      }
    }
  }
}

/** 提交时的题目版本快照（question_snapshot_json）。 */
export function questionSnapshotJson(question: Question): Record<string, unknown> {
  return {
    id: question.id,
    exam_id: question.exam_id,
    question_label: question.question_label,
    content: question.content,
    question_type: question.question_type,
    options: question.options,
    answer: question.answer,
    explanation: question.explanation,
    structured_data: question.structured_data,
    images: question.images,
    source_ref: question.source_ref,
    updated_at: question.updated_at,
  };
}

/** 提交时的材料版本快照（material_snapshot_json）。 */
export function materialSnapshotJson(materials: QuestionMaterial[]): QuestionMaterial[] {
  return materials.map(material => ({
    id: material.id, content: material.content, images: material.images,
    source_refs: material.source_refs, version: material.version,
  }));
}
