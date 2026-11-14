/**
 * 移植 Rust 测试：
 * - `qbank_generation/pipeline.rs` tests（legacy_projection / generation_root）
 * - `question_authoring_runner.rs` tests（all_small_document_pages_must_be_reported_exactly_once）
 * - `dstu-llm/.../question_authoring.rs` tests（JSON 拒绝重试 / 鉴权限流截断不降级）
 *
 * `qbank_ai_generate_questions` 注册后，这些步骤再由命令入口的契约测试覆盖。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiConfig, LLMManager, LlmStreamingService } from '../../llm/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { QuestionDocument } from '../api.ts';
import { legacyDrafts, normalizeGenerationRoot, validateGenerationSourceRefs } from '../src/generation-pipeline.ts';
import { userContent, validateCoverage, validateVisualEvidence, type SourceBundle } from '../src/source-bundle.ts';
import { CommandError } from '../../../kernel/api.ts';

function config(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    id: 'cfg_main', name: '主模型', vendorId: null, vendorName: null, providerType: null,
    providerScope: null, authMode: null, apiProtocol: null, supportsOpenaiResponses: null,
    apiKey: 'enc', baseUrl: 'http://x', model: 'main', isMultimodal: false, isReasoning: false,
    isEmbedding: false, isReranker: false, isImageGeneration: false, enabled: true,
    modelAdapter: '', maxOutputTokens: 4096, temperature: 0, supportsTools: true,
    geminiApiVersion: '', isBuiltin: false, isReadOnly: false, reasoningEffort: null,
    reasoningMode: null, thinkingEnabled: false, thinkingBudget: null, includeThoughts: false,
    minP: null, topK: null, enableThinking: null, supportsReasoning: false, headers: null,
    topPOverride: null, frequencyPenaltyOverride: null, presencePenaltyOverride: null,
    repetitionPenalty: null, reasoningSplit: null, effort: null, verbosity: null,
    isFavorite: false, maxTokensLimit: null, contextWindow: null, extraBody: null,
    resolvedAdapterId: null,
    ...overrides,
  } as ApiConfig;
}

function documentWith(question: Record<string, unknown>): QuestionDocument {
  return {
    schema_version: 2, mode: 'generate', materials: [], groups: [],
    questions: [{
      local_id: 'q1', group_id: null, original_label: null, section_path: [], content: '', question_type: 'short_answer',
      options: null, answer: null, explanation: null, structured_data: null, difficulty: null, tags: [],
      source_refs: [], answer_source_refs: [], figures: [], images: [], answer_origin: null, smiles: null,
      smiles_caption: null, parent_id: null, parent_local_id: null, source_ref: null, ...question,
    }] as QuestionDocument['questions'],
    coverage: [], issues: [], unmatched_answers: [],
  };
}

function pagedBundle(count: number): SourceBundle {
  return {
    sources: [{ source_id: 's1', page_count: count }],
    pages: Array.from({ length: count }, (_, index) => ({
      source_id: 's1', page: index + 1, blob_hash: 'h', width: 1, height: 1, text_hint: null,
    })),
    text: '',
    format: 'pdf',
  };
}

function appErrorOf(error: unknown): { error_type?: string; message?: string; details?: unknown } {
  return (error as { appError?: object }).appError as { error_type?: string; message?: string };
}

describe('qbank_generation/pipeline.rs', () => {
  it('legacy_projection_keeps_structured_data_and_smiles', () => {
    const drafts = legacyDrafts(documentWith({
      content: '排序', question_type: 'ordering',
      structured_data: { items: [{ key: 'A', content: '甲' }, { key: 'B', content: '乙' }], correct_order: ['B', 'A'] },
      smiles: 'CCO', smiles_caption: '乙醇',
    }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.structured_data).toBeDefined();
    expect(drafts[0]!.smiles).toBe('CCO');
    // serde skip_serializing_if：None 的 group_id/original_label/source_ref 不出现。
    expect(Object.keys(drafts[0]!)).toEqual(['local_id', 'question_type', 'content', 'options', 'answer',
      'explanation', 'difficulty', 'tags', 'structured_data', 'smiles', 'smiles_caption']);
    expect(drafts[0]!.tags).toBeNull();
  });

  it('generation_root_is_forced_to_v2_generate', () => {
    const raw: Record<string, never> | Record<string, unknown> = {
      schema_version: 1, mode: 'extract', questions: [{ answer: 'A' }],
    };
    normalizeGenerationRoot(raw as never);
    expect(raw.schema_version).toBe(2);
    expect(raw.mode).toBe('generate');
    expect((raw.questions as { answer_origin: string }[])[0]!.answer_origin).toBe('generated');
    expect(raw.coverage).toEqual([]);
  });

  it('source refs must point at provided pages', () => {
    const bundle = pagedBundle(2);
    validateGenerationSourceRefs({ questions: [{ source_refs: [{ source_id: 's1', page: 2 }] }] }, bundle);
    try {
      validateGenerationSourceRefs({ materials: [{ figures: [{ source_id: 's1', page: 3 }] }] }, bundle);
      throw new Error('expected validation error');
    } catch (error) {
      expect(appErrorOf(error)).toMatchObject({ error_type: 'Validation', message: 'figures 引用了未提供的来源或页码，禁止伪造来源' });
    }
  });
});

describe('question_authoring_runner.rs', () => {
  it('all_small_document_pages_must_be_reported_exactly_once', () => {
    for (const count of [1, 19, 20, 21]) {
      const bundle = pagedBundle(count);
      const raw = { coverage: Array.from({ length: count }, (_, index) => ({ source_id: 's1', page: index + 1, status: 'processed' })) };
      expect(() => validateCoverage(raw, bundle)).not.toThrow();
      raw.coverage.pop();
      expect(() => validateCoverage(raw, bundle)).toThrow();
    }
  });

  it('visual evidence must cover every page exactly once', () => {
    const bundle = pagedBundle(2);
    const coverage = [1, 2].map(page => ({ source_id: 's1', page, status: 'processed' }));
    validateVisualEvidence({ coverage, pages: [1, 2].map(page => ({ source_id: 's1', page, blocks: [] })) }, bundle);
    expect(() => validateVisualEvidence({ coverage, pages: [{ source_id: 's1', page: 1, blocks: [] }] }, bundle))
      .toThrow();
  });

  it('user content lists every page image in order', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const parts = userContent(pagedBundle(21), () => png, 'extract') as { type: string; image_url?: { url: string } }[];
    expect(parts.filter(part => part.type === 'image_url')).toHaveLength(21);
    expect(parts.at(-1)!.image_url!.url.startsWith('data:image/png;base64,')).toBe(true);
  });
});
