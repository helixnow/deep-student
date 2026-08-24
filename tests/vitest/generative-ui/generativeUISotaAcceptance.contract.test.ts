/**
 * SOTA 验收 contract — Generative-UI-0824 目标态静态验证（Round 20）
 *
 * 对照 ARCHITECTURE.md / INTEGRATION_ROADMAP.md 核心要求，
 * 确保「结构化意图 + 组件注册表」全链路接线未被回归破坏。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();

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
    id: 'sota-checklist-doc',
    check: () => fs.existsSync(path.join(REPO, 'docs/generative-ui/SOTA_CHECKLIST.md')),
  },
  {
    id: 'guarded-listen-hpias-whitelist',
    check: () =>
      fs.readFileSync(path.join(REPO, 'src/utils/guardedListen.ts'), 'utf8').includes('hpias_event'),
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
});
