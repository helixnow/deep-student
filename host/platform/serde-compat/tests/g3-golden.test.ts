// 真实 Rust 输出 golden：G3 全量录制 A 侧（Tauri 构建）写入数据库的 JSON 列原文，
// 由 scripts/serde-audit/g3-goldens.mjs 从 ds-g3-DIFF-TRIAGE.json.gz 抽取（来源与 sha256 见 fixture 的 source/provenance）。
//
// 每个样例的输入是宿主实际会持有的值：对 Rust 文本做普通 `JSON.parse`（`85.0` 已变成 `85`、键序是 JS 对象序）。
// 期望 `toRustJson(input, schema)` 与 Rust 原文逐字节相同。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractResolver, fromContractSchema, rs, toRustJson, type RustSchema } from '../index.ts';

interface Sample { db: string; table: string; column: string; rust: string }
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__/g3-rust-samples.json'), 'utf8')) as { samples: Sample[] };
const samplesOf = (table: string, column: string) => FIXTURE.samples.filter((s) => s.table === table && s.column === column);

const REPO = join(import.meta.dirname, '../../../..');
const CONTRACTS = Object.fromEntries(['_shared.json', 'L14-qbank.json', 'L16-anki.json'].map((f) => [f, JSON.parse(readFileSync(join(REPO, 'contracts/ipc', f), 'utf8'))]));
const resolver = contractResolver(CONTRACTS);
const contract = (file: string, name: string): RustSchema => fromContractSchema({ $ref: `${file}#/$defs/${name}` }, { resolver, base: file });

function expectGolden(samples: Sample[], schema: RustSchema) {
  expect(samples.length).toBeGreaterThan(0);
  for (const sample of samples) {
    expect(toRustJson(JSON.parse(sample.rust), schema)).toBe(sample.rust);
  }
}

describe('G3 A 侧 Rust 原文 golden（手写 schema，引用 Rust 源码）', () => {
  it('files.processing_progress：ProcessingProgress.percent 是 f32（dstu-vfs/src/vfs/pdf_processing_service.rs:222-247）', () => {
    const schema = rs.struct({
      stage: rs.string,
      current_page: rs.field(rs.option(rs.usize), { skipIf: 'none' }),
      total_pages: rs.field(rs.option(rs.usize), { skipIf: 'none' }),
      percent: rs.f32,
      ready_modes: rs.vec(rs.string),
      media_type: rs.field(rs.option(rs.string), { skipIf: 'none' }),
      failed_stages: rs.field(rs.option(rs.vec(rs.value())), { skipIf: 'none' }),
    }, { renameAll: 'camelCase' });
    expectGolden(samplesOf('files', 'processing_progress'), schema);
  });

  it('anki_decks.config_json：preserve_order Value，键按插入序，值类型来自 FsrsSchedulerConfigUpdate（dstu-anki/src/fsrs_review_service.rs:480-516、3515-3628 set_field + json!(v)）', () => {
    const schema = rs.valueObject({
      new_per_day: rs.u32, reviews_per_day: rs.u32, learn_ahead_minutes: rs.u32, desired_retention: rs.f64,
      leech_threshold: rs.u32, leech_action: rs.string, enable_fuzz: rs.bool,
      learning_steps: rs.vec(rs.f64), relearning_steps: rs.vec(rs.f64), maximum_interval: rs.u32,
      day_rollover_hour: rs.u32, fsrs_params: rs.vec(rs.f32), bury_new_siblings: rs.bool,
      bury_review_siblings: rs.bool, review_order: rs.string, new_review_order: rs.string, max_answer_seconds: rs.u32,
    });
    const samples = samplesOf('anki_decks', 'config_json');
    expect(samples.some((s) => s.rust.includes('525600.0'))).toBe(true);
    expect(samples.some((s) => s.rust.includes('"fsrs_params":[0.212,'))).toBe(true);
    expectGolden(samples, schema);
  });

  it('essays.dimension_scores_json：ParsedScore / DimensionScore 的分数是 f32（dstu-tutor/src/essay_grading/types.rs:44-66）', () => {
    const DimensionScore = rs.struct({ name: rs.string, score: rs.f32, max_score: rs.f32, comment: rs.option(rs.string) });
    const ParsedScore = rs.struct({ total: rs.f32, max_total: rs.f32, grade: rs.string, dimensions: rs.vec(DimensionScore) });
    expectGolden(samplesOf('essays', 'dimension_scores_json'), ParsedScore);
  });
});

describe('G3 A 侧 Rust 原文 golden（schema 直接取自 contracts/ipc，F5 由 Rust 源码抽取）', () => {
  it('files.processing_progress ← _shared.json#/$defs/ProcessingProgress', () => {
    expectGolden(samplesOf('files', 'processing_progress'), contract('_shared.json', 'ProcessingProgress'));
  });

  it('custom_anki_templates.field_extraction_rules_json ← HashMap<String, FieldExtractionRule>（None 写 null）', () => {
    // HashMap 键序在 Rust 侧不确定：样例的键序就是该次运行的序，输入沿用它。
    expectGolden(samplesOf('custom_anki_templates', 'field_extraction_rules_json'), rs.hashMap(contract('L16-anki.json', 'FieldExtractionRule')));
  });

  it('只作命令参数的类型是反序列化形状（AnkiGenerationOptions），拒绝用于推导 Rust 输出', () => {
    const [sample] = samplesOf('document_tasks', 'anki_generation_options_json');
    expect(sample).toBeDefined();
    expect(() => toRustJson(JSON.parse(sample!.rust), contract('L16-anki.json', 'AnkiGenerationOptions'))).toThrow(/deserialization-form/);
  });
});

describe('G3 A 侧 Rust 原文 golden（serde_json::Value 原样读写）', () => {
  // exam_sheets.preview_json 的 A 侧不是 ExamSheetPreviewResult 的序列化结果（含非字段键 `options`、
  // 空 `cropped_image_path`、缺 `status`）：是 Rust 以 Value（arbitrary_precision）原样保留的旧数据。
  // 宿主必须保留数字原文才能写回同样的字节；普通 JSON.parse 会把 `50.0` 变成 `50`（B 侧正是如此）。
  const parseExact = (text: string) => JSON.parse(text, (_key, value, context?: { source?: string }) =>
    (typeof value === 'number' ? (JSON as unknown as { rawJSON(t: string): unknown }).rawJSON(context!.source!) : value));

  it('exam_sheets.preview_json：保留原文数字的 Value 往返逐字节一致', () => {
    const samples = samplesOf('exam_sheets', 'preview_json');
    expect(samples.some((s) => s.rust.includes('"resolved_bbox":{"x":50.0'))).toBe(true);
    for (const sample of samples) {
      expect(toRustJson(parseExact(sample.rust), rs.value())).toBe(sample.rust);
      expect(toRustJson(JSON.parse(sample.rust), rs.value())).not.toBe(sample.rust);
    }
  });
});
