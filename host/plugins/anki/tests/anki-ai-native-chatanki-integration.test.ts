/**
 * `tests/anki_ai_native_integration.rs` 第 1-4 组：transform / script / plan_route /
 * analyze / retemplate 策略解析。
 *
 * 被测实现由 L24-chatanki 持有（纯函数），本 lane 只按原用例标题与断言移植。
 * L24 已在 `api.ts` 发布这些纯函数，测试只消费公开符号，不引用其实现文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import type { VfsContextRefData } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import {
  ExpectedVersionsMismatch,
  InvalidPatternError,
  TransformSelectionError,
  applyTransformOps,
  buildAnalyzeOutput,
  buildScriptInput,
  changedFieldNames,
  checkExpectedVersions,
  compileTransformOps,
  evaluateScriptOutput,
  normalizeTransformArgs,
  parseChatAnkiRetemplateStrategy,
  parseRoutePlanResponse,
  parseTransformArgs,
  planTransformOps,
  resolveInterpreterInDirs,
  resolveRouteDecision,
  routePlanIsConfident,
  selectTransformCards,
  textHasValidClozeMarkup,
  transformFieldsAreValid,
  transformFieldsFromCard,
  transformSandboxPolicy,
  type ChatAnkiCompiledRegex,
  type ChatAnkiNativeRegex,
  type ChatAnkiRegexMatch,
  type ChatAnkiRoute,
  type NormalizedTransformOp,
  type RouteDecision,
  type RoutePlan,
  type ScriptCardPlan,
  type TransformCardPlan,
  type TransformFields,
} from '../../chatanki/api.ts';

/** L24 测试用 Rust-regex 替身（与本 lane 无关；本文件只验证 L24 纯函数契约）。 */
class NativeRegexDouble implements ChatAnkiNativeRegex {
  compile(pattern: string): ChatAnkiCompiledRegex {
    let source = pattern;
    let flags = 'gu';
    let cursor = 0;
    while (source.startsWith('(?', cursor)) {
      const end = source.indexOf(')', cursor);
      if (end === -1) break;
      const body = source.slice(cursor + 2, end);
      if (!/^[imsUx-]+$/u.test(body)) break;
      for (const flag of body) {
        if (flag === 'U' || flag === 'x') {
          throw new Error(`unsupported inline flag \`${flag}\` in pattern`);
        }
        if (flag === '-') {
          flags = flags.replace(/[ims]/gu, '');
          continue;
        }
        if (flag === 'u') continue;
        if (!flags.includes(flag)) flags += flag;
      }
      cursor = end + 1;
    }
    source = source.slice(cursor).replace(/\(\?P</gu, '(?<');
    const regex = new RegExp(source, flags);
    return {
      execAll(text: string): ChatAnkiRegexMatch[] {
        const matches: ChatAnkiRegexMatch[] = [];
        for (const match of text.matchAll(regex)) {
          const start = match.index ?? 0;
          matches.push({
            start,
            end: start + match[0].length,
            text: match[0],
            captures: [...match],
            named: { ...(match.groups ?? {}) },
          });
        }
        return matches;
      },
    };
  }
}

const nativeRegex = new NativeRegexDouble();

function makeCard(
  id: string,
  front: string,
  back: string,
  text: string | null,
  tags: string[],
): AnkiCard {
  return {
    front,
    back,
    text,
    tags,
    images: [],
    id,
    task_id: 'task-r4',
    is_error_card: false,
    error_content: null,
    created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z',
    extra_fields: {},
    template_id: null,
  };
}

function makeRef(name: string, type: 'file' | 'image'): VfsContextRefData['refs'][number] {
  return {
    sourceId: `src-${name}`,
    resourceHash: 'hash',
    type,
    name,
    resourceId: null,
    snippet: null,
    injectModes: null,
  };
}

function refData(files: number, images: number): VfsContextRefData {
  const refs: VfsContextRefData['refs'] = [];
  for (let i = 0; i < files; i += 1) refs.push(makeRef(`file-${i}`, 'file'));
  for (let i = 0; i < images; i += 1) refs.push(makeRef(`img-${i}`, 'image'));
  return { totalCount: refs.length, refs, truncated: false };
}

function parseTransform(raw: unknown) {
  return normalizeTransformArgs(parseTransformArgs(raw));
}

function afterPlan(plan: TransformCardPlan): TransformFields {
  if (plan.kind !== 'after') throw new Error(`expected after plan, got ${plan.kind}`);
  return plan.fields;
}

describe('tests/anki_ai_native_integration.rs::chatanki transform/script/route', () => {
  // ---------------------------------------------------------------- transform ops

  it('transform_ops_dry_run_end_to_end_produces_per_card_plans', () => {
    const request = parseTransform({
      documentId: 'doc-r4',
      transform: {
        ops: [
          { op: 'regex_replace', field: 'back', pattern: '(\\d+)ms', replacement: '$1 毫秒' },
          { op: 'tag_add', tags: ['性能'] },
        ],
      },
    });
    expect(request.mode).toBe('dry_run');
    expect(request.expectedVersions).toEqual({});

    const cards = [
      makeCard('card-1', 'RTT 是什么？', '往返约 30ms', null, []),
      makeCard('card-2', '无数字卡', '纯文本答案', null, ['性能']),
    ];
    const selected = selectTransformCards(cards, request.selection);
    expect(selected.length).toBe(2);

    expect(request.ops).not.toBeNull();
    const compiled = compileTransformOps(request.ops!, nativeRegex);
    const plans = planTransformOps(compiled, selected);
    expect(plans.length).toBe(2);

    const after1 = afterPlan(plans[0]!);
    expect(after1.back).toBe('往返约 30 毫秒');
    expect(after1.tags).toEqual(['性能']);
    expect(changedFieldNames(transformFieldsFromCard(selected[0]!), after1)).toEqual(['back', 'tags']);

    // 第二张卡 regex 不命中、tag 已存在 → 无变更（幂等）
    const after2 = afterPlan(plans[1]!);
    expect(after2).toEqual(transformFieldsFromCard(selected[1]!));
    expect(changedFieldNames(transformFieldsFromCard(selected[1]!), after2)).toEqual([]);
  });

  it('transform_ops_apply_enforces_expected_versions_cas_contract', () => {
    expect(() =>
      parseTransform({
        documentId: 'doc-r4',
        mode: 'apply',
        transform: { ops: [{ op: 'tag_add', tags: ['x'] }] },
      }),
    ).toThrow(/requires expectedVersions/u);

    const request = parseTransform({
      documentId: 'doc-r4',
      mode: 'apply',
      selection: { cardIds: ['card-1', 'card-2'] },
      expectedVersions: { 'card-1': 'v1', 'card-2': 'v2' },
      transform: { ops: [{ op: 'tag_add', tags: ['复习'] }] },
    });
    expect(request.mode).toBe('apply');

    const selectedIds = ['card-1', 'card-2'];
    expect(() => checkExpectedVersions(selectedIds, request.expectedVersions)).not.toThrow();

    const skewed: Record<string, string> = { ...request.expectedVersions };
    delete skewed['card-2'];
    skewed['card-ghost'] = 'v9';
    let mismatch: ExpectedVersionsMismatch | null = null;
    try {
      checkExpectedVersions(selectedIds, skewed);
    } catch (error) {
      if (!(error instanceof ExpectedVersionsMismatch)) throw error;
      mismatch = error;
    }
    expect(mismatch).not.toBeNull();
    expect(mismatch!.missingVersionIds).toEqual(['card-2']);
    expect(mismatch!.unexpectedVersionIds).toEqual(['card-ghost']);
  });

  it('transform_selection_reports_missing_ids_and_honours_filters', () => {
    const errorCard = { ...makeCard('card-err', '损坏', '损坏', null, []), is_error_card: true };
    const cards = [makeCard('card-1', 'Q', 'A', null, []), errorCard];

    let missing: TransformSelectionError | null = null;
    try {
      selectTransformCards(cards, { kind: 'cards', cardIds: ['card-1', 'card-ghost'] });
    } catch (error) {
      if (!(error instanceof TransformSelectionError)) throw error;
      missing = error;
    }
    expect(missing).not.toBeNull();
    expect(missing!.missingCards).toEqual(['card-ghost']);

    const request = parseTransform({
      documentId: 'doc-r4',
      selection: { filter: 'error_only' },
      transform: { ops: [{ op: 'tag_add', tags: ['诊断'] }] },
    });
    const errorsOnly = selectTransformCards(cards, request.selection);
    expect(errorsOnly.length).toBe(1);
    expect(errorsOnly[0]!.id).toBe('card-err');
  });

  it('transform_ops_invalid_pattern_rejects_whole_batch_with_index', () => {
    const ops: NormalizedTransformOp[] = [
      { kind: 'tag_add', tags: ['ok'] },
      { kind: 'regex_replace', field: 'front', pattern: '(unclosed', replacement: '' },
    ];
    let error: InvalidPatternError | null = null;
    try {
      compileTransformOps(ops, nativeRegex);
    } catch (caught) {
      if (!(caught instanceof InvalidPatternError)) throw caught;
      error = caught;
    }
    expect(error).not.toBeNull();
    expect(error!.opIndex).toBe(1);
    expect(error!.pattern).toBe('(unclosed');
    expect(error!.message.length).toBeGreaterThan(0);
  });

  it('transform_validity_guard_matches_card_content_semantics', () => {
    const ops: NormalizedTransformOp[] = [
      { kind: 'regex_replace', field: 'back', pattern: '.+', replacement: '' },
    ];
    const compiled = compileTransformOps(ops, nativeRegex);
    const before = transformFieldsFromCard(makeCard('card-1', 'Q', 'A', null, []));
    const after = applyTransformOps(compiled, before);
    expect(after.back).toBe('');
    expect(transformFieldsAreValid(before)).toBe(true);
    expect(transformFieldsAreValid(after)).toBe(false);

    // Cloze 卡（text 非空）允许 front/back 为空
    const cloze: TransformFields = {
      front: '',
      back: '',
      text: '{{c1::挖空}}',
      tags: [],
    };
    expect(transformFieldsAreValid(cloze)).toBe(true);
  });

  // ---------------------------------------------------------------- transform script

  it('script_io_contract_roundtrip_ignores_script_version', () => {
    const longFront = '边'.repeat(4096);
    const cards = [makeCard('card-1', longFront, '答案', null, ['旧标签'])];
    const input = buildScriptInput('doc-r4', cards);
    expect(input.documentId).toBe('doc-r4');
    const entry = input.cards[0]!;
    expect([...entry.front].length).toBe(4096);
    expect(entry.version).toBe('2026-08-24T01:00:00Z');

    // 模拟脚本把输入原样回写，但篡改 version
    const echoed = { ...entry, version: '1999-01-01T00:00:00Z' };
    const raw = new TextEncoder().encode(JSON.stringify({ cards: [echoed] }));
    const evaluation = evaluateScriptOutput(raw, cards);
    expect(evaluation.unknownCardIds).toEqual([]);
    const plan = evaluation.cardPlans[0]!;
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.fields).toEqual(transformFieldsFromCard(cards[0]!));
  });

  it('script_output_contract_fails_closed_per_card_and_reports_unknown_ids', () => {
    const cards = [
      makeCard('card-1', 'Q1', 'A1', '{{c1::旧}}', []),
      makeCard('card-2', 'Q2', 'A2', null, []),
    ];

    // 顶层违约：cards 缺失 → 整批 Schema 错误
    let topLevel: unknown;
    try {
      evaluateScriptOutput(new TextEncoder().encode(JSON.stringify({ stats: 1 })), cards);
    } catch (error) {
      topLevel = error;
    }
    expect(topLevel).toBeInstanceOf(Error);
    expect((topLevel as { kind?: string }).kind).toBe('schema');

    const raw = new TextEncoder().encode(JSON.stringify({
      cards: [
        { id: 'card-1', text: '去掉了挖空标记' },
        { id: 'card-2', front: '更新', isErrorCard: false },
        { id: 'card-ghost', front: '脚本试图新增' },
      ],
    }));
    const evaluation = evaluateScriptOutput(raw, cards);
    expect(evaluation.unknownCardIds).toEqual(['card-ghost']);
    expect(evaluation.cardPlans.length).toBe(2);

    const first = evaluation.cardPlans[0]! as ScriptCardPlan;
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.issue.code).toBe('invalid_cloze_text');

    const second = evaluation.cardPlans[1]! as ScriptCardPlan;
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.issue.code).toBe('unknown_output_field');
  });

  it('script_interpreter_probe_returns_none_without_interpreter', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-script-empty-'));
    try {
      expect(resolveInterpreterInDirs(['python3', 'python', 'node'], [emptyDir])).toBeNull();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }

    // cloze 语义锁定（与 database::contains_valid_anki_cloze_markup 同规则）
    expect(textHasValidClozeMarkup('{{c1::答案}}')).toBe(true);
    expect(textHasValidClozeMarkup('{{c12::答案::提示}}')).toBe(true);
    expect(textHasValidClozeMarkup('{{c0::zero}}')).toBe(false);
    expect(textHasValidClozeMarkup('{{c1::}}')).toBe(false);
    expect(textHasValidClozeMarkup('没有挖空')).toBe(false);
  });

  it('script_sandbox_policy_never_allows_network_and_scopes_writes_to_job_dir', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-sandbox-'));
    const jobDir = path.join(temp, 'job');
    fs.mkdirSync(jobDir, { recursive: true });
    try {
      const policy = transformSandboxPolicy(jobDir, '/usr/bin/python3');
      expect(policy.allowNetwork).toBe(false);
      expect(policy.writableRoots).toEqual([jobDir]);
      expect(policy.readableRoots).toContain(jobDir);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------- plan_route / analyze

  it('plan_route_response_parsing_is_tolerant_but_conservative', () => {
    const plan = parseRoutePlanResponse(
      '```json\n{"route":"vlm_full","confidence":0.92,"glossaryMode":true,"reason":"扫描件"}\n```',
    );
    expect(plan).not.toBeNull();
    expect(plan!.route).toBe<ChatAnkiRoute>('vlm_full');
    expect(routePlanIsConfident(plan!)).toBe(true);
    expect(plan!.glossaryMode).toBe(true);
    expect(plan!.reason).toBe('扫描件');

    const withProse = parseRoutePlanResponse(
      '好的，我的判断如下 {"route":"simple_text","confidence":0.4} 供参考',
    );
    expect(withProse).not.toBeNull();
    expect(withProse!.route).toBe('simple_text');
    expect(routePlanIsConfident(withProse!)).toBe(false);

    expect(parseRoutePlanResponse('{"route":"teleport","confidence":0.9}')).toBeNull();
    expect(parseRoutePlanResponse('{"route":"vlm_full","confidence":1.5}')).toBeNull();
    expect(parseRoutePlanResponse('{"route":"vlm_full"}')).toBeNull();
    expect(parseRoutePlanResponse('完全不是 JSON')).toBeNull();
  });

  it('route_decision_priority_chain_is_forced_then_llm_then_heuristic', () => {
    const rd = refData(1, 0); // 启发式应得 simple_text

    const forced = resolveRouteDecision('vlm_full', null, rd);
    expect(forced.source).toBe('forced');
    expect(forced.route).toBe('vlm_full');

    const confident: RoutePlan = {
      route: 'vlm_light',
      confidence: 0.9,
      glossaryMode: false,
      reason: '文本可读但有图',
    };
    const llm = resolveRouteDecision(null, confident, rd);
    expect(llm.source).toBe('llm');
    expect(llm.route).toBe('vlm_light');
    expect(llm.confidence).toBe(0.9);

    const hesitant: RoutePlan = { ...confident, confidence: 0.3 };
    const fallback = resolveRouteDecision(null, hesitant, rd);
    expect(fallback.source).toBe('heuristic');
    expect(fallback.route).toBe('simple_text');
    expect(fallback.confidence).toBeNull();

    // forced 永远压过高置信度 LLM 计划
    const forcedWins = resolveRouteDecision('simple_text', confident, rd);
    expect(forcedWins.source).toBe('forced');
    expect(forcedWins.route).toBe('simple_text');
  });

  it('analyze_output_carries_route_source_and_bounded_recommendations', () => {
    const rd = refData(0, 5); // 图片为主 → 启发式 vlm_full
    const cases: Array<[RouteDecision, string]> = [
      [resolveRouteDecision('simple_text', null, rd), 'forced'],
      [
        resolveRouteDecision(
          null,
          { route: 'vlm_full', confidence: 0.95, glossaryMode: null, reason: null },
          rd,
        ),
        'llm',
      ],
      [resolveRouteDecision(null, null, rd), 'heuristic'],
    ];
    for (const [decision, expectedSource] of cases) {
      const output = buildAnalyzeOutput(
        '备考',
        '术语A：定义A\n术语B：定义B\n术语C：定义C',
        rd,
        decision,
        [],
      );
      expect(output['status']).toBe('ok');
      const routing = output['routing'] as Record<string, unknown>;
      const recommended = output['recommended'] as Record<string, unknown>;
      expect(routing['routeSource']).toBe(expectedSource);
      expect(routing['route']).toBe(recommended['route']);
      const maxCards = recommended['maxCards'] as number;
      expect(maxCards).toBeGreaterThanOrEqual(1);
      expect(maxCards).toBeLessThanOrEqual(100);
      expect((output['metrics'] as Record<string, unknown>)['refImages']).toBe(5);
      expect(Object.hasOwn(output, 'warnings')).toBe(false);
    }
  });

  it('analyze_output_propagates_degradation_warnings', () => {
    const rd = refData(1, 0);
    const decision = resolveRouteDecision(null, null, rd);
    expect(decision.source).toBe('heuristic');
    const warnings = [{ code: 'analyze_refs_unresolved', unresolvedIds: ['res_ghost'] }];
    const output = buildAnalyzeOutput(null, '内容', rd, decision, warnings);
    expect((output['warnings'] as Array<Record<string, unknown>>)[0]!['code']).toBe(
      'analyze_refs_unresolved',
    );
    const routing = output['routing'] as Record<string, unknown>;
    expect(String(routing['reason'] ?? '')).toContain('启发式');
  });

  // ---------------------------------------------------------------- retemplate strategy

  it('retemplate_strategy_parses_fill_missing_llm_and_rejects_unknown', () => {
    for (const wire of ['map_only', 'fill_missing', 'fill_missing_llm'] as const) {
      const parsed = parseChatAnkiRetemplateStrategy(wire);
      expect(parsed).toBe(wire);
    }
    expect(() => parseChatAnkiRetemplateStrategy('fill_all_llm')).toThrow();
  });
});
