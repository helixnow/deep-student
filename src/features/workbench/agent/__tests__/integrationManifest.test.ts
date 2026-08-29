/**
 * Agent 结合能力表一致性测试 — Wave2-B R5（Agent 结合-1）
 *
 * 静态钉住三件事：
 * 1. 表本身的不变量（id 唯一、四结合点齐、导航类 activation 元数据与
 *    workbenchBus 白名单同源）；
 * 2. workbenchBus 薄封装的参数校验（INVALID_ARGS 早退、禁用态回
 *    WORKBENCH_DISABLED，不触达 windowStore）；
 * 3. 源码级边界：manifest 对 selectionStudyActions 只有类型导入 + 动态
 *    import（懒加载不被抵消），零 streaming_anki / qbank 服务层 import，
 *    制卡入口字符串必须点名 cardAgent.startGeneration（防自造第二管线）。
 *
 * 本文件为用例文本，按 wave 口径第 8 轮前不执行。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AGENT_INTEGRATIONS,
  getAgentIntegration,
  type AgentIntegrationId,
} from '../integrationManifest';
import {
  PDF_PAGE_ACTIVATION_TYPE_IDS,
  workbenchBus,
} from '../../core/workbenchBus';

const MANIFEST_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/features/workbench/agent/integrationManifest.ts'),
  'utf8',
);

const ALL_IDS: AgentIntegrationId[] = [
  'open_note_anchor',
  'open_pdf_page',
  'generate_cards_from_excerpt',
  'generate_questions_from_excerpt',
];

describe('AGENT_INTEGRATIONS 表不变量', () => {
  it('id 唯一且四个结合点齐备', () => {
    const ids = AGENT_INTEGRATIONS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ALL_IDS) {
      expect(getAgentIntegration(id).id).toBe(id);
    }
  });

  it('导航类结合点必须声明 activation 元数据，非导航类不得声明', () => {
    for (const entry of AGENT_INTEGRATIONS) {
      if (entry.kind === 'navigation') {
        expect(entry.activation).toBeDefined();
        expect(entry.activation!.typeIds.length).toBeGreaterThan(0);
        expect(entry.activation!.action.length).toBeGreaterThan(0);
      } else {
        expect(entry.activation).toBeUndefined();
      }
    }
  });

  it('open_pdf_page 的 typeId 白名单与 workbenchBus 常量同源', () => {
    const entry = getAgentIntegration('open_pdf_page');
    expect(entry.activation!.typeIds).toBe(PDF_PAGE_ACTIVATION_TYPE_IDS);
    expect(entry.activation!.action).toBe('gotoPage');
  });

  it('open_note_anchor 走既有 scrollToHeading activation，不开新协议', () => {
    const entry = getAgentIntegration('open_note_anchor');
    expect(entry.activation!.typeIds).toEqual(['note']);
    expect(entry.activation!.action).toBe('scrollToHeading');
  });

  it('制卡入口必须点名 cardAgent.startGeneration（E 域唯一合法入口）', () => {
    const entry = getAgentIntegration('generate_cards_from_excerpt');
    expect(entry.entry).toContain('cardAgent.startGeneration');
    expect(entry.kind).toBe('pipeline');
  });

  it('出题入口走聊天预填（PREFILL），不走题库导入抽取流', () => {
    const entry = getAgentIntegration('generate_questions_from_excerpt');
    expect(entry.entry).toContain('PREFILL_CHAT_INPUT');
    expect(entry.entry).not.toContain('import_question_bank_stream');
    expect(entry.kind).toBe('chat-prefill');
  });
});

describe('workbenchBus 薄封装参数校验（不触达 windowStore）', () => {
  it('openNoteAnchor：缺 noteId / heading → INVALID_ARGS，不投递', async () => {
    const missingNote = await workbenchBus.openNoteAnchor({ noteId: '  ', heading: '引言' });
    expect(missingNote.delivered).toBe(false);
    expect(missingNote.result.code).toBe('INVALID_ARGS');

    const missingHeading = await workbenchBus.openNoteAnchor({ noteId: 'note_1', heading: '' });
    expect(missingHeading.delivered).toBe(false);
    expect(missingHeading.result.code).toBe('INVALID_ARGS');
  });

  it('openPdfPage：非法 typeId / resourceId / page → INVALID_ARGS，不投递', async () => {
    const badType = await workbenchBus.openPdfPage({
      typeId: 'note' as never,
      resourceId: 'tb_1',
      page: 1,
    });
    expect(badType.result.code).toBe('INVALID_ARGS');

    const badResource = await workbenchBus.openPdfPage({
      typeId: 'textbook',
      resourceId: '  ',
      page: 1,
    });
    expect(badResource.result.code).toBe('INVALID_ARGS');

    const badPage = await workbenchBus.openPdfPage({
      typeId: 'textbook',
      resourceId: 'tb_1',
      page: 0,
    });
    expect(badPage.result.code).toBe('INVALID_ARGS');
  });

  it('禁用态：参数合法也只回 WORKBENCH_DISABLED（沿用 activateDetailed 语义）', async () => {
    workbenchBus.setEnabled(false);
    const note = await workbenchBus.openNoteAnchor({ noteId: 'note_1', heading: '引言' });
    expect(note.delivered).toBe(false);
    expect(note.result.code).toBe('WORKBENCH_DISABLED');

    const pdf = await workbenchBus.openPdfPage({
      typeId: 'textbook',
      resourceId: 'tb_1',
      page: 3,
    });
    expect(pdf.delivered).toBe(false);
    expect(pdf.result.code).toBe('WORKBENCH_DISABLED');
  });
});

describe('integrationManifest 源码级边界', () => {
  it('selectionStudyActions 只有类型导入 + 动态 import（懒加载不被静态导入抵消）', () => {
    expect(MANIFEST_SOURCE).toContain(
      "import type {\n  SelectionCardInput,\n  SelectionQuestionResult,\n  SelectionSourceInfo,\n} from '@/features/pdf/selectionStudyActions'",
    );
    expect(MANIFEST_SOURCE).toContain("await import('@/features/pdf/selectionStudyActions')");
    // 反向闩：不允许出现对该模块的静态值导入
    expect(MANIFEST_SOURCE).not.toMatch(
      /^import \{[^}]*\} from '@\/features\/pdf\/selectionStudyActions'/m,
    );
  });

  it('禁改区零触碰：不 import streaming_anki / qbank 服务层 / cardforge 实体', () => {
    // 只闩 import 语句：头注允许以文字形式点名禁改区
    expect(MANIFEST_SOURCE).not.toMatch(/from ['"][^'"]*streaming_anki/);
    expect(MANIFEST_SOURCE).not.toContain('questionBankStore');
    expect(MANIFEST_SOURCE).not.toMatch(/from '@\/components\/anki\/cardforge/);
    expect(MANIFEST_SOURCE).not.toMatch(/from '@\/features\/chat\/services\/selectionCardGeneration'/);
  });
});
