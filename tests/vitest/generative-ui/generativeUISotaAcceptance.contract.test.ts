/**
 * SOTA 验收 contract — Generative-UI-0824 目标态静态验证（Round 40/41）
 *
 * 对照 ARCHITECTURE.md / INTEGRATION_ROADMAP.md 核心要求，
 * 确保「结构化意图 + 组件注册表」全链路接线未被回归破坏。
 *
 * Round 40/41 真实态：18 块 + Intent v1.1 layout + telemetry/undo + 流式 fallback。
 * 本文件只做文件/符号存在性检查，不把 Goal「合入 main」标成已完成。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();
const GENERATIVE_UI = path.join(REPO, 'src/features/generative-ui');

function readRepo(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

function fileContains(rel: string, needles: string[]): boolean {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) return false;
  const src = fs.readFileSync(abs, 'utf8');
  return needles.every((n) => src.includes(n));
}

const SOTA_REQUIREMENTS: Array<{ id: string; check: () => boolean }> = [
  {
    id: 'core-schema-registry',
    check: () =>
      fs.existsSync(path.join(REPO, 'src/features/generative-ui/schema.ts')) &&
      fs.existsSync(path.join(REPO, 'src/features/generative-ui/registry.ts')),
  },
  {
    id: 'chat-block-bridge',
    check: () =>
      fs.readFileSync(path.join(REPO, 'src/features/chat/plugins/blocks/generativeUI.tsx'), 'utf8')
        .includes('GenerativeUIRenderer'),
  },
  {
    id: 'chat-event-plugin',
    check: () => fs.existsSync(path.join(REPO, 'src/features/chat/plugins/events/generativeUI.ts')),
  },
  {
    id: 'rust-generative-ui-executor',
    check: () =>
      fs.existsSync(path.join(REPO, 'src-tauri/src/chat_v2/tools/generative_ui_executor.rs')),
  },
  {
    id: 'rust-hpias-event-emit',
    check: () => fs.existsSync(path.join(REPO, 'src-tauri/src/hpias/events.rs')),
  },
  {
    id: 'hpias-frontend-bridge',
    check: () =>
      fs.existsSync(path.join(REPO, 'src/features/generative-ui/bridge/hpiasEventBridge.ts')),
  },
  {
    id: 'translation-stream-bridge',
    check: () => fs.existsSync(path.join(REPO, 'src/translation/translationStreamBridge.ts')),
  },
  {
    id: 'research-action-handlers',
    check: () =>
      fs.existsSync(
        path.join(REPO, 'src/features/generative-ui/handlers/researchBriefingActionHandlers.ts'),
      ),
  },
  {
    id: 'notes-hitl-chain',
    check: () =>
      fs.existsSync(path.join(REPO, 'src/features/generative-ui/utils/dispatchCanvasAIEditRequest.ts')),
  },
  {
    id: 'flashcard-save-handler',
    check: () =>
      fs.existsSync(path.join(REPO, 'src/features/generative-ui/handlers/flashcardActionHandlers.ts')),
  },
  {
    id: 'generative-ui-skill',
    check: () =>
      fs.existsSync(path.join(REPO, 'src/features/chat/skills/builtin-tools/generative-ui.ts')),
  },
  {
    id: 'architecture-docs',
    check: () =>
      fs.existsSync(path.join(REPO, 'docs/generative-ui/ARCHITECTURE.md')) &&
      fs.existsSync(path.join(REPO, 'docs/generative-ui/INTEGRATION_ROADMAP.md')) &&
      fs.existsSync(path.join(REPO, 'docs/generative-ui/PROGRESS.md')),
  },
  {
    id: 'module-integration-contract',
    check: () =>
      fs.existsSync(
        path.join(REPO, 'tests/vitest/generative-ui/generativeUIModuleIntegration.contract.test.ts'),
      ),
  },
  {
    id: 'hpias-rust-executor-wiring',
    check: () => {
      const src = fs.readFileSync(
        path.join(REPO, 'src-tauri/src/chat_v2/tools/generative_ui_executor.rs'),
        'utf8',
      );
      return (
        src.includes('emit_hpias_session_started_if_needed') &&
        src.includes('HpiasEventEmitter') &&
        src.includes('create_research_backend')
      );
    },
  },
  {
    id: 'hpias-pipeline-orchestrator',
    check: () =>
      fs.existsSync(path.join(REPO, 'src-tauri/src/hpias/orchestrator.rs')) &&
      fs.existsSync(path.join(REPO, 'src-tauri/src/hpias/payloads.rs')),
  },
  {
    id: 'hpias-research-service',
    check: () => fs.existsSync(path.join(REPO, 'src-tauri/src/hpias/service.rs')),
  },
  {
    id: 'hpias-lifecycle-contract',
    check: () =>
      fs.existsSync(
        path.join(REPO, 'src/features/generative-ui/contracts/hpiasLifecycleContract.ts'),
      ),
  },
  {
    id: 'hpias-runtime-integration-test',
    check: () =>
      fs.existsSync(
        path.join(REPO, 'tests/vitest/generative-ui/hpiasPipelineRuntime.integration.test.tsx'),
      ),
  },
  {
    id: 'all-blocks-runtime-test',
    check: () =>
      fs.existsSync(
        path.join(REPO, 'tests/vitest/generative-ui/generativeUIAllBlocksRuntime.test.tsx'),
      ),
  },
  {
    id: 'chat-hpias-runtime-test',
    check: () =>
      fs.existsSync(
        path.join(
          REPO,
          'tests/vitest/generative-ui/generativeUIChatBlockHpiasRuntime.integration.test.tsx',
        ),
      ),
  },
  {
    id: 'hpias-retrieval-backend',
    check: () => fs.existsSync(path.join(REPO, 'src-tauri/src/hpias/retrieval_backend.rs')),
  },
  {
    id: 'hpias-llm-synthesis',
    check: () => fs.existsSync(path.join(REPO, 'src-tauri/src/hpias/synthesis.rs')),
  },
  {
    id: 'tauri-e2e-rust-harness',
    check: () => {
      const src = fs.readFileSync(
        path.join(REPO, 'src-tauri/tests/generative_ui_executor_e2e.rs'),
        'utf8',
      );
      return (
        src.includes('execute_with_research_session_emits_hpias_session_started') &&
        src.includes('execute_hpias_stub_pipeline_emits_plan_generated')
      );
    },
  },
  {
    id: 'tauri-e2e-docs',
    check: () => fs.existsSync(path.join(REPO, 'docs/generative-ui/TAURI_E2E.md')),
  },
  {
    id: 'tauri-e2e-contract-test',
    check: () =>
      fs.existsSync(
        path.join(REPO, 'tests/vitest/generative-ui/generativeUITauriE2E.contract.test.ts'),
      ),
  },
  {
    id: 'sota-checklist-doc',
    check: () => fs.existsSync(path.join(REPO, 'docs/generative-ui/SOTA_CHECKLIST.md')),
  },
  {
    id: 'guarded-listen-hpias-whitelist',
    check: () =>
      fs.readFileSync(path.join(REPO, 'src/utils/guardedListen.ts'), 'utf8').includes('hpias_event'),
  },
  {
    id: 'round40-chart-block',
    check: () =>
      fileContains('src/features/generative-ui/components/ChartBlock.tsx', [
        'export function ChartBlock',
        'CHART_BLOCK_TYPE',
      ]),
  },
  {
    id: 'round40-markdown-block',
    check: () =>
      fileContains('src/features/generative-ui/components/MarkdownBlock.tsx', [
        'export function MarkdownBlock',
        'markdownPropsSchema',
      ]),
  },
  {
    id: 'round40-steps-block',
    check: () =>
      fileContains('src/features/generative-ui/components/StepsBlock.tsx', [
        'export function StepsBlock',
        'STEPS_BLOCK_TYPE',
      ]),
  },
  {
    id: 'round40-table-block',
    check: () =>
      fileContains('src/features/generative-ui/components/TableBlock.tsx', [
        'export function TableBlock',
        'TABLE_BLOCK_TYPE',
      ]),
  },
  {
    id: 'round40-coerce-partial-intent',
    check: () =>
      fileContains('src/features/generative-ui/utils/coercePartialIntent.ts', [
        'export function coercePartialIntent',
      ]),
  },
  {
    id: 'round40-action-undo-stack',
    check: () =>
      fileContains('src/features/generative-ui/handlers/actionUndoStack.ts', [
        'export class GenerativeActionUndoStack',
        'GENERATIVE_ACTION_UNDO_STACK_LIMIT',
      ]),
  },
  {
    id: 'round40-action-telemetry',
    check: () =>
      fileContains('src/features/generative-ui/handlers/actionTelemetry.ts', [
        'export function wrapActionWithTelemetry',
        'export function emitGenerativeActionTelemetry',
      ]),
  },
  {
    id: 'round40-few-shot-examples',
    check: () =>
      fileContains('src/features/generative-ui/prompts/fewShotExamples.ts', [
        'GENERATIVE_UI_FEW_SHOT_EXAMPLES',
        'GENERATIVE_UI_NEGATIVE_EXAMPLES',
      ]),
  },
  {
    id: 'round40-v11-layout-helpers',
    check: () =>
      fileContains('src/features/generative-ui/schema.ts', [
        "GENERATIVE_UI_INTENT_VERSIONS = ['1', '1.1']",
        'export function resolveGenerativeLayout',
        'export function layoutGridClassName',
        'export function layoutSpanClassName',
        'export function clampGenerativeLayoutUnit',
      ]),
  },
  {
    id: 'round40-eighteen-blocks-registered',
    check: () =>
      fileContains('src/features/generative-ui/blocks/index.ts', [
        "type: 'markdown'",
        "type: 'chart'",
        "type: 'steps'",
        "type: 'table'",
      ]),
  },
  {
    id: 'round40-stream-fallback-wiring',
    check: () =>
      fileContains('src/features/generative-ui/GenerativeUIRenderer.tsx', [
        'coercePartialIntent',
      ]),
  },
  {
    id: 'round45-action-timeout',
    check: () =>
      fileContains('src/features/generative-ui/handlers/actionTimeout.ts', [
        'export function wrapActionWithTimeout',
        'GENERATIVE_ACTION_TIMEOUT_MS',
      ]),
  },
  {
    id: 'round45-action-rate-limit',
    check: () =>
      fileContains('src/features/generative-ui/handlers/actionRateLimit.ts', [
        'export function wrapActionWithRateLimit',
        'GENERATIVE_ACTION_COOLDOWN_MS',
      ]),
  },
  {
    id: 'round45-intent-lint',
    check: () =>
      fileContains('src/features/generative-ui/utils/lintGenerativeUIIntent.ts', [
        'export function lintGenerativeUIIntent',
      ]),
  },
  {
    id: 'round45-json-schema-export',
    check: () =>
      fileContains('src/features/generative-ui/utils/exportGenerativeUIJsonSchema.ts', [
        'export function exportGenerativeUIJsonSchema',
      ]),
  },
  {
    id: 'round46-export-intent-handler',
    check: () =>
      fileContains('src/features/generative-ui/handlers/exportIntentActionHandlers.ts', [
        'export function createExportIntentActionHandlers',
        'EXPORT_INTENT_ACTION_ID',
      ]),
  },
  {
    id: 'round46-parse-error-codes',
    check: () =>
      fileContains('src/features/generative-ui/utils/classifyGenerativeUIParseErrors.ts', [
        'export function classifyGenerativeUIParseErrors',
      ]),
  },
];

describe('generativeUISotaAcceptance contract', () => {
  it('satisfies all SOTA integration requirements', () => {
    const failures = SOTA_REQUIREMENTS.filter((req) => !req.check()).map((req) => req.id);
    expect(failures, `Missing SOTA requirements: ${failures.join(', ')}`).toEqual([]);
  });

  it('ARCHITECTURE documents hpias_event backend protocol', () => {
    const arch = fs.readFileSync(path.join(REPO, 'docs/generative-ui/ARCHITECTURE.md'), 'utf8');
    expect(arch).toContain('hpias_event');
    expect(arch).toContain('session_started');
  });

  it('Rust hpias channel constant matches frontend', () => {
    const rust = fs.readFileSync(path.join(REPO, 'src-tauri/src/hpias/events.rs'), 'utf8');
    expect(rust).toContain('"hpias_event"');
  });

  it('Round 40/41 symbols exist: 18-block set + v1.1 + telemetry + fallback', () => {
    const indexSrc = fs.readFileSync(path.join(GENERATIVE_UI, 'index.ts'), 'utf8');
    for (const symbol of [
      'ChartBlock',
      'MarkdownBlock',
      'StepsBlock',
      'TableBlock',
      'coercePartialIntent',
      'lintGenerativeUIIntent',
      'exportGenerativeUIJsonSchema',
      'wrapActionWithTimeout',
      'wrapActionWithRateLimit',
      'createExportIntentActionHandlers',
      'classifyGenerativeUIParseErrors',
      'usePrefersContrast',
      'createCopyBlockActionHandlers',
      'collectUnregisteredActionIds',
      'formatGenerativeDate',
    ]) {
      expect(indexSrc, `index.ts missing export: ${symbol}`).toContain(symbol);
    }

    const schemaSrc = readRepo('src/features/generative-ui/schema.ts');
    expect(schemaSrc).toContain('resolveGenerativeLayout');
    expect(schemaSrc).toContain('layoutGridClassName');
    expect(schemaSrc).toContain('layoutSpanClassName');

    const undoSrc = readRepo('src/features/generative-ui/handlers/actionUndoStack.ts');
    expect(undoSrc).toContain('export class GenerativeActionUndoStack');

    const fewShotSrc = readRepo('src/features/generative-ui/prompts/fewShotExamples.ts');
    expect(fewShotSrc).toContain('GENERATIVE_UI_FEW_SHOT_EXAMPLES');
  });
});
