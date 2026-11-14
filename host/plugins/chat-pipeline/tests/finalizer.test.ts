import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MessageBlock, ToolResultInfo } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import {
  artifactsExistCheck, batchCoverageCheck, collectBatchManifests, collectTodoBatch,
  finalizeTask, injectFinalizationIntoBlocks, normalizeRuntimeRelativePath, parseDeclaredArtifacts,
  resolveUnderRoot, sideEffectsSettledCheck, standardChecks, stripToolNamespace,
  type ArtifactLocator, type BatchItemStatus, type BatchManifest, type DeclaredArtifact,
  type FinalizationContext, type FinalizationReport, type SideEffectEvidence, type TodoBatchSnapshot,
} from '../src/finalizer.ts';
import { setChatPipelineLocalFs } from '../src/local-fs.ts';
import { nodeChatPipelineLocalFs } from '../src/local-fs.node.ts';

// 产物校验走同步文件端口；单元测试直接装同一份 `node:fs` 实现（桌面入口注入）。
beforeAll(() => { setChatPipelineLocalFs(nodeChatPipelineLocalFs); });
afterAll(() => { setChatPipelineLocalFs(null); });

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-pipeline-finalizer-'));
  tempDirs.push(dir);
  return dir;
}

const tempDirLocator = (root: string): ArtifactLocator => ({
  resolve: (_rootId, relative) => resolveUnderRoot(root, relative),
});
const failingLocator: ArtifactLocator = { resolve: () => { throw new Error('root not configured'); } };
const declared = (artifactPath: string, sha256: string | null = null,
  rootId: string | null = null): DeclaredArtifact => ({ path: artifactPath, sha256, root_id: rootId });

function finalizeWith(declaredArtifacts: readonly DeclaredArtifact[], artifactsRequired: boolean,
  locator: ArtifactLocator | null): FinalizationReport {
  return finalizeTask({
    sessionId: 'sess-test',
    declaredArtifacts,
    artifactsRequired,
    locator,
    batchManifests: [],
    todoBatch: null,
    sideEffects: null,
  });
}

const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

function batchManifest(expected: number, items: Array<[string, BatchItemStatus]>): BatchManifest {
  const listed = items.length;
  return {
    manifestId: 'manifest_test',
    expectedItems: expected,
    observedItems: listed,
    coverageComplete: listed === expected,
    truncated: listed < expected,
    items: items.map(([itemId, status]) => ({
      itemId, objectHandleId: null, status, attempts: 1,
      error: status === 'failed' ? 'boom' : null,
    })),
  };
}
function ctxWithBatches(manifests: readonly BatchManifest[],
  todo: TodoBatchSnapshot | null): FinalizationContext {
  return {
    sessionId: 'sess-test', declaredArtifacts: [], artifactsRequired: false, locator: null,
    batchManifests: manifests, todoBatch: todo, sideEffects: null,
  };
}
function todoSnapshot(steps: Array<[string, string, TodoBatchSnapshot['steps'][number]['finalStatus']]>): TodoBatchSnapshot {
  return {
    listId: 'todo_test', title: 'demo',
    steps: steps.map(([stepId, description, finalStatus]) => ({ stepId, description, finalStatus })),
  };
}
function pendingOp(operationId: string, state: string) {
  return { operationId, state, providerId: 'google-work', action: 'send' };
}
function sideEffectCtx(evidence: SideEffectEvidence): FinalizationContext {
  return {
    sessionId: 'sess-test', declaredArtifacts: [], artifactsRequired: false, locator: null,
    batchManifests: [], todoBatch: null, sideEffects: evidence,
  };
}

describe('chat_v2/finalizer.rs::tests', () => {
  it('no_declared_artifacts_is_verified_complete_without_locator', () => {
    const report = finalizeWith([], false, null);
    expect(report.verdict).toBe('verified_complete');
    expect(report.exceptions).toEqual([]);
    expect(report.checks_run).toEqual([]);
  });

  it('declared_existing_artifact_is_verified_complete', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'report.md'), 'hello');
    const report = finalizeWith([declared('report.md')], false, tempDirLocator(root));
    expect(report.verdict).toBe('verified_complete');
    expect(report.exceptions).toEqual([]);
    expect(report.checks_run).toEqual(['artifacts_exist']);
  });

  it('declared_artifact_with_matching_sha256_is_verified_complete', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'report.md'), 'hello');
    const report = finalizeWith([declared('report.md', sha256('hello'))], false, tempDirLocator(root));
    expect(report.verdict).toBe('verified_complete');
    expect(report.exceptions).toEqual([]);
  });

  it('missing_declared_artifact_is_partial', () => {
    const report = finalizeWith([declared('missing.md')], false, tempDirLocator(tempDir()));
    expect(report.verdict).toBe('partial');
    expect(report.exceptions).toHaveLength(1);
    expect(report.exceptions[0]!.kind).toBe('artifact_missing');
    expect(report.exceptions[0]!.path).toBe('missing.md');
  });

  it('sha256_mismatch_is_complete_with_exceptions', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'report.md'), 'hello');
    const report = finalizeWith([declared('report.md', sha256('other content'))], false, tempDirLocator(root));
    expect(report.verdict).toBe('complete_with_exceptions');
    expect(report.exceptions).toHaveLength(1);
    expect(report.exceptions[0]!.kind).toBe('hash_mismatch');
  });

  it('unresolvable_root_is_blocked', () => {
    const report = finalizeWith([declared('report.md')], false, failingLocator);
    expect(report.verdict).toBe('blocked');
    expect(report.exceptions[0]!.kind).toBe('check_unavailable');
  });

  it('missing_locator_is_outcome_unknown', () => {
    const report = finalizeWith([declared('report.md')], false, null);
    expect(report.verdict).toBe('outcome_unknown');
    expect(report.exceptions[0]!.kind).toBe('check_unavailable');
    expect(report.checks_run).toEqual(['artifacts_exist']);
  });

  it('invalid_declared_path_is_partial', () => {
    const locator = tempDirLocator(tempDir());
    for (const bad of ['../escape.txt', '/etc/passwd', '  ']) {
      const report = finalizeWith([declared(bad)], false, locator);
      expect(report.verdict, `path=${bad}`).toBe('partial');
      expect(report.exceptions[0]!.kind).toBe('invalid_declaration');
    }
  });

  it('artifacts_required_but_none_declared_is_partial', () => {
    const report = finalizeWith([], true, tempDirLocator(tempDir()));
    expect(report.verdict).toBe('partial');
    expect(report.exceptions[0]!.kind).toBe('artifact_missing');
  });

  it('directory_artifact_is_invalid_declaration', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'subdir'));
    const report = finalizeWith([declared('subdir')], false, tempDirLocator(root));
    expect(report.verdict).toBe('partial');
    expect(report.exceptions[0]!.kind).toBe('invalid_declaration');
  });

  it('g07b_batch_missing_two_items_is_partial_with_missing_list', () => {
    const manifests = [batchManifest(4, [['a', 'succeeded'], ['b', 'succeeded'], ['c', 'failed'], ['d', 'failed']])];
    const report = finalizeTask(ctxWithBatches(manifests, null));
    expect(report.verdict).toBe('partial');
    expect(report.checks_run).toEqual(['batch_coverage']);
    const missing = report.exceptions.filter(exception => exception.kind === 'batch_item_missing');
    expect(missing).toHaveLength(2);
    expect(missing.some(exception => exception.message.includes("'c'"))).toBe(true);
    expect(missing.some(exception => exception.message.includes("'d'"))).toBe(true);
  });

  it('g07b_truncated_batch_deficit_is_missing', () => {
    const manifests = [batchManifest(5, [['a', 'succeeded'], ['b', 'succeeded'], ['c', 'succeeded']])];
    const report = finalizeTask(ctxWithBatches(manifests, null));
    expect(report.verdict).toBe('partial');
    expect(report.exceptions).toHaveLength(1);
    expect(report.exceptions[0]!.kind).toBe('batch_item_missing');
    expect(report.exceptions[0]!.message).toContain('2 item(s) unaccounted');
  });

  it('g07b_full_batch_passes_and_records_check', () => {
    const manifests = [batchManifest(2, [['a', 'succeeded'], ['b', 'succeeded']])];
    const report = finalizeTask(ctxWithBatches(manifests, null));
    expect(report.verdict).toBe('verified_complete');
    expect(report.checks_run).toEqual(['batch_coverage']);
  });

  it('g07b_todo_batch_incomplete_step_is_missing', () => {
    const todo = todoSnapshot([['step_1', '调研', 'completed'], ['step_2', '整理', 'completed'],
      ['step_3', '输出', 'pending']]);
    const report = finalizeTask(ctxWithBatches([], todo));
    expect(report.verdict).toBe('partial');
    expect(report.checks_run).toEqual(['batch_coverage']);
    expect(report.exceptions).toHaveLength(1);
    expect(report.exceptions[0]!.kind).toBe('batch_item_missing');
    expect(report.exceptions[0]!.message).toContain('step_3');
  });

  it('g07b_todo_batch_all_completed_passes', () => {
    const todo = todoSnapshot([['step_1', '调研', 'completed'], ['step_2', '整理', 'completed']]);
    const report = finalizeTask(ctxWithBatches([], todo));
    expect(report.verdict).toBe('verified_complete');
    expect(report.checks_run).toEqual(['batch_coverage']);
  });

  it('g07b_outcome_unknown_operation_is_not_verified_complete', () => {
    const report = finalizeTask(sideEffectCtx({
      ok: true, summary: { totalOperations: 1, pending: [pendingOp('op-1', 'outcome_unknown')] },
    }));
    expect(report.verdict).toBe('outcome_unknown');
    expect(report.checks_run).toEqual(['side_effects_settled']);
    expect(report.exceptions).toHaveLength(1);
    expect(report.exceptions[0]!.kind).toBe('side_effect_pending');
    expect(report.exceptions[0]!.message).toContain('op-1');
  });

  it('g07b_submitting_operation_is_not_verified_complete', () => {
    const report = finalizeTask(sideEffectCtx({
      ok: true, summary: { totalOperations: 1, pending: [pendingOp('op-2', 'submitting')] },
    }));
    expect(report.verdict).toBe('outcome_unknown');
    expect(report.exceptions[0]!.message).toContain('op-2');
  });

  it('g07b_all_terminal_operations_pass', () => {
    const report = finalizeTask(sideEffectCtx({
      ok: true, summary: { totalOperations: 2, pending: [] },
    }));
    expect(report.verdict).toBe('verified_complete');
    expect(report.checks_run).toEqual(['side_effects_settled']);
  });

  it('g07b_no_operations_is_pure_explanation_fast_path', () => {
    const report = finalizeTask(sideEffectCtx({
      ok: true, summary: { totalOperations: 0, pending: [] },
    }));
    expect(report.verdict).toBe('verified_complete');
    expect(report.checks_run).toEqual([]);
  });

  it('g07b_ledger_query_failure_is_outcome_unknown', () => {
    const report = finalizeTask(sideEffectCtx({ ok: false, error: 'db locked' }));
    expect(report.verdict).toBe('outcome_unknown');
    expect(report.checks_run).toEqual(['side_effects_settled']);
    expect(report.exceptions[0]!.kind).toBe('check_unavailable');
  });

  it('g07b_batch_missing_plus_hash_mismatch_is_partial_with_both_exceptions', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'report.md'), 'hello');
    const manifests = [batchManifest(2, [['a', 'succeeded'], ['b', 'failed']])];
    const report = finalizeTask({
      sessionId: 'sess-test',
      declaredArtifacts: [declared('report.md', sha256('other content'))],
      artifactsRequired: false,
      locator: tempDirLocator(root),
      batchManifests: manifests,
      todoBatch: null,
      sideEffects: null,
    });
    expect(report.verdict).toBe('partial');
    expect(report.exceptions).toHaveLength(2);
    expect(report.exceptions.some(exception => exception.kind === 'batch_item_missing')).toBe(true);
    expect(report.exceptions.some(exception => exception.kind === 'hash_mismatch')).toBe(true);
    expect(report.checks_run).toEqual(['artifacts_exist', 'batch_coverage']);
  });

  it('g07b_pending_side_effect_plus_other_exception_is_complete_with_exceptions', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'report.md'), 'hello');
    const report = finalizeTask({
      sessionId: 'sess-test',
      declaredArtifacts: [declared('report.md', sha256('other content'))],
      artifactsRequired: false,
      locator: tempDirLocator(root),
      batchManifests: [],
      todoBatch: null,
      sideEffects: { ok: true, summary: { totalOperations: 1, pending: [pendingOp('op-9', 'outcome_unknown')] } },
    });
    expect(report.verdict).toBe('complete_with_exceptions');
    expect(report.exceptions.some(exception => exception.kind === 'hash_mismatch')).toBe(true);
    expect(report.exceptions.some(exception => exception.kind === 'side_effect_pending')).toBe(true);
  });

  it('g07b_registry_is_compile_time_closed', () => {
    expect(standardChecks().map(check => check.id)).toEqual([
      'artifacts_exist', 'batch_coverage', 'side_effects_settled',
    ]);
    expect(Object.isFrozen(standardChecks())).toBe(true);
    expect(artifactsExistCheck.id).toBe('artifacts_exist');
    expect(batchCoverageCheck.id).toBe('batch_coverage');
    expect(sideEffectsSettledCheck.id).toBe('side_effects_settled');
  });

  it('g07b_new_exception_kinds_serialize_snake_case', () => {
    expect(JSON.stringify({ kind: 'batch_item_missing' })).toBe('{"kind":"batch_item_missing"}');
    expect(JSON.stringify({ kind: 'side_effect_pending' })).toBe('{"kind":"side_effect_pending"}');
  });

  it('verdict_serializes_snake_case', () => {
    for (const verdict of ['verified_complete', 'complete_with_exceptions', 'partial', 'blocked', 'outcome_unknown']) {
      expect(JSON.parse(JSON.stringify({ verdict })).verdict).toBe(verdict);
    }
    expect(JSON.stringify({ kind: 'artifact_missing' })).toBe('{"kind":"artifact_missing"}');
  });

  it('report_serializes_expected_shape', () => {
    const report: FinalizationReport = {
      verdict: 'partial',
      exceptions: [{ check: 'artifacts_exist', kind: 'artifact_missing', path: 'a.md', message: 'missing' }],
      checks_run: ['artifacts_exist'],
    };
    const value = JSON.parse(JSON.stringify(report));
    expect(value.verdict).toBe('partial');
    expect(value.exceptions[0].kind).toBe('artifact_missing');
    expect(value.exceptions[0].path).toBe('a.md');
    expect(value.checks_run).toEqual(['artifacts_exist']);
  });

  it('parse_declared_artifacts_handles_all_shapes', () => {
    expect(parseDeclaredArtifacts({ result: 'done' })).toEqual([]);
    expect(parseDeclaredArtifacts({ artifacts: null })).toEqual([]);

    const parsed = parseDeclaredArtifacts({
      artifacts: [{ path: 'a.md', sha256: 'abc', root_id: 'workspace' }],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.path).toBe('a.md');
    expect(parsed[0]!.sha256).toBe('abc');
    expect(parsed[0]!.root_id).toBe('workspace');

    expect(() => parseDeclaredArtifacts({ artifacts: [{ sha256: 'abc' }] })).toThrow();
    expect(() => parseDeclaredArtifacts({ artifacts: 'not-an-array' })).toThrow();
    expect(() => parseDeclaredArtifacts({ artifacts: [{ path: null }] }))
      .toThrow('invalid artifacts declaration: invalid type: null, expected a string');
    expect(() => parseDeclaredArtifacts({ artifacts: [{ path: 5 }] }))
      .toThrow('invalid artifacts declaration: invalid type: integer `5`, expected a string');
    expect(parseDeclaredArtifacts({ artifacts: [{ path: 'a.md' }] }))
      .toEqual([{ path: 'a.md', sha256: null, root_id: null }]);
  });

  it('completion_block_receives_finalization_field', () => {
    const blockId = 'blk_completion';
    const toolResults = [completionToolResult(blockId)];
    const blocks = [completionBlock(blockId, structuredClone(toolResults[0]!.output))];
    const report: FinalizationReport = {
      verdict: 'partial',
      exceptions: [{ check: 'artifacts_exist', kind: 'artifact_missing', path: 'missing.md', message: 'not found' }],
      checks_run: ['artifacts_exist'],
    };
    const reportValue = JSON.parse(JSON.stringify(report));

    const updated = injectFinalizationIntoBlocks(toolResults, blocks, 0, blockId, reportValue)!;
    expect((toolResults[0]!.output as Record<string, any>).finalization.verdict).toBe('partial');
    expect((blocks[0]!.toolOutput as Record<string, any>).finalization.verdict).toBe('partial');
    expect((blocks[0]!.toolOutput as Record<string, any>).finalization.exceptions[0].kind).toBe('artifact_missing');
    expect((updated.toolOutput as Record<string, any>).finalization.verdict).toBe('partial');
    expect((blocks[0]!.toolOutput as Record<string, any>).task_completed).toBe(true);
  });

  it('inject_finalization_tolerates_missing_block', () => {
    const toolResults = [completionToolResult('blk_a')];
    const blocks = [completionBlock('blk_other', {})];
    const updated = injectFinalizationIntoBlocks(toolResults, blocks, 0, 'blk_a',
      { verdict: 'verified_complete' });
    expect(updated).toBeNull();
    expect((toolResults[0]!.output as Record<string, any>).finalization.verdict).toBe('verified_complete');
  });

  it('collect_batch_and_todo_evidence_from_executor_outputs', () => {
    const results: ToolResultInfo[] = [
      { ...completionToolResult('b1'), toolName: 'builtin-todo_init',
        output: { todoListId: 'tl1', title: 'demo', steps: [{ id: 's1', description: 'a' },
          { id: 's2', description: 'b', status: 'running' }] } },
      { ...completionToolResult('b2'), toolName: 'todo_update',
        output: { steps: [{ id: 's1', status: 'completed' }, { id: 's2', status: 'completed' }] } },
      { ...completionToolResult('b3'), toolName: 'batch_run',
        output: { batch_manifest: batchManifest(1, [['a', 'succeeded']]) } },
    ];
    expect(collectBatchManifests(results)).toHaveLength(1);
    const todo = collectTodoBatch(results)!;
    expect(todo.listId).toBe('tl1');
    expect(todo.steps.map(step => [step.stepId, step.finalStatus])).toEqual([
      ['s1', 'completed'], ['s2', 'completed'],
    ]);
    expect(stripToolNamespace('builtin-todo_init')).toBe('todo_init');
    expect(stripToolNamespace('mcp_todo_init')).toBe('todo_init');
    expect(normalizeRuntimeRelativePath('a/b.txt')).toBe(path.join('a', 'b.txt'));
    expect(() => normalizeRuntimeRelativePath('../x')).toThrow();
  });
});

function completionToolResult(blockId: string): ToolResultInfo {
  return {
    toolCallId: 'call_1',
    blockId,
    toolName: 'attempt_completion',
    input: { result: 'done' },
    output: { completed: true, result: 'done', command: null, task_completed: true },
    success: true,
    error: null,
    durationMs: 1,
    reasoningContent: null,
    thoughtSignature: null,
  };
}

function completionBlock(blockId: string, output: unknown): MessageBlock {
  return {
    id: blockId,
    messageId: 'msg_1',
    type: 'mcp_tool',
    status: 'success',
    toolName: 'attempt_completion',
    toolInput: { result: 'done' },
    toolOutput: output,
  };
}

describe('chat_v2/finalizer.rs::tests (G07-b wiring evidence)', () => {
  function toolResult(toolName: string, output: unknown): ToolResultInfo {
    return {
      toolCallId: `call_${toolName}`,
      blockId: null,
      toolName,
      input: {},
      output,
      success: true,
    };
  }

  function emptyContext(overrides: Partial<FinalizationContext> = {}): FinalizationContext {
    return {
      sessionId: 'sess-test',
      declaredArtifacts: [],
      artifactsRequired: false,
      locator: null,
      batchManifests: [],
      todoBatch: null,
      sideEffects: null,
      ...overrides,
    };
  }

  it('try_finalize_without_completion_flag_is_noop', () => {
    const ordinary = toolResult('some_tool', { some: 'output' });
    // No completion evidence: no checks run, no exceptions, no mutation.
    const report = finalizeTask(emptyContext());
    expect(report).toEqual({ verdict: 'verified_complete', exceptions: [], checks_run: [] });
    expect((ordinary.output as Record<string, unknown>).finalization).toBeUndefined();
  });

  it('g07b_try_finalize_collects_batch_manifest_from_tool_outputs', () => {
    const batchResult = toolResult('file_manager_commit', {
      complete: false,
      batch_manifest: {
        manifestId: 'manifest_e2e',
        expectedItems: 2,
        observedItems: 2,
        coverageComplete: true,
        truncated: false,
        items: [
          { itemId: 'a', status: 'succeeded', attempts: 1 },
          { itemId: 'b', status: 'failed', attempts: 1, error: 'disk full' },
        ],
      },
    });

    const report = finalizeTask(emptyContext({
      batchManifests: collectBatchManifests([batchResult]),
    }));
    expect(report.verdict).toBe('partial');
    expect(report.checks_run).toEqual(['batch_coverage']);
    expect(report.exceptions).toHaveLength(1);
    expect(report.exceptions[0]!.kind).toBe('batch_item_missing');
    expect(report.exceptions[0]!.message).toContain("'b'");
  });

  it('g07b_try_finalize_collects_todo_batch_from_tool_outputs', () => {
    const initResult = toolResult('todo_init', {
      success: true,
      todoListId: 'todo_e2e',
      title: '三步任务',
      totalSteps: 3,
      steps: [
        { id: 'step_1', description: '调研', status: 'pending', createdAt: 1 },
        { id: 'step_2', description: '整理', status: 'pending', createdAt: 1 },
        { id: 'step_3', description: '输出', status: 'pending', createdAt: 1 },
      ],
    });
    const updateResult = toolResult('todo_update', {
      success: true,
      steps: [
        { id: 'step_1', description: '调研', status: 'completed', createdAt: 1 },
        { id: 'step_2', description: '整理', status: 'completed', createdAt: 1 },
        { id: 'step_3', description: '输出', status: 'pending', createdAt: 1 },
      ],
    });

    const todoBatch = collectTodoBatch([initResult, updateResult]);
    const report = finalizeTask(emptyContext({ todoBatch }));
    expect(report.verdict).toBe('partial');
    expect(report.checks_run).toEqual(['batch_coverage']);
    expect(report.exceptions).toHaveLength(1);
    expect(report.exceptions[0]!.message).toContain('step_3');
  });

  it('g07b_todo_denominator_pinned_at_first_init', () => {
    const firstInit = toolResult('builtin-todo_init', {
      success: true,
      todoListId: 'todo_drift',
      title: '原计划',
      steps: [
        { id: 'step_1', description: 'a', status: 'pending', createdAt: 1 },
        { id: 'step_2', description: 'b', status: 'pending', createdAt: 1 },
        { id: 'step_3', description: 'c', status: 'pending', createdAt: 1 },
      ],
    });
    const reInit = toolResult('todo_init', {
      success: true,
      todoListId: 'todo_drift',
      title: '缩水计划',
      steps: [
        { id: 'step_1', description: 'a', status: 'completed', createdAt: 2 },
      ],
    });

    const todoBatch = collectTodoBatch([firstInit, reInit]);
    const report = finalizeTask(emptyContext({ todoBatch }));
    expect(report.verdict).toBe('partial');
    expect(report.exceptions).toHaveLength(2);
    expect(report.exceptions.some(exception => exception.message.includes('step_2'))).toBe(true);
    expect(report.exceptions.some(exception => exception.message.includes('step_3'))).toBe(true);
  });
});
