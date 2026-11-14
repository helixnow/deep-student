import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { QuestionSourceViewer } from '@/components/QuestionSourceViewer';
import { QuestionMaterialView } from '@/components/QuestionMaterialView';
import { FinderQuickLook } from '@/features/learning-hub/components/finder/FinderQuickLook';
import { FinderFileItem } from '@/features/learning-hub/components/finder/FinderFileItem';
import { TextFilePreview } from '@/features/learning-hub/apps/views/TextFilePreview';
import { InteractiveHtmlCanvas } from '@/components/previews/InteractiveHtmlCanvas';
import { ContextUsageRing } from '@/features/chat/components/ContextUsageRing';
import { sharedModelListCache } from '@/features/chat/plugins/chat/ModelPanel';
import {
  createScopedStudyTimeTracker,
  getRealtimePendingStudySeconds,
} from '@/features/study-time/studyTimeTracker';

describe('DeepStudent-Go (dstugo) 7 modules live UI wiring', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('1. QuestionSourceViewer mounts SourceImageViewer zoom inspector & textHighlightAnchors', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'qbank_get_source_page') {
        return {
          source_id: 'src_math_1',
          page: 2,
          blob_hash: 'hash_page_2',
          width: 800,
          height: 1100,
          text: '洛必达法则适用于 0/0 与 ∞/∞ 型未定式极限。',
          source_name: '高等数学讲义.pdf',
          source_format: 'pdf',
          page_count: 10,
          available_pages: [1, 2, 3],
        };
      }
      if (cmd === 'vfs_get_blob_base64') {
        return {
          base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          mimeType: 'image/png',
        };
      }
      return null;
    });

    render(
      <QuestionSourceViewer
        isOpen={true}
        onClose={() => {}}
        examId="exam_1"
        sourceRefs={[{ source_id: 'src_math_1', page: 2, bbox: [0.1, 0.2, 0.8, 0.5] }]}
      />,
    );

    const toggleBtn = await screen.findByTestId('source-viewer-zoom-inspector-toggle');
    expect(toggleBtn).toBeInTheDocument();
    expect(screen.getByTestId('source-viewer-text-layer')).toHaveTextContent('洛必达法则');

    fireEvent.click(toggleBtn);
    expect(await screen.findByTestId('source-page-zoom-inspector')).toBeInTheDocument();
    expect(screen.getByTestId('source-image-viewer')).toBeInTheDocument();
  });

  it('2. FinderQuickLook & FinderFileItem render proceduralTextCover for note/text items', () => {
    render(
      <FinderQuickLook
        item={{
          id: 'note_1',
          name: '线性代数核心定理.md',
          path: '/线性代数核心定理.md',
          type: 'note',
          updatedAt: Date.now(),
          metadata: {
            contentPreview: '特征值与特征向量：设 A 是 n 阶方阵，若存在数 λ 及非零列向量 α 使得 Aα = λA。',
          },
        }}
        onClose={() => {}}
      />,
    );

    const coverImg = screen.getByTestId('quick-look-procedural-cover') as HTMLImageElement;
    expect(coverImg).toBeInTheDocument();
    expect(coverImg.src).toContain('data:image/svg+xml;charset=utf-8,');

    render(
      <FinderFileItem
        item={{
          id: 'note_2',
          name: '概率论笔记.md',
          path: '/概率论笔记.md',
          type: 'note',
          updatedAt: Date.now(),
          metadata: {
            coverMode: 'procedural',
            contentPreview: '中心极限定理与大数定律',
          },
        }}
        viewMode="grid"
        isSelected={false}
        onSelect={() => {}}
        onOpen={() => {}}
        onContextMenu={() => {}}
      />,
    );
    expect(screen.getByTestId('finder-item-procedural-cover')).toBeInTheDocument();
  });

  it('3. studyTimeTracker exposes scoped StudyTimeTracker & realtime pending study seconds', async () => {
    const reported: Array<{ date: string; seconds: number }> = [];
    const scoped = createScopedStudyTimeTracker(
      [{ date: '2026-11-10', seconds: 120 }],
      async (day) => {
        reported.push(day);
      },
    );
    expect(scoped.getRealtimeSeconds('2026-11-10')).toBe(120);
    expect(typeof getRealtimePendingStudySeconds()).toBe('number');
  });

  it('4. TextFilePreview wires SourceImageViewer & AgentCoEditHistoryManager single-step undo', async () => {
    render(
      <TextFilePreview
        fileName="lecture-notes.md"
        content={'# 第一章 导数\n\n原始定理内容。\n\n![原图](#source-image/course-1/page-3-region-100-200-300-400)'}
      />,
    );

    expect(screen.getByTestId('source-image-viewer')).toBeInTheDocument();
    expect(screen.getByText('原始定理内容。')).toBeInTheDocument();

    window.dispatchEvent(
      new CustomEvent('tfp:agent-markdown-edits', {
        detail: {
          fileName: 'lecture-notes.md',
          edits: [{ old_string: '原始定理内容。', new_string: 'AI 修订后的导数定理内容。' }],
        },
      }),
    );

    expect(await screen.findByText('AI 修订后的导数定理内容。')).toBeInTheDocument();
    const undoBtn = screen.getByTestId('tfp-undo-agent-coedit');
    fireEvent.click(undoBtn);
    await waitFor(() => {
      expect(screen.getByText('原始定理内容。')).toBeInTheDocument();
    });
  });

  it('5. InteractiveHtmlCanvas validates & displays WidgetAnswerFeedbackEnvelope', async () => {
    render(
      <InteractiveHtmlCanvas
        html="<div>Quiz Widget</div>"
        widgetId="quiz-widget-1"
      />,
    );

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'ds-canvas-answer-feedback',
          data: {
            version: 1,
            attemptId: 'attempt-1',
            requestId: 'attempt-1',
            status: 'correct',
            answer: 'B',
            correctAnswer: 'B',
            grading: 'host',
            authoritative: true,
            updatedAt: 1700000001000,
            timestamp: 1700000001000,
          },
        },
      }),
    );

    const badge = await screen.findByTestId('canvas-answer-feedback-badge');
    expect(badge).toHaveAttribute('data-feedback-status', 'correct');
    expect(badge).toHaveAttribute('data-feedback-authoritative', 'true');
  });

  it('6. QuestionMaterialView renders faithfulHtmlMaterial sandboxed iframe when toggled', async () => {
    render(
      <QuestionMaterialView
        materials={[
          {
            id: 'mat_html_1',
            content: '<article><h2>实验数据表</h2><table><tr><td>12.5</td></tr></table></article>',
            images: [],
            version: 1,
          },
        ]}
      />,
    );

    const toggle = screen.getByTestId('toggle-faithful-html-material');
    fireEvent.click(toggle);

    const iframe = await screen.findByTestId('faithful-html-material-iframe');
    expect(iframe).toHaveAttribute('sandbox', 'allow-same-origin');
    expect(iframe.getAttribute('srcdoc')).toContain('data-mr-unit="1"');
  });

  it('7. ContextUsageRing & sharedModelListCache wire prompt cache hit rate & model list cache', () => {
    sharedModelListCache.write('vendor://deepseek', ['deepseek-chat', 'deepseek-reasoner']);
    expect(sharedModelListCache.read('vendor://deepseek')?.ids).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
    ]);

    render(
      <ContextUsageRing
        usedTokens={24000}
        maxWindowTokens={128000}
        cacheObservations={[
          { inputTokens: 1000, cacheReadInputTokens: 800 },
          { inputTokens: 1000, cacheReadInputTokens: 600 },
        ]}
      />,
    );

    fireEvent.click(screen.getByTestId('context-usage-ring'));
    const hitRateRow = screen.getByTestId('context-usage-ring-cache-hit-rate');
    expect(hitRateRow).toHaveTextContent('70%');
  });
});
