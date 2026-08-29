/**
 * Chat V2 - AnkiCardsBlock 质检标记（_qa_flags）与媒体报告（mediaReport）展示测试
 *
 * 覆盖点：
 * - 卡片级 QA 徽标（图标+文本，不只靠颜色）、详情展开/收起（aria-expanded）
 * - `_qa_flags` 永不拼进 back / 不作为可编辑字段暴露
 * - 块级质检摘要条（N 张卡片带质检标记）
 * - 生成进度/完成态展示 mediaReport 跳过原因（本地化 + 样例文件名）
 * - 空 / 错误 / cancelled 态不回归
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import type { Block } from '@/features/chat/core/types';
import type { AnkiCardsBlockData } from '@/features/chat/plugins/blocks/ankiCardsBlock';

// Mock i18n：支持 {{var}} 插值，未知 key 回退 defaultValue / key 本身
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        'blocks.ankiCards.edit': 'Edit',
        'blocks.ankiCards.save': 'Save',
        'blocks.ankiCards.addToLibrary': 'Add to card library',
        'blocks.ankiCards.export': 'Export',
        'blocks.ankiCards.sync': 'Sync',
        'blocks.ankiCards.moreActions': 'More card actions',
        'blocks.ankiCards.reviewBatch': 'Review batch',
        'qaFlags.cardBadge': 'QA {{count}}',
        'qaFlags.severity.info': 'Info',
        'qaFlags.severity.warn': 'Warning',
        'qaFlags.severity.error': 'Error',
        'qaFlags.fieldLabel': 'Field',
        'qaFlags.showDetails': 'Show QA flag details',
        'qaFlags.hideDetails': 'Hide QA flag details',
        'qaFlags.cardFlagsAria': 'Card {{index}} has {{count}} QA flags, highest severity: {{severity}}',
        'qaFlags.flaggedCards': '{{count}} cards carry QA flags',
        'qaFlags.hint': 'Review flagged cards before exporting',
        'qaFlags.rules.maxLength': 'Exceeds the maximum length',
        'qaFlags.lint.front_too_long':
          'Front length {{n}} exceeds the minimum-information threshold {{limit}} (looks like a pasted paragraph)',
        'qaFlags.lint.empty_back': 'Back is empty or whitespace-only',
        'agent.critic.flaggedFlag': 'This card was flagged by the AI final review; please review it manually',
        'agent.critic.revisedFlag': 'This card was auto-revised by the AI final review; please double-check',
        'blocks.ankiCards.progress.media.summary':
          'Media: {{imported}}/{{declared}} imported, {{skipped}} skipped',
        'blocks.ankiCards.progress.media.skipReasonLine': '{{reason}} × {{count}}',
        'blocks.ankiCards.progress.media.filenamesSample': 'e.g. {{names}}',
        'blocks.ankiCards.progress.media.reasons.entryMissing': 'Entry missing from the package',
        'blocks.ankiCards.progress.media.reasons.unsafeFilename': 'Unsafe filename blocked',
      };
      const template = dict[key];
      if (!template) return (options?.defaultValue as string) || key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String(options?.[name] ?? ''),
      );
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

const mockInvoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);

vi.mock('@/features/chat/anki', () => ({
  saveCardsToLibrary: vi.fn(async () => undefined),
  exportCardsAsApkg: vi.fn(async () => undefined),
  importCardsViaAnkiConnect: vi.fn(async () => undefined),
  logChatAnkiEvent: vi.fn(),
  AnkiCardStackPreview: ({ status, cards, onClick, errorMessage }: any) => (
    <div>
      <button
        type="button"
        data-testid="anki-preview"
        data-status={status}
        data-count={cards?.length ?? 0}
        onClick={onClick}
      >
        preview
      </button>
      {errorMessage && <span data-testid="anki-preview-error">{errorMessage}</span>}
    </div>
  ),
  FullWidthCardWrapper: ({ children, className }: any) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@/features/workbench/core/workbenchBus', () => ({
  workbenchBus: {
    activate: vi.fn(async () => ({ delivered: true, result: { handled: true } })),
    launch: vi.fn(),
  },
}));

// 在 mocks 之后导入（触发注册）
import { AnkiCardsBlock } from '@/features/chat/plugins/blocks/ankiCardsBlock';
import { resetAnkiBlockUiState } from '@/features/chat/plugins/blocks/components/ankiCardsBlockState';

function createBlock(overrides?: Partial<Block>): Block {
  return {
    id: 'anki-block-qa-1',
    type: 'anki_cards',
    status: 'success',
    messageId: 'msg-1',
    ...overrides,
  };
}

function createData(overrides?: Partial<AnkiCardsBlockData>): AnkiCardsBlockData {
  return {
    cards: [],
    syncStatus: 'pending',
    businessSessionId: 'sess-1',
    messageStableId: 'stable-1',
    ...overrides,
  };
}

const FLAGGED_CARD = {
  id: 'card-flagged',
  front: 'Q-flagged',
  back: 'A-flagged',
  fields: { Front: 'Q-flagged', Back: 'A-flagged' },
  extra_fields: {
    // message 是后端中文诊断文本；前端应按稳定 code 走 i18n，只从中抽数字插值
    _qa_flags: JSON.stringify([
      {
        code: 'front_too_long',
        field: 'front',
        message: 'front 长度 250 超过最小信息原则阈值 220（疑似整段粘贴）',
        severity: 'warn',
      },
      { code: 'empty_back', field: 'back', message: 'back 为空或纯空白', severity: 'error' },
    ]),
  },
} as any;

const CLEAN_CARD = { id: 'card-clean', front: 'Q-clean', back: 'A-clean' } as any;

describe('AnkiCardsBlock QA flags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    resetAnkiBlockUiState();
  });

  it('renders a per-card QA badge with textual count and severity (not color-only)', () => {
    const block = createBlock();
    const data = createData({ cards: [FLAGGED_CARD, CLEAN_CARD] });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);
    // 展开卡片列表
    fireEvent.click(screen.getByTestId('anki-preview'));

    const badges = screen.getAllByTestId('chatanki-qa-flag-badge');
    // 只有带标记的卡片有徽标
    expect(badges).toHaveLength(1);
    // 文本传达：计数 + 最高严重度文字（error）
    expect(badges[0]).toHaveTextContent('QA 2');
    expect(badges[0]).toHaveTextContent('Error');
    expect(badges[0]).toHaveAttribute('data-severity', 'error');
    // 无障碍：aria-label 完整描述
    expect(badges[0]).toHaveAttribute(
      'aria-label',
      'Card 1 has 2 QA flags, highest severity: Error',
    );
  });

  it('expands and collapses flag details via the badge with aria-expanded wiring', () => {
    const block = createBlock();
    const data = createData({ cards: [FLAGGED_CARD] });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);
    fireEvent.click(screen.getByTestId('anki-preview'));

    const badge = screen.getByTestId('chatanki-qa-flag-badge');
    expect(badge).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('chatanki-qa-flag-details')).not.toBeInTheDocument();

    fireEvent.click(badge);
    expect(badge).toHaveAttribute('aria-expanded', 'true');
    const details = screen.getByTestId('chatanki-qa-flag-details');
    // 每条：严重度文本 + 字段 + 按 code 本地化的文案（数字参数从后端 message 抽取插值）
    expect(details).toHaveTextContent('Warning');
    expect(details).toHaveTextContent('Field: front');
    expect(details).toHaveTextContent(
      'Front length 250 exceeds the minimum-information threshold 220',
    );
    expect(details).toHaveTextContent('Error');
    expect(details).toHaveTextContent('Back is empty or whitespace-only');
    // 后端中文诊断 message 不得泄漏进非中文界面
    expect(details).not.toHaveTextContent('最小信息原则');
    expect(details).not.toHaveTextContent('纯空白');
    expect(badge).toHaveAttribute('aria-controls', details.getAttribute('id') as string);

    fireEvent.click(badge);
    expect(badge).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('chatanki-qa-flag-details')).not.toBeInTheDocument();
  });

  it('keeps QA detail aria-controls ids unique across multiple Anki blocks', () => {
    render(
      <>
        <AnkiCardsBlock
          block={{
            ...createBlock({ id: 'anki-block-qa-a' }),
            toolOutput: createData({ cards: [FLAGGED_CARD] }),
          }}
        />
        <AnkiCardsBlock
          block={{
            ...createBlock({ id: 'anki-block-qa-b' }),
            toolOutput: createData({ cards: [FLAGGED_CARD] }),
          }}
        />
      </>,
    );

    screen.getAllByTestId('anki-preview').forEach((preview) => fireEvent.click(preview));
    screen.getAllByTestId('chatanki-qa-flag-badge').forEach((badge) => fireEvent.click(badge));

    const detailIds = screen
      .getAllByTestId('chatanki-qa-flag-details')
      .map((details) => details.getAttribute('id'));
    expect(new Set(detailIds).size).toBe(2);
  });

  it('never renders raw _qa_flags JSON into the card back or the edit fields', () => {
    const block = createBlock();
    const data = createData({ cards: [FLAGGED_CARD] });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);
    fireEvent.click(screen.getByTestId('anki-preview'));

    // back 文本正常展示，原始 JSON 不出现在文档中
    expect(screen.getByText('A-flagged')).toBeInTheDocument();
    expect(screen.queryByText(/front_too_long/)).not.toBeInTheDocument();
    expect(screen.queryByText(/_qa_flags/)).not.toBeInTheDocument();

    // 进入编辑：可编辑字段只有 Front/Back，不包含 _qa_flags
    fireEvent.click(screen.getByText('Q-flagged'));
    const textareas = screen.getAllByRole('textbox');
    for (const textarea of textareas) {
      expect((textarea as HTMLTextAreaElement | HTMLInputElement).value).not.toContain('front_too_long');
    }
    expect(screen.queryByText('_qa_flags')).not.toBeInTheDocument();
    // 编辑头部仍有徽标可查（摘要不丢失）
    expect(screen.getByTestId('chatanki-qa-flag-badge')).toBeInTheDocument();
  });

  it('resolves legacy {field, rule, message} entries through rule i18n when message is absent', () => {
    const legacyCard = {
      id: 'card-legacy',
      front: 'Q-legacy',
      back: 'A-legacy',
      extra_fields: {
        _qa_flags: JSON.stringify([{ field: 'Question', rule: 'maxLength' }]),
      },
    } as any;
    const block = createBlock();
    const data = createData({ cards: [legacyCard] });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);
    fireEvent.click(screen.getByTestId('anki-preview'));

    const badge = screen.getByTestId('chatanki-qa-flag-badge');
    // 旧条目无 severity → warn
    expect(badge).toHaveAttribute('data-severity', 'warn');
    fireEvent.click(badge);
    const details = screen.getByTestId('chatanki-qa-flag-details');
    expect(details).toHaveTextContent('Field: Question');
    expect(details).toHaveTextContent('Exceeds the maximum length');
  });

  it('falls back to the backend message for unknown lint codes or messages missing numeric params', () => {
    const fallbackCard = {
      id: 'card-fallback',
      front: 'Q-fallback',
      back: 'A-fallback',
      extra_fields: {
        _qa_flags: JSON.stringify([
          // 未收录的未来 code → 直接展示后端 message（前向兼容）
          {
            code: 'future_lint_code',
            field: 'card',
            message: 'Raw backend diagnostic',
            severity: 'info',
          },
          // 有词条但 message 缺少预期数字参数 → 回退 message，不渲染带空洞的模板
          { code: 'front_too_long', field: 'front', message: 'threshold exceeded', severity: 'warn' },
        ]),
      },
    } as any;
    const block = createBlock();
    const data = createData({ cards: [fallbackCard] });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);
    fireEvent.click(screen.getByTestId('anki-preview'));
    fireEvent.click(screen.getByTestId('chatanki-qa-flag-badge'));

    const details = screen.getByTestId('chatanki-qa-flag-details');
    expect(details).toHaveTextContent('Raw backend diagnostic');
    expect(details).toHaveTextContent('threshold exceeded');
    expect(details).not.toHaveTextContent('minimum-information threshold');
  });

  it('renders critic revise/flag audit codes with localized preview messages', () => {
    const criticCard = {
      id: 'card-critic',
      front: 'Q-critic',
      back: 'A-critic',
      extra_fields: {
        _qa_flags: JSON.stringify([
          {
            code: 'llm_critic',
            field: 'card',
            message: 'LLM critic 标记：与另一张卡重复',
            severity: 'warn',
          },
          {
            code: 'llm_critic_revised',
            field: 'card',
            message: 'LLM critic 修订：答案与源材料矛盾',
            severity: 'info',
          },
        ]),
      },
    } as any;

    render(
      <AnkiCardsBlock
        block={{ ...createBlock(), toolOutput: createData({ cards: [criticCard] }) }}
      />,
    );
    fireEvent.click(screen.getByTestId('anki-preview'));

    const badge = screen.getByTestId('chatanki-qa-flag-badge');
    expect(badge).toHaveTextContent('QA 2');
    expect(badge).toHaveAttribute('data-severity', 'warn');
    fireEvent.click(badge);

    const details = screen.getByTestId('chatanki-qa-flag-details');
    expect(details).toHaveTextContent(
      'This card was flagged by the AI final review; please review it manually',
    );
    expect(details).toHaveTextContent(
      'This card was auto-revised by the AI final review; please double-check',
    );
    expect(details).not.toHaveTextContent('LLM critic 标记');
    expect(details).not.toHaveTextContent('LLM critic 修订');
  });

  it('shows a block-level flagged summary chip in both collapsed and expanded layouts', () => {
    const block = createBlock();
    const data = createData({ cards: [FLAGGED_CARD, CLEAN_CARD] });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    // 折叠态即可见
    const summary = screen.getByTestId('chatanki-qa-flags-summary');
    expect(summary).toHaveTextContent('1 cards carry QA flags');
    expect(summary).toHaveTextContent('Review flagged cards before exporting');
    expect(summary).toHaveAttribute('role', 'note');

    // 展开后依旧存在
    fireEvent.click(screen.getByTestId('anki-preview'));
    expect(screen.getByTestId('chatanki-qa-flags-summary')).toBeInTheDocument();
  });
});

describe('AnkiCardsBlock media report', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    resetAnkiBlockUiState();
  });

  const MEDIA_REPORT = {
    declared: 3,
    imported: 1,
    skipped: 2,
    skips: [
      { reason: 'entry_missing', count: 1, filenames: ['gone.png'] },
      { reason: 'unsafe_filename', count: 1, filenames: ['../evil.sh'] },
    ],
    mediaDir: '/tmp/anki_media',
  };

  it('renders media skip reasons during generation progress', () => {
    const block = createBlock({ status: 'running' });
    const data = createData({
      cards: [CLEAN_CARD],
      progress: { stage: 'generating', cardsGenerated: 1 },
      mediaReport: MEDIA_REPORT,
    });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} isStreaming />);

    expect(screen.getByTestId('chatanki-progress')).toBeInTheDocument();
    expect(screen.getByTestId('chatanki-media-report-summary')).toHaveTextContent(
      'Media: 1/3 imported, 2 skipped',
    );
    expect(screen.getByTestId('chatanki-media-skip-entry_missing')).toHaveTextContent(
      'Entry missing from the package × 1',
    );
    expect(screen.getByTestId('chatanki-media-skip-unsafe_filename')).toHaveTextContent(
      'Unsafe filename blocked × 1',
    );
    // 样例文件名
    expect(screen.getByTestId('chatanki-media-report')).toHaveTextContent('e.g. gone.png');
  });

  it('shows the media report on completion even when progress/ankiConnect are absent', () => {
    const block = createBlock({ status: 'success' });
    const data = createData({ cards: [CLEAN_CARD], mediaReport: MEDIA_REPORT });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    // 仅凭 mediaReport 也应渲染进度容器与媒体明细
    expect(screen.getByTestId('chatanki-progress')).toBeInTheDocument();
    expect(screen.getByTestId('chatanki-media-report-skips')).toBeInTheDocument();
    // 未知原因回退展示原文（协议演进容错）
    expect(screen.getByTestId('chatanki-media-skip-entry_missing')).toBeInTheDocument();
    // 只有媒体报告时没有连接检测上下文，不误报 AnkiConnect“检查中”
    expect(screen.queryByTestId('chatanki-progress-anki-connect')).not.toBeInTheDocument();
  });

  it('renders a clean summary without a skip list when everything imported', () => {
    const block = createBlock({ status: 'success' });
    const data = createData({
      cards: [CLEAN_CARD],
      mediaReport: { declared: 2, imported: 2, skipped: 0, skips: [] },
    });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    expect(screen.getByTestId('chatanki-media-report-summary')).toHaveTextContent(
      'Media: 2/2 imported, 0 skipped',
    );
    expect(screen.queryByTestId('chatanki-media-report-skips')).not.toBeInTheDocument();
  });

  it('falls back to the raw reason string for unknown skip reasons', () => {
    const block = createBlock({ status: 'success' });
    const data = createData({
      cards: [CLEAN_CARD],
      mediaReport: {
        declared: 1,
        imported: 0,
        skipped: 1,
        skips: [{ reason: 'future_new_reason', count: 1, filenames: [] }],
      },
    });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    expect(screen.getByTestId('chatanki-media-skip-future_new_reason')).toHaveTextContent(
      'future_new_reason × 1',
    );
  });
});

describe('AnkiCardsBlock QA/media regressions for empty, error, cancelled states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    resetAnkiBlockUiState();
  });

  it('keeps the empty state clean: no badge, no summary chip, no media section', () => {
    const block = createBlock({ status: 'pending' });
    const data = createData({ cards: [] });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    expect(screen.getByTestId('anki-preview')).toHaveAttribute('data-status', 'parsing');
    expect(screen.queryByTestId('chatanki-qa-flag-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chatanki-qa-flags-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chatanki-media-report')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chatanki-progress')).not.toBeInTheDocument();
  });

  it('keeps the error state contract and omits QA/media widgets when data is absent', () => {
    const block = createBlock({ status: 'error', error: 'Generation failed' });
    const data = createData({ cards: [CLEAN_CARD] });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    expect(screen.getByTestId('anki-preview')).toHaveAttribute('data-status', 'error');
    expect(screen.getByTestId('anki-preview-error')).toHaveTextContent('Generation failed');
    expect(screen.queryByTestId('chatanki-qa-flags-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chatanki-media-report')).not.toBeInTheDocument();
  });

  it('keeps the cancelled preview status while still surfacing the media report', () => {
    const block = createBlock({ status: 'success' });
    const data = createData({
      cards: [CLEAN_CARD],
      finalStatus: 'cancelled',
      finalError: 'Stopped by user',
      progress: { stage: 'completed_with_errors' },
      mediaReport: {
        declared: 1,
        imported: 0,
        skipped: 1,
        skips: [{ reason: 'entry_missing', count: 1, filenames: ['gone.png'] }],
      },
    });

    render(<AnkiCardsBlock block={{ ...block, toolOutput: data }} />);

    expect(screen.getByTestId('anki-preview')).toHaveAttribute('data-status', 'cancelled');
    expect(screen.getByTestId('chatanki-media-report-summary')).toHaveTextContent(
      'Media: 0/1 imported, 1 skipped',
    );
    const cancellationNotice = screen.getByTestId('chatanki-progress-error');
    expect(cancellationNotice).toHaveAttribute('role', 'status');
    expect(cancellationNotice).toHaveClass('text-warning');
    expect(cancellationNotice).not.toHaveClass('text-destructive');
    // 明确 cancelled 必须压过迟到的 completed_with_errors progress 快照。
    expect(screen.queryByTestId('chatanki-progress-completed-with-errors')).not.toBeInTheDocument();
  });
});
