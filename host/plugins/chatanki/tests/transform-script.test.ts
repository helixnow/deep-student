import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, statSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AnkiCard, TransformSandboxBackend, TransformSandboxEffects, TransformSandboxPolicy,
  TransformSandboxProcess, TransformSandboxSpawnRequest,
} from '../api.ts';
import {
  BoundedOutputReadError, CHATANKI_INPUT_FILE, CHATANKI_OUTPUT_FILE,
  CHATANKI_TRANSFORM_SCRIPT_CODE_MAX_CHARS, CHATANKI_TRANSFORM_SCRIPT_FIELD_MAX_CHARS,
  CHATANKI_TRANSFORM_SCRIPT_ID_MAX_CHARS, CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES,
  CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_ENTRIES, CHATANKI_TRANSFORM_SCRIPT_PROCESS_MAX,
  CHATANKI_TRANSFORM_SCRIPT_STREAM_MAX_BYTES, CHATANKI_TRANSFORM_SCRIPT_STREAM_TAIL_BYTES,
  CHATANKI_TRANSFORM_SCRIPT_TAG_MAX_CHARS, CHATANKI_TRANSFORM_SCRIPT_TAGS_LIMIT,
  CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_DEFAULT_MS, SCRIPT_ISSUE_ECHO_MAX_CHARS,
  ScriptOutputError, TransformScriptRunError, buildScriptInput, buildShellCommand,
  drainStreamTail, evaluateScriptOutput, extraReadableRootsForInterpreter, normalizeScriptSpec,
  prepareTransformJob, readOutputFileBounded, resolveInterpreter, resolveInterpreterInDirs,
  resourceLimitsToJson, runTransformScript, textHasValidClozeMarkup, transformResourceLimits,
  transformSandboxPolicy, type NormalizedTransformScript, type ScriptCardPlan,
} from '../src/transform-script.ts';
import type { TransformFields } from '../src/transform.ts';
import { setTransformFs } from '../src/transform-script-fs.ts';
import { nodeTransformFs } from '../src/transform-script-fs.node.ts';

// 端口由桌面入口注入；单元测试直接装同一份 `node:fs` 实现。
beforeAll(() => { setTransformFs(nodeTransformFs); });
afterAll(() => { setTransformFs(null); });

function makeCard(
  id: string, front: string, back: string, text: string | null, tags: string[],
): AnkiCard {
  return {
    front, back, text, tags, images: [], id, task_id: 'task-1', is_error_card: false,
    error_content: null, created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z', extra_fields: {}, template_id: 'design-swiss',
  };
}

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'chatanki-transform-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const parse = (raw: unknown): NormalizedTransformScript => normalizeScriptSpec(raw);
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const jsonBytes = (value: unknown): Uint8Array => utf8(JSON.stringify(value));

function planOk(plan: ScriptCardPlan | undefined): TransformFields {
  if (!plan || !plan.ok) throw new Error(`expected an ok plan, got ${JSON.stringify(plan)}`);
  return plan.fields;
}

function planIssue(plan: ScriptCardPlan | undefined): { code: string; detail: string } {
  if (!plan || plan.ok) throw new Error(`expected a rejected plan, got ${JSON.stringify(plan)}`);
  return plan.issue;
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

const spec = (raw: unknown): NormalizedTransformScript => normalizeScriptSpec(raw);

describe('chatanki_transform_script.rs', () => {
  it('normalize_accepts_python_and_node_with_default_timeout', () => {
    const python = spec({ language: 'python', code: 'print(1)' });
    expect(python.language).toBe('python');
    expect(python.timeoutMs).toBe(CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_DEFAULT_MS);
    const node = spec({ language: 'node', code: '1', timeoutMs: 120_000 });
    expect(node.language).toBe('node');
    expect(node.timeoutMs).toBe(120_000);
  });

  it('normalize_rejects_empty_or_oversized_code_and_unknown_language', () => {
    const empty = captureError(() => spec({ language: 'python', code: '   ' }));
    expect(String(empty)).toContain('must not be empty');
    const oversized = captureError(() => spec({
      language: 'python', code: 'x'.repeat(CHATANKI_TRANSFORM_SCRIPT_CODE_MAX_CHARS + 1),
    }));
    expect(String(oversized)).toContain('exceeds 65536');
    const unknown = captureError(() => spec({ language: 'ruby', code: 'puts 1' }));
    expect(String(unknown)).toContain('unknown variant');
  });

  it('normalize_rejects_out_of_range_timeout', () => {
    expect(String(captureError(() => spec({ language: 'python', code: '1', timeoutMs: 999 }))))
      .toContain('1000..=120000');
    expect(String(captureError(() => spec({ language: 'python', code: '1', timeoutMs: 120_001 }))))
      .toContain('1000..=120000');
  });

  it('normalize_rejects_unknown_script_keys', () => {
    const error = captureError(() => spec({ language: 'python', code: '1', allowNetwork: true }));
    expect(String(error)).toContain('unknown field');
  });

  it('input_snapshot_carries_full_text_index_and_rust_recorded_version', () => {
    const longFront = '长'.repeat(5000);
    const card = makeCard('card-1', longFront, 'A', '{{c1::x}}', ['生物']);
    const input = buildScriptInput('doc-1', [card]);
    expect(input.documentId).toBe('doc-1');
    const entry = input.cards[0];
    expect(entry?.id).toBe('card-1');
    expect(entry?.index).toBe(1);
    expect([...(entry?.front ?? '')].length).toBe(5000);
    expect(entry?.version).toBe('2026-08-24T01:00:00Z');
    expect(entry?.templateId).toBe('design-swiss');
  });

  it('output_rejects_non_json_and_missing_cards', () => {
    const cards = [makeCard('card-1', 'Q', 'A', null, [])];
    const notJson = captureError(() => evaluateScriptOutput(utf8('not json'), cards));
    expect(notJson).toBeInstanceOf(ScriptOutputError);
    expect((notJson as ScriptOutputError).kind).toBe('parse');

    const arrayRoot = captureError(() => evaluateScriptOutput(utf8('[]'), cards));
    expect((arrayRoot as ScriptOutputError).kind).toBe('schema');

    const missing = captureError(() => evaluateScriptOutput(utf8('{"stats": 1}'), cards));
    expect((missing as ScriptOutputError).detail()).toContain("missing the required 'cards'");

    const notArray = captureError(() => evaluateScriptOutput(utf8('{"cards": {}}'), cards));
    expect((notArray as ScriptOutputError).detail()).toContain('must be a JSON array');
  });

  it('output_rejects_duplicate_and_missing_ids_at_schema_level', () => {
    const cards = [makeCard('card-1', 'Q', 'A', null, [])];
    const duplicate = captureError(() => evaluateScriptOutput(
      jsonBytes({ cards: [{ id: 'card-1' }, { id: 'card-1' }] }), cards,
    ));
    expect((duplicate as ScriptOutputError).detail()).toContain('duplicate id');
    const missing = captureError(() => evaluateScriptOutput(
      jsonBytes({ cards: [{ front: 'x' }] }), cards,
    ));
    expect((missing as ScriptOutputError).detail()).toContain("missing a string 'id'");
  });

  it('output_rejects_oversized_payloads', () => {
    const cards = [makeCard('card-1', 'Q', 'A', null, [])];
    const oversized = new Uint8Array(CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES + 1).fill(0x20);
    const error = captureError(() => evaluateScriptOutput(oversized, cards));
    expect((error as ScriptOutputError).kind).toBe('too_large');
  });

  it('bounded_output_reader_accepts_exact_limit_and_rejects_limit_plus_one', () => {
    withTempDir((dir) => {
      const output = join(dir, CHATANKI_OUTPUT_FILE);
      writeFileSync(output, '12345678');
      expect(Buffer.from(readOutputFileBounded(output, 8)).toString('utf8')).toBe('12345678');
      writeFileSync(output, '123456789');
      const error = captureError(() => readOutputFileBounded(output, 8));
      expect(error).toBeInstanceOf(BoundedOutputReadError);
      expect(error).toMatchObject({ kind: 'too_large', bytes: 9, limit: 8 });
    });
  });

  it('bounded_output_reader_rejects_missing_and_non_regular_paths', () => {
    withTempDir((dir) => {
      const missing = captureError(() => readOutputFileBounded(join(dir, 'missing.json'), 8));
      expect((missing as BoundedOutputReadError).kind).toBe('missing');
      const directory = captureError(() => readOutputFileBounded(dir, 8));
      expect((directory as BoundedOutputReadError).kind).toBe('not_regular');
    });
  });

  it('stream_capture_stops_after_budget_and_keeps_bounded_tail', async () => {
    const payload = Uint8Array.from({ length: 64 }, (_, index) => index);
    const first = await drainStreamTail(streamOf(payload), 8, 32);
    expect(first.bytesRead).toBe(33);
    expect(first.truncated).toBe(true);
    expect([...first.tail]).toEqual([...payload.slice(24, 32)]);

    const second = await drainStreamTail(streamOf(payload.slice(0, 16)), 8, 32);
    expect(second.bytesRead).toBe(16);
    expect(second.truncated).toBe(false);
    expect([...second.tail]).toEqual([...payload.slice(8, 16)]);
  });

  it('unmentioned_cards_stay_unchanged_and_full_echo_is_tolerated', () => {
    const cards = [
      makeCard('card-1', 'Q1', 'A1', null, ['旧']),
      makeCard('card-2', 'Q2', 'A2', null, []),
    ];
    const evaluation = evaluateScriptOutput(jsonBytes({
      cards: [{
        id: 'card-1', index: 1, front: 'Q1', back: 'A1', text: null, tags: ['旧'],
        templateId: 'design-swiss', extraFields: {}, version: '被脚本篡改的版本，必须忽略',
      }],
    }), cards);
    expect(evaluation.unknownCardIds).toEqual([]);
    expect(planOk(evaluation.cardPlans[0])).toEqual({
      front: 'Q1', back: 'A1', text: null, tags: ['旧'],
    });
    expect(planOk(evaluation.cardPlans[1])).toEqual({
      front: 'Q2', back: 'A2', text: null, tags: [],
    });
  });

  it('output_applies_field_updates_and_ignores_script_version', () => {
    const cards = [makeCard('card-1', 'Q', 'A', null, ['草稿'])];
    const evaluation = evaluateScriptOutput(jsonBytes({
      cards: [{
        id: 'card-1', front: '新问题', tags: ['生物', '生物', ' 重点 '],
        version: '1999-01-01T00:00:00Z',
      }],
    }), cards);
    const after = planOk(evaluation.cardPlans[0]);
    expect(after.front).toBe('新问题');
    expect(after.back).toBe('A');
    expect(after.tags).toEqual(['生物', '重点']);
  });

  it('output_rejects_unknown_fields_per_card_not_batch', () => {
    const cards = [
      makeCard('card-1', 'Q1', 'A1', null, []),
      makeCard('card-2', 'Q2', 'A2', null, []),
    ];
    const evaluation = evaluateScriptOutput(jsonBytes({
      cards: [{ id: 'card-1', isErrorCard: false }, { id: 'card-2', front: '更新' }],
    }), cards);
    const issue = planIssue(evaluation.cardPlans[0]);
    expect(issue.code).toBe('unknown_output_field');
    expect(issue.detail).toContain('isErrorCard');
    expect(planOk(evaluation.cardPlans[1]).front).toBe('更新');
  });

  it('output_rejects_empty_fields_and_wrong_types', () => {
    const cards = [makeCard('card-1', 'Q', 'A', null, [])];
    expect(planIssue(evaluateScriptOutput(jsonBytes({ cards: [{ id: 'card-1', front: '  ' }] }), cards)
      .cardPlans[0]).code).toBe('empty_field');
    expect(planIssue(evaluateScriptOutput(jsonBytes({ cards: [{ id: 'card-1', back: 42 }] }), cards)
      .cardPlans[0]).code).toBe('invalid_field_type');
    expect(planIssue(evaluateScriptOutput(jsonBytes({ cards: [{ id: 'card-1', tags: ['ok', ''] }] }), cards)
      .cardPlans[0]).code).toBe('empty_field');
  });

  it('output_enforces_cloze_syntax_only_when_text_changes', () => {
    const cards = [
      makeCard('card-1', 'Q', 'A', '{{c1::旧}}', []),
      makeCard('card-2', 'Q', 'A', '{{c1::旧}}', []),
    ];
    const evaluation = evaluateScriptOutput(jsonBytes({
      cards: [
        { id: 'card-1', text: '术语无标记' },
        { id: 'card-2', text: '新 {{c2::答案::提示}} 挖空' },
      ],
    }), cards);
    expect(planIssue(evaluation.cardPlans[0]).code).toBe('invalid_cloze_text');
    expect(planOk(evaluation.cardPlans[1]).text).toBe('新 {{c2::答案::提示}} 挖空');
  });

  it('cloze_markup_validator_matches_database_semantics', () => {
    expect(textHasValidClozeMarkup('A {{c1::answer}} B')).toBe(true);
    expect(textHasValidClozeMarkup('{{c12::多位编号::hint}}')).toBe(true);
    expect(textHasValidClozeMarkup('{{c0::zero}}')).toBe(false);
    expect(textHasValidClozeMarkup('{{c1::}}')).toBe(false);
    expect(textHasValidClozeMarkup('{{color}} 假标记')).toBe(false);
    expect(textHasValidClozeMarkup('plain text')).toBe(false);
  });

  it('output_reports_unknown_snapshot_ids_v1_forbids_card_creation', () => {
    const cards = [makeCard('card-1', 'Q', 'A', null, [])];
    const evaluation = evaluateScriptOutput(jsonBytes({
      cards: [{ id: 'card-1', front: '更新' }, { id: 'card-ghost', front: '脚本试图新增' }],
    }), cards);
    expect(evaluation.unknownCardIds).toEqual(['card-ghost']);
    expect(evaluation.cardPlans).toHaveLength(1);
    expect(evaluation.cardPlans[0]?.ok).toBe(true);
  });

  it('output_enforces_script_tags_limit', () => {
    const cards = [makeCard('card-1', 'Q', 'A', null, [])];
    const tags = Array.from({ length: CHATANKI_TRANSFORM_SCRIPT_TAGS_LIMIT + 1 }, (_, index) => `tag-${index}`);
    const evaluation = evaluateScriptOutput(jsonBytes({ cards: [{ id: 'card-1', tags }] }), cards);
    expect(planIssue(evaluation.cardPlans[0]).code).toBe('tags_limit_exceeded');
  });

  it('security_output_rejects_oversized_new_field_but_allows_echo_of_existing', () => {
    const oversizedExisting = '旧'.repeat(CHATANKI_TRANSFORM_SCRIPT_FIELD_MAX_CHARS + 10);
    const cards = [
      makeCard('card-1', oversizedExisting, 'A', null, []),
      makeCard('card-2', 'Q', 'A', null, []),
    ];
    const bomb = '爆'.repeat(CHATANKI_TRANSFORM_SCRIPT_FIELD_MAX_CHARS + 1);
    const evaluation = evaluateScriptOutput(jsonBytes({
      cards: [
        { id: 'card-1', front: oversizedExisting },
        { id: 'card-2', back: bomb },
      ],
    }), cards);
    expect(evaluation.cardPlans[0]?.ok).toBe(true);
    const issue = planIssue(evaluation.cardPlans[1]);
    expect(issue.code).toBe('field_too_large');
    expect(issue.detail).toContain('character limit');
  });

  it('security_output_rejects_oversized_new_tag_but_allows_existing_echo', () => {
    const longExistingTag = '既'.repeat(CHATANKI_TRANSFORM_SCRIPT_TAG_MAX_CHARS + 5);
    const cards = [
      makeCard('card-1', 'Q', 'A', null, [longExistingTag]),
      makeCard('card-2', 'Q', 'A', null, []),
    ];
    const bombTag = '炸'.repeat(CHATANKI_TRANSFORM_SCRIPT_TAG_MAX_CHARS + 1);
    const evaluation = evaluateScriptOutput(jsonBytes({
      cards: [{ id: 'card-1', tags: [longExistingTag] }, { id: 'card-2', tags: [bombTag] }],
    }), cards);
    expect(evaluation.cardPlans[0]?.ok).toBe(true);
    expect(planIssue(evaluation.cardPlans[1]).code).toBe('tag_too_large');
  });

  it('security_output_rejects_entry_floods_at_schema_level', () => {
    const cards = [makeCard('card-1', 'Q', 'A', null, [])];
    const flood = Array.from(
      { length: CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_ENTRIES + 1 },
      (_, index) => ({ id: `forged-${index}` }),
    );
    const error = captureError(() => evaluateScriptOutput(jsonBytes({ cards: flood }), cards));
    expect((error as ScriptOutputError).kind).toBe('schema');
    expect((error as ScriptOutputError).detail()).toContain('entry limit');

    const tolerated = Array.from(
      { length: CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_ENTRIES },
      (_, index) => ({ id: `forged-${index}` }),
    );
    const evaluation = evaluateScriptOutput(jsonBytes({ cards: tolerated }), cards);
    expect(evaluation.unknownCardIds).toHaveLength(CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_ENTRIES);
  });

  it('security_output_rejects_overlong_forged_ids', () => {
    const cards = [makeCard('card-1', 'Q', 'A', null, [])];
    const forgedId = 'x'.repeat(CHATANKI_TRANSFORM_SCRIPT_ID_MAX_CHARS + 1);
    const error = captureError(() => evaluateScriptOutput(
      jsonBytes({ cards: [{ id: forgedId, front: '伪造' }] }), cards,
    ));
    expect((error as ScriptOutputError).kind).toBe('schema');
    expect((error as ScriptOutputError).detail()).toContain('character limit');
    expect((error as ScriptOutputError).detail()).not.toContain(forgedId);
  });

  it('output_reports_the_first_unknown_key_in_document_order (preserve_order, chatanki_transform_script.rs:316)', () => {
    const cards = [makeCard('card-1', 'Q', 'A', null, [])];
    const evaluation = evaluateScriptOutput(utf8('{"cards":[{"id":"card-1","zeta":1,"alpha":2}]}'), cards);
    const issue = planIssue(evaluation.cardPlans[0]);
    expect(issue.code).toBe('unknown_output_field');
    expect(issue.detail).toBe("output card contains unsupported field 'zeta' (v1 allows front/back/text/tags updates only)");
  });

  it('security_unknown_field_detail_truncates_hostile_key', () => {
    const cards = [makeCard('card-1', 'Q', 'A', null, [])];
    const hostileKey = 'k'.repeat(10_000);
    const evaluation = evaluateScriptOutput(jsonBytes({
      cards: [{ id: 'card-1', [hostileKey]: 'payload' }],
    }), cards);
    const issue = planIssue(evaluation.cardPlans[0]);
    expect(issue.code).toBe('unknown_output_field');
    expect([...issue.detail].length).toBeLessThan(300);
    expect(issue.detail).toContain('…');
    expect([...issue.detail].length).toBeLessThan(SCRIPT_ISSUE_ECHO_MAX_CHARS + 200);
  });

  it('interpreter_resolution_prefers_candidate_order_and_requires_exec_bit', () => {
    withTempDir((dir) => {
      const python = join(dir, 'python');
      writeFileSync(python, '#!/bin/sh\nexit 0\n');
      chmodSync(python, 0o755);
      expect(resolveInterpreterInDirs(['python3', 'python'], [dir])).toBe(python);
      chmodSync(python, 0o644);
      expect(resolveInterpreterInDirs(['python3', 'python'], [dir])).toBeNull();
    });
  });

  it('shell_command_quotes_paths_for_posix_and_powershell', () => {
    const interpreter = '/opt/home brew/bin/python3';
    const script = '/tmp/job dir/transform_script.py';
    expect(buildShellCommand('posix_sh', 'python', interpreter, script))
      .toBe("'/opt/home brew/bin/python3' -I '/tmp/job dir/transform_script.py'");
    expect(buildShellCommand('posix_sh', 'node', '/usr/bin/node', '/tmp/job/transform_script.js'))
      .toBe("'/usr/bin/node' '/tmp/job/transform_script.js'");
    const powershell = buildShellCommand('windows_powershell', 'python', interpreter, script);
    expect(powershell.startsWith("& '")).toBe(true);
    expect(() => buildShellCommand('unavailable', 'python', interpreter, script)).toThrow();
  });

  it('sandbox_policy_grants_job_dir_only_and_never_allows_network', () => {
    withTempDir((dir) => {
      const jobDir = join(dir, 'job');
      mkdirSync(jobDir);
      const policy = transformSandboxPolicy(jobDir, '/usr/bin/python3');
      expect(policy.allowNetwork).toBe(false);
      expect(policy.writableRoots).toEqual([jobDir]);
      expect(policy.readableRoots).toContain(jobDir);
      expect(policy.protectedReadRoots).toEqual([]);
      expect(policy.protectedWriteRoots).toEqual([]);
      expect(policy.restrictReadToRoots).toBe(true);
    });
  });

  it('resource_contract_exposes_portable_stream_file_and_process_limits', () => {
    const limits = transformResourceLimits(sandboxEffects(128));
    expect(limits.streamMaxBytes).toBe(CHATANKI_TRANSFORM_SCRIPT_STREAM_MAX_BYTES);
    expect(limits.streamTailBytes).toBe(CHATANKI_TRANSFORM_SCRIPT_STREAM_TAIL_BYTES);
    expect(limits.outputFileMaxBytes).toBe(CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES);
    expect(limits.activeProcessMax).toBe(128);

    const json = resourceLimitsToJson(limits, 30_000);
    expect(json.wallClockTimeoutMs).toBe(30_000);
    expect(json.stdoutMaxBytes).toBe(1024 * 1024);
    expect(json.stderrMaxBytes).toBe(1024 * 1024);
    expect(json.outputFileMaxBytes).toBe(32 * 1024 * 1024);
    expect(json.activeProcessesMax).toBe(128);
  });

  it('resource_contract_fails_closed_without_bounded_process_tree', () => {
    expect(String(captureError(() => transformResourceLimits(sandboxEffects(null)))))
      .toContain('active-process limit');
    expect(String(captureError(() =>
      transformResourceLimits(sandboxEffects(CHATANKI_TRANSFORM_SCRIPT_PROCESS_MAX + 1)))))
      .toContain('outside the transform script range');

    const relaxed = sandboxEffects(128);
    relaxed.processGroupIsolated = false;
    expect(String(captureError(() => transformResourceLimits(relaxed)))).toContain('process-group');

    relaxed.processGroupIsolated = true;
    relaxed.networkEnforced = false;
    expect(String(captureError(() => transformResourceLimits(relaxed)))).toContain('network isolation');
  });

  it('interpreter_under_opt_gains_top_level_readable_root', () => {
    const roots = extraReadableRootsForInterpreter('/opt/homebrew/bin/python3.12');
    expect(roots).toContain('/opt/homebrew');
  });

  it('prepare_job_writes_input_snapshot_and_script_body', () => {
    withTempDir((dir) => {
      const script: NormalizedTransformScript = {
        language: 'python', code: "print('ok')", timeoutMs: 5_000,
      };
      const input = { documentId: 'doc-1', cards: [] };
      const job = prepareTransformJob(dir, script, input);
      expect(job.jobDir.startsWith(realPath(dir))).toBe(true);
      expect(job.jobRef.startsWith('runtime-root://temp/chatanki_transform/job-')).toBe(true);
      expect(JSON.parse(readFileSync(job.inputPath, 'utf8'))).toEqual(input);
      expect(readFileSync(job.scriptPath, 'utf8')).toBe("print('ok')");
      expect(fileExists(job.outputPath)).toBe(false);
      expect(job.inputPath.endsWith(CHATANKI_INPUT_FILE)).toBe(true);
    });
  });

  it('prepare_job_keeps_full_card_snapshot_owner_only', () => {
    withTempDir((dir) => {
      const script: NormalizedTransformScript = {
        language: 'python', code: "print('ok')", timeoutMs: 5_000,
      };
      const job = prepareTransformJob(dir, script, { cards: [{ front: 'private material' }] });
      expect(modeOf(job.jobDir)).toBe(0o700);
      expect(modeOf(job.inputPath)).toBe(0o600);
      expect(modeOf(job.scriptPath)).toBe(0o600);
    });
  });

  it('security_prepare_job_canonicalizes_symlinked_temp_root', () => {
    withTempDir((real) => {
      withTempDir((holder) => {
        const link = join(holder, 'temp-root-link');
        symlinkSync(real, link);
        const script: NormalizedTransformScript = {
          language: 'python', code: "print('ok')", timeoutMs: 5_000,
        };
        const job = prepareTransformJob(link, script, { cards: [] });
        const canonicalReal = realPath(real);
        expect(job.jobDir.startsWith(canonicalReal)).toBe(true);
        expect(job.inputPath.startsWith(canonicalReal)).toBe(true);
        expect(job.outputPath.startsWith(canonicalReal)).toBe(true);
      });
    });
  });
});

// ----------------------------------------------------------------------------
// Orchestration coverage for runTransformScript. The hard sandbox itself is an
// L05 dependency (see LANE.md); this in-process backend runs the very same
// command on the host so the watchdog/cleanup/output-reading paths stay covered.
// It is test-only and intentionally grants no sandbox guarantees.
// ----------------------------------------------------------------------------

describe('runTransformScript orchestration', () => {
  it('runs a python script, returns output bytes and the job reference', async () => {
    const interpreter = resolveInterpreter('python');
    if (interpreter === null) return;
    await withTempDirAsync(async (dir) => {
      const cards = [makeCard('card-1', '术语 解释', '答案', null, [])];
      const script: NormalizedTransformScript = {
        language: 'python',
        code: [
          'import json, os',
          'with open(os.environ["CHATANKI_INPUT"], encoding="utf-8") as fh:',
          '    data = json.load(fh)',
          'out = [{"id": c["id"], "front": c["front"].replace("术语", "TERM")} for c in data["cards"]]',
          'with open(os.environ["CHATANKI_OUTPUT"], "w", encoding="utf-8") as fh:',
          '    json.dump({"cards": out}, fh, ensure_ascii=False)',
          'print("transformed", len(out))',
        ].join('\n'),
        timeoutMs: 30_000,
      };
      const result = await runTransformScript(new HostProcessBackend(), {
        tempRoot: dir, documentId: 'doc-1', cards, script,
      });
      expect(result.report.exitCode).toBe(0);
      expect(result.report.timedOut).toBe(false);
      expect(result.report.stdoutTail).toContain('transformed 1');
      expect(result.report.sandboxBackend).toBe('test_host_process');
      expect(result.jobRef.startsWith('runtime-root://temp/')).toBe(true);
      const evaluation = evaluateScriptOutput(result.output, cards);
      expect(planOk(evaluation.cardPlans[0]).front).toBe('TERM 解释');
    });
  });

  it('awaits async capability and spawn before consuming the process contract', async () => {
    await withTempDirAsync(async (dir) => {
      const cards = [makeCard('card-1', 'Q', 'A', null, [])];
      const script: NormalizedTransformScript = {
        language: 'node',
        code: [
          'const fs = require("node:fs");',
          'const input = JSON.parse(fs.readFileSync(process.env.CHATANKI_INPUT, "utf8"));',
          'const out = input.cards.map((card) => ({ id: card.id, front: "ASYNC" }));',
          'fs.writeFileSync(process.env.CHATANKI_OUTPUT, JSON.stringify({ cards: out }));',
        ].join('\n'),
        timeoutMs: 30_000,
      };
      const result = await runTransformScript(
        new AsyncTransformSandboxBackend(new HostProcessBackend()),
        { tempRoot: dir, documentId: 'doc-1', cards, script },
      );
      expect(result.report.exitCode).toBe(0);
      expect(planOk(evaluateScriptOutput(result.output, cards).cardPlans[0]).front).toBe('ASYNC');
    });
  });

  it('maps rejected async capability and spawn calls to the Rust setup boundaries', async () => {
    await withTempDirAsync(async (dir) => {
      const cards = [makeCard('card-1', 'Q', 'A', null, [])];
      const script: NormalizedTransformScript = {
        language: 'node', code: 'process.exit(0)', timeoutMs: 30_000,
      };
      const base = new HostProcessBackend();
      const capabilityFailure: TransformSandboxBackend = {
        capability: async () => { throw new Error('native probe failed'); },
        contract: () => base.contract(),
        effectReport: (policy) => base.effectReport(policy),
        spawn: (request) => base.spawn(request),
      };
      const unavailable = await captureRejection(() => runTransformScript(capabilityFailure, {
        tempRoot: dir, documentId: 'doc-1', cards, script,
      }));
      expect((unavailable as TransformScriptRunError).kind).toBe('sandbox_unavailable');
      expect((unavailable as TransformScriptRunError).detail).toContain('native probe failed');

      const spawnFailure: TransformSandboxBackend = {
        capability: () => base.capability(),
        contract: () => base.contract(),
        effectReport: (policy) => base.effectReport(policy),
        spawn: async () => { throw new Error('native spawn failed'); },
      };
      const setup = await captureRejection(() => runTransformScript(spawnFailure, {
        tempRoot: dir, documentId: 'doc-1', cards, script,
      }));
      expect((setup as TransformScriptRunError).kind).toBe('setup');
      expect((setup as TransformScriptRunError).detail)
        .toContain('Failed to spawn sandboxed transform script: native spawn failed');
    });
  });

  it('reports non-zero exits and missing output as structured failures', async () => {
    if (resolveInterpreter('python') === null) return;
    await withTempDirAsync(async (dir) => {
      const cards = [makeCard('card-1', 'Q', 'A', null, [])];
      const failing: NormalizedTransformScript = {
        language: 'python',
        code: "import sys\nsys.stderr.write('boom')\nsys.exit(3)",
        timeoutMs: 30_000,
      };
      const nonZero = await captureRejection(() => runTransformScript(new HostProcessBackend(), {
        tempRoot: dir, documentId: 'doc-1', cards, script: failing,
      }));
      expect(nonZero).toBeInstanceOf(TransformScriptRunError);
      expect((nonZero as TransformScriptRunError).kind).toBe('non_zero_exit');
      expect((nonZero as TransformScriptRunError).report?.exitCode).toBe(3);
      expect((nonZero as TransformScriptRunError).report?.stderrTail).toContain('boom');

      const silent: NormalizedTransformScript = {
        language: 'python', code: "print('forgot to write output')", timeoutMs: 30_000,
      };
      const missing = await captureRejection(() => runTransformScript(new HostProcessBackend(), {
        tempRoot: dir, documentId: 'doc-1', cards, script: silent,
      }));
      expect((missing as TransformScriptRunError).kind).toBe('output_missing');
    });
  });

  it('times out and terminates the whole process group', async () => {
    if (resolveInterpreter('python') === null) return;
    await withTempDirAsync(async (dir) => {
      const cards = [makeCard('card-1', 'Q', 'A', null, [])];
      const script: NormalizedTransformScript = {
        language: 'python', code: 'import time\ntime.sleep(600)', timeoutMs: 1_000,
      };
      const error = await captureRejection(() => runTransformScript(new HostProcessBackend(), {
        tempRoot: dir, documentId: 'doc-1', cards, script,
      }));
      expect((error as TransformScriptRunError).kind).toBe('timed_out');
      expect((error as TransformScriptRunError).report?.timedOut).toBe(true);
      expect((error as TransformScriptRunError).report?.durationMs).toBeGreaterThanOrEqual(1_000);
    });
  });

  it('rejects symlinked output without following the link target', async () => {
    if (resolveInterpreter('python') === null) return;
    await withTempDirAsync(async (dir) => {
      const cards = [makeCard('card-1', 'Q', 'A', null, [])];
      const script: NormalizedTransformScript = {
        language: 'python',
        code: 'import os\nos.symlink("/etc/passwd", os.environ["CHATANKI_OUTPUT"])',
        timeoutMs: 30_000,
      };
      const error = await captureRejection(() => runTransformScript(new HostProcessBackend(), {
        tempRoot: dir, documentId: 'doc-1', cards, script,
      }));
      const failure = error as TransformScriptRunError;
      expect(failure.kind).toBe('setup');
      expect(failure.detail).toContain('must be a regular file');
      expect(failure.detail).not.toContain('root:');
    });
  });
});

async function withTempDirAsync(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'chatanki-transform-run-'));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function captureRejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

async function* streamOf(bytes: Uint8Array, chunkSize = bytes.length || 1): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
  }
}

function sandboxEffects(activeProcessLimit: number | null): TransformSandboxEffects {
  return {
    backend: 'test_hard_sandbox', shellKind: 'posix_sh', outputEncoding: 'utf-8',
    enforced: true, networkEnforced: true, processGroupIsolated: true,
    cpuTimeLimitSeconds: 130, fileSizeLimitBytes: 4 * 1024 * 1024 * 1024,
    activeProcessLimit, readableRoots: 1, writableRoots: 1,
    protectedReadRoots: 0, protectedWriteRoots: 0,
  };
}

function realPath(path: string): string {
  return realpathSync(path);
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Mirrors L05's published async capability/spawn contract. */
class AsyncTransformSandboxBackend implements TransformSandboxBackend {
  constructor(private readonly inner: TransformSandboxBackend) {}
  async capability() { return this.inner.capability(); }
  contract() { return this.inner.contract(); }
  effectReport(policy: TransformSandboxPolicy) { return this.inner.effectReport(policy); }
  async spawn(request: TransformSandboxSpawnRequest) { return this.inner.spawn(request); }
}

class HostProcessBackend implements TransformSandboxBackend {
  capability(): { available: true } {
    return { available: true };
  }

  contract(): { backend: string; shellKind: string; outputEncoding: string } {
    return { backend: 'test_host_process', shellKind: 'posix_sh', outputEncoding: 'utf-8' };
  }

  effectReport(_policy: TransformSandboxPolicy): TransformSandboxEffects {
    return sandboxEffects(128);
  }

  spawn(request: TransformSandboxSpawnRequest): TransformSandboxProcess {
    const child = spawn('/bin/sh', ['-c', request.command], {
      cwd: request.cwd, env: request.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    const signalGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    return {
      pid: child.pid ?? -1,
      stdout: child.stdout ?? null,
      stderr: child.stderr ?? null,
      wait: () => closed,
      terminateProcessGroup: async () => { signalGroup(); },
      cleanupFinishedProcessGroup: async () => { signalGroup(); },
      cleanupResources: async () => { /* pipes close with the child */ },
    };
  }
}
