/**
 * Contract: Generative UI 全模块集成接线（Round 9–18 累积态）
 *
 * 通过静态分析 + registry 快照验证各子系统 mount/bridge/handler 均已落地，
 * 防止后续迭代中 silently 断开集成链。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import {
  RESEARCH_ACTION_IDS,
  NOTE_EDIT_ACTION_IDS,
} from '@/features/generative-ui/bridge/resolveGenerativeUIChatActionHandlers';
import { HPIAS_EVENT_CHANNEL } from '@/features/generative-ui/bridge/hpiasEventBridge';
import { isWhitelistedNonChat } from '@/utils/guardedListen';

import '@/features/generative-ui/blocks';

const ROOT = path.join(process.cwd(), 'src/features/generative-ui');
const REPO = process.cwd();

const EXPECTED_BLOCK_TYPES = [
  'stat-card',
  'alert',
  'list',
  'progress',
  'action-bar',
  'text',
  'key-value-grid',
  'flashcard-preview',
  'review-calendar',
  'mistake-analysis',
  'mindmap-embed',
  'paper-digest',
  'research-plan',
  'research-report',
  'markdown',
  'chart',
  'steps',
  'table',
] as const;

const BRIDGE_FILES = [
  'bridge/chatBlockBridge.ts',
  'bridge/generativeUIStreamRegistry.ts',
  'bridge/hpiasEventBridge.ts',
  'bridge/resolveGenerativeUIChatActionHandlers.ts',
] as const;

const HANDLER_FILES = [
  'handlers/workbenchLearningHandlers.ts',
  'handlers/notesEditActionHandlers.ts',
  'handlers/researchBriefingActionHandlers.ts',
] as const;

const BUILDER_UTILS = [
  'utils/buildLearningBriefingIntent.ts',
  'utils/buildAiDashboardIntent.ts',
  'utils/buildFlashcardPreviewIntent.ts',
  'utils/buildHpiasResearchDashboardIntent.ts',
  'utils/buildResearchPlanIntent.ts',
  'utils/buildResearchReportIntent.ts',
  'utils/buildPaperDigestIntent.ts',
  'utils/buildResearchExportMarkdown.ts',
  'utils/buildIntentExportMarkdown.ts',
  'utils/extractResearchContentFromIntent.ts',
  'utils/extractResearchSessionId.ts',
  'utils/buildMarkdownIntent.ts',
  'utils/buildChartIntent.ts',
  'utils/buildStepsIntent.ts',
  'utils/buildTableIntent.ts',
  'utils/buildLearningPlanStepsIntent.ts',
  'utils/coercePartialIntent.ts',
] as const;

const MOUNT_POINTS: Array<{ file: string; mustContain: string[] }> = [
  {
    file: 'src/features/chat/plugins/blocks/generativeUI.tsx',
    mustContain: [
      'HpiasGenerativeResearchPanel',
      'useHpiasEventBridge',
      'extractResearchSessionId',
      'research.actions.copy_report',
    ],
  },
  {
    file: 'src/features/chat/plugins/events/generativeUI.ts',
    mustContain: ['GENERATIVE_UI_BLOCK_TYPE', 'normalizeGenerativeUIEndIntent'],
  },
  {
    file: 'src/components/TranslateWorkbench.tsx',
    mustContain: ['useTranslationStream({ publishKey'],
  },
];

describe('generativeUIModuleIntegration contract', () => {
  it('registers all 18 built-in block types', () => {
    const keys = generativeUIRegistry.keys().sort();
    expect(keys).toEqual([...EXPECTED_BLOCK_TYPES].sort());
  });

  it('exports bridge, research, and stream integration APIs from index', () => {
    const indexSrc = fs.readFileSync(path.join(ROOT, 'index.ts'), 'utf8');
    const requiredExports = [
      'HPIAS_EVENT_CHANNEL',
      'useHpiasEventBridge',
      'createResearchBriefingActionHandlers',
      'buildResearchExportMarkdownFromSnapshot',
      'RESEARCH_ACTION_IDS',
    ];
    for (const symbol of requiredExports) {
      expect(indexSrc, `index.ts missing export: ${symbol}`).toContain(symbol);
    }
  });

  it('bridge layer files exist on disk', () => {
    for (const rel of BRIDGE_FILES) {
      expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true);
    }
  });

  it('handler factories exist on disk', () => {
    for (const rel of HANDLER_FILES) {
      expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true);
    }
  });

  it('deterministic builder utilities exist on disk', () => {
    for (const rel of BUILDER_UTILS) {
      expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true);
    }
  });

  it('module mount points wire generative-ui into Chat/Hub/Workbench', () => {
    for (const { file, mustContain } of MOUNT_POINTS) {
      const src = fs.readFileSync(path.join(REPO, file), 'utf8');
      for (const needle of mustContain) {
        expect(src, `${file} missing: ${needle}`).toContain(needle);
      }
    }
  });

  it('Hpias event channel constant matches guardedListen whitelist', () => {
    expect(HPIAS_EVENT_CHANNEL).toBe('hpias_event');
    expect(isWhitelistedNonChat(HPIAS_EVENT_CHANNEL)).toBe(true);
  });

  it('action id registries cover note and research handler sets', () => {
    expect(NOTE_EDIT_ACTION_IDS).toContain('apply-note-edit');
    expect(RESEARCH_ACTION_IDS).toEqual(['copy-report', 'export-plan', 'export-intent']);
  });

  it('translation stream bridge module exists for live briefing', () => {
    expect(fs.existsSync(path.join(REPO, 'src/translation/translationStreamBridge.ts'))).toBe(true);
  });

  it('HpiasGenerativeResearchPanel wires action handlers', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'components/HpiasGenerativeResearchPanel.tsx'),
      'utf8',
    );
    expect(src).toContain('createResearchBriefingActionHandlers');
    expect(src).toContain('createCopyIntentActionHandlers');
    expect(src).toContain('actionHandlers={actionHandlers}');
  });
});
