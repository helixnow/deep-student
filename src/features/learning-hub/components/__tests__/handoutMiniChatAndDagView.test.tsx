import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  HandoutReaderView,
  handoutIrToMarkdown,
  validateHandoutIr,
  type HandoutDocument,
} from '../HandoutReaderView';
import {
  ContextualMiniChat,
  type MiniChatContextAnchor,
} from '@/features/chat/components/ContextualMiniChat';
import {
  ProjectKnowledgeDagDrawer,
  ProjectKnowledgeDagStore,
} from '@/features/chat/components/ProjectKnowledgeDagDrawer';

// ============================================================================
// 测试夹具数据
// ============================================================================

const SAMPLE_HANDOUT_DOC: HandoutDocument = {
  id: 'handout-fourier-01',
  title: '傅里叶级数与正交函数系精讲',
  courseName: '高等数学 · 下册',
  date: '2026-11-09',
  summary:
    '本讲义系统梳理三角函数系的正交性、傅里叶系数求解公式以及狄利克雷（Dirichlet）收敛定理的几何意义与典型考法。',
  estimatedMinutes: 25,
  difficulty: 'intermediate',
  sections: [
    {
      id: 'sec-orthogonality',
      heading: '三角函数系的正交性',
      difficulty: 'foundation',
      estimatedMinutes: 8,
      blocks: [
        {
          type: 'lead',
          text: '正交性是将复杂周期信号分解为简谐分量的代数基石。',
        },
        {
          type: 'callout',
          kind: 'definition',
          title: '正交函数系定义',
          text: '在区间 [-π, π] 上，任意两个不同频率的三角函数乘积之定积分恒等于零。',
        },
        {
          type: 'formula',
          latex: '\\int_{-\\pi}^{\\pi} \\cos(nx)\\sin(mx)\\,dx = 0',
          label: '式 1.1',
          explanation: '利用奇偶性或积化和差公式可直接证明。',
        },
        {
          type: 'checkpoint',
          id: 'cp-1',
          question: '在 [-π, π] 上，∫ cos(2x)cos(2x) dx 的值为多少？',
          options: ['0', 'π', '2π', 'π/2'],
          answerIndex: 1,
          explanation: '利用倍角公式 cos²(2x) = (1 + cos(4x))/2，在 [-π, π] 上积分得 π。',
          difficulty: 'foundation',
        },
      ],
    },
    {
      id: 'sec-dirichlet',
      heading: '狄利克雷收敛定理',
      difficulty: 'intermediate',
      estimatedMinutes: 10,
      blocks: [
        {
          type: 'callout',
          kind: 'theorem',
          title: '狄利克雷充分条件',
          text: '若周期函数在单周期内分段单调且至多有有限个第一类间断点，则傅里叶级数在间断点处收敛于左右极限的算术平均值。',
        },
        {
          type: 'diagram',
          caption: '方波信号在间断点处的吉布斯（Gibbs）过冲现象示意图',
          svg: '<svg width="160" height="48" viewBox="0 0 160 48"><path d="M10 38 L10 12 L80 12 L80 38 L150 38" stroke="currentColor" fill="none"/></svg>',
        },
        {
          type: 'checkpoint',
          id: 'cp-2',
          question: '设 f(x) 在 x₀ 处发生跳跃间断，左极限为 -1，右极限为 3，则傅里叶级数在 x₀ 处收敛于：',
          options: ['0', '1', '2', '不存在'],
          answerIndex: 1,
          explanation: '根据狄利克雷收敛定理，收敛值为 (f(x₀⁻) + f(x₀⁺)) / 2 = (-1 + 3) / 2 = 1。',
          difficulty: 'intermediate',
        },
      ],
    },
    {
      id: 'sec-parseval',
      heading: '帕塞瓦尔恒等式与无穷级数求和',
      difficulty: 'olympiad',
      estimatedMinutes: 7,
      blocks: [
        {
          type: 'para',
          text: '利用帕塞瓦尔能量守恒定理，可以将棘手的数项级数求和转化为定积分计算。',
        },
        {
          type: 'table',
          caption: '常见周期延拓奇偶性对比',
          header: ['延拓方式', '系数特征', '适用半区间展开'],
          rows: [
            ['偶延拓', 'b_n = 0', '余弦级数'],
            ['奇延拓', 'a_n = 0', '正弦级数'],
          ],
        },
      ],
    },
  ],
};

function createSampleDagStore() {
  const store = new ProjectKnowledgeDagStore();
  const plan = store.savePlan({
    body: [
      '# 傅里叶分析三阶段攻坚计划',
      '',
      '## Steps',
      '- [x] 推导正交积分公式',
      '- [ ] 完成收敛定理间断点判别训练',
      '- [ ] 攻克帕塞瓦尔级数求和综合题',
    ].join('\n'),
  });

  const todo1 = store.saveTodo({
    body: '完成正交函数系基础积分推导',
    planId: plan.id,
    completed: false,
    dependsOn: [],
  });

  const todo2 = store.saveTodo({
    body: '训练狄利克雷间断点收敛值计算',
    planId: plan.id,
    completed: false,
    dependsOn: [todo1.id],
  });

  const todo3 = store.saveTodo({
    body: '挑战帕塞瓦尔恒等式求 ∑(1/n⁴)',
    planId: plan.id,
    completed: false,
    dependsOn: [todo2.id],
  });

  const note = store.saveNote({
    body: '课堂重点：第一类间断点处的收敛值一定是左右极限均值，与函数在该点的定义值无关。',
  });

  return { store, plan, todo1, todo2, todo3, note };
}

// ============================================================================
// 测试用例集（共 18 个用例）
// ============================================================================

describe('Lane 3 三大高价值新视图组件集成测试', () => {
  describe('1. HandoutReaderView（DeepStudent-Go 印刷级讲义阅读器）', () => {
    it('1.1 正确校验讲义 IR 并转换生成结构化 Markdown', () => {
      const validResult = validateHandoutIr(SAMPLE_HANDOUT_DOC);
      expect(validResult.valid).toBe(true);
      expect(validResult.errors).toHaveLength(0);

      const invalidResult = validateHandoutIr({ title: '', sections: [] });
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors.length).toBeGreaterThan(0);

      const md = handoutIrToMarkdown(SAMPLE_HANDOUT_DOC);
      expect(md).toContain('# 傅里叶级数与正交函数系精讲');
      expect(md).toContain('## 一、三角函数系的正交性');
      expect(md).toContain('【基本定义 · 正交函数系定义】');
      expect(md).toContain('\\int_{-\\pi}^{\\pi} \\cos(nx)\\sin(mx)\\,dx = 0');
    });

    it('1.2 完整渲染标题、摘要、预估时长、难度徽标、定理/定义 Callout、公式块与 SVG 图表块', () => {
      render(<HandoutReaderView document={SAMPLE_HANDOUT_DOC} />);

      expect(screen.getByText('傅里叶级数与正交函数系精讲')).toBeInTheDocument();
      expect(screen.getByText(/本讲义系统梳理三角函数系的正交性/)).toBeInTheDocument();
      expect(screen.getByText('25')).toBeInTheDocument();

      // 定理与定义 Callout 块
      expect(screen.getByTestId('handout-callout-definition')).toHaveTextContent(
        '正交函数系定义',
      );
      expect(screen.getByTestId('handout-callout-theorem')).toHaveTextContent(
        '狄利克雷充分条件',
      );

      // 公式块与推导注记
      expect(screen.getByTestId('handout-formula-block')).toHaveTextContent('式 1.1');
      expect(screen.getByText(/利用奇偶性或积化和差公式可直接证明/)).toBeInTheDocument();

      // 图表 SVG 块
      expect(screen.getByTestId('handout-diagram-block')).toHaveTextContent(
        '方波信号在间断点处的吉布斯（Gibbs）过冲现象示意图',
      );
    });

    it('1.3 支持按难度等级（foundation / intermediate / olympiad）筛选章节目录与正文', () => {
      render(<HandoutReaderView document={SAMPLE_HANDOUT_DOC} />);

      const filterGroup = screen.getByRole('group', { name: '难度筛选' });

      // 初始显示全部 3 个章节
      expect(screen.getByTestId('handout-section-sec-orthogonality')).toBeInTheDocument();
      expect(screen.getByTestId('handout-section-sec-dirichlet')).toBeInTheDocument();
      expect(screen.getByTestId('handout-section-sec-parseval')).toBeInTheDocument();

      // 筛选「竞赛挑战」(olympiad)
      fireEvent.click(within(filterGroup).getByRole('button', { name: '竞赛挑战' }));
      expect(
        screen.queryByTestId('handout-section-sec-orthogonality'),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId('handout-section-sec-dirichlet'),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId('handout-section-sec-parseval')).toBeInTheDocument();

      // 切回「全部章节」
      fireEvent.click(within(filterGroup).getByRole('button', { name: '全部章节' }));
      expect(screen.getByTestId('handout-section-sec-orthogonality')).toBeInTheDocument();
    });

    it('1.4 支持章节目录导航点击切换与阅读进度（font-mono tabular-nums）更新', () => {
      render(<HandoutReaderView document={SAMPLE_HANDOUT_DOC} />);

      const progressEl = screen.getByTestId('handout-reading-progress');
      expect(progressEl).toHaveTextContent('0/3');
      expect(progressEl).toHaveTextContent('(0%)');

      // 点击第一章「标记已读」
      const sec1 = screen.getByTestId('handout-section-sec-orthogonality');
      fireEvent.click(within(sec1).getByRole('button', { name: '标记已读' }));

      expect(progressEl).toHaveTextContent('1/3');
      expect(progressEl).toHaveTextContent('(33%)');
    });

    it('1.5 内联自测题（Checkpoint）点击选项即时判题、显示解析并实时统计得分率', () => {
      render(<HandoutReaderView document={SAMPLE_HANDOUT_DOC} />);

      const scoreEl = screen.getByTestId('handout-checkpoint-score');
      expect(scoreEl).toHaveTextContent('0%');
      expect(scoreEl).toHaveTextContent('(0/2)');

      // 第 1 题选正确选项 B ('π')
      const cp1 = screen.getByTestId('handout-checkpoint-cp-1');
      fireEvent.click(within(cp1).getByRole('button', { name: /B\.\s*π/ }));

      expect(within(cp1).getByText('回答正确')).toBeInTheDocument();
      expect(screen.getByTestId('checkpoint-explanation-cp-1')).toHaveTextContent(
        '利用倍角公式',
      );
      expect(scoreEl).toHaveTextContent('100%');
      expect(scoreEl).toHaveTextContent('(1/2)');

      // 第 2 题故意选错误选项 A ('0')
      const cp2 = screen.getByTestId('handout-checkpoint-cp-2');
      fireEvent.click(within(cp2).getByRole('button', { name: /A\.\s*0/ }));

      expect(within(cp2).getByText('回答错误')).toBeInTheDocument();
      expect(screen.getByTestId('checkpoint-explanation-cp-2')).toHaveTextContent(
        '根据狄利克雷收敛定理',
      );
      // 2 题对 1 题，得分率 50%
      expect(scoreEl).toHaveTextContent('50%');
      expect(scoreEl).toHaveTextContent('(1/2)');
    });

    it('1.6 顶栏「导出 Markdown」、「转存至笔记」与「打印视图」回调按钮正确触发', async () => {
      const onExportMarkdown = vi.fn();
      const onSaveToNote = vi.fn();
      const onPrintView = vi.fn();

      render(
        <HandoutReaderView
          document={SAMPLE_HANDOUT_DOC}
          onExportMarkdown={onExportMarkdown}
          onSaveToNote={onSaveToNote}
          onPrintView={onPrintView}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: '导出 Markdown' }));
      expect(onExportMarkdown).toHaveBeenCalledTimes(1);
      expect(onExportMarkdown.mock.calls[0][0]).toContain(
        '# 傅里叶级数与正交函数系精讲',
      );

      fireEvent.click(screen.getByRole('button', { name: '转存至笔记' }));
      await waitFor(() => {
        expect(onSaveToNote).toHaveBeenCalledTimes(1);
      });
      expect(onSaveToNote.mock.calls[0][0]).toMatchObject({
        title: '傅里叶级数与正交函数系精讲',
      });
      expect(onSaveToNote.mock.calls[0][1]).toContain('# 傅里叶级数与正交函数系精讲');

      fireEvent.click(screen.getByRole('button', { name: '打印视图' }));
      expect(onPrintView).toHaveBeenCalledTimes(1);
      const rootView = screen.getByTestId('handout-reader-view');
      expect(rootView).toHaveAttribute('data-print-mode', 'true');
      expect(rootView.className).not.toContain('bg-white');
      expect(rootView.className).not.toContain('text-black');
    });

    it('1.7 [安全红线] 严格消毒 diagram SVG 块，保留合法图形节点并 100% 剥离 script、onload 等危险载荷', () => {
      const maliciousDoc: HandoutDocument = {
        title: 'SVG 安全消毒验证讲义',
        summary: '验证讲义内联 SVG 图表对 XSS 载荷的严格剥离。',
        sections: [
          {
            id: 'sec-xss',
            heading: '向量场示意图',
            blocks: [
              {
                type: 'diagram',
                caption: '带恶意载荷注入尝试的 SVG 图表',
                svg: '<svg onload="alert(1)" onclick="alert(2)"><script>window.__xss=1</script><foreignObject><div>evil</div></foreignObject><a href="javascript:alert(3)"><circle cx="10" cy="10" r="5" onerror="alert(4)" /></a></svg>',
              },
            ],
          },
        ],
      };

      render(<HandoutReaderView document={maliciousDoc} />);

      const diagramFigure = screen.getByTestId('handout-diagram-block');
      const svgEl = diagramFigure.querySelector('svg');
      const circleEl = diagramFigure.querySelector('circle');

      expect(svgEl).not.toBeNull();
      expect(circleEl).not.toBeNull();
      expect(circleEl?.getAttribute('cx')).toBe('10');
      expect(circleEl?.getAttribute('r')).toBe('5');

      // 危险标签与事件属性必须被 100% 剥离
      expect(diagramFigure.querySelector('script')).toBeNull();
      expect(diagramFigure.querySelector('foreignObject')).toBeNull();
      expect(svgEl?.hasAttribute('onload')).toBe(false);
      expect(svgEl?.hasAttribute('onclick')).toBe(false);
      expect(circleEl?.hasAttribute('onerror')).toBe(false);
      expect(diagramFigure.innerHTML).not.toContain('window.__xss');
      expect(diagramFigure.innerHTML).not.toContain('javascript:');
    });

    it('1.8 仅当 onSaveToNote 未抛错且返回值 !== false 时才显示「已转存至笔记」，且难度筛选隐藏当前章节时自动回退并区分表格数值排版', async () => {
      const docWithMixedTable: HandoutDocument = {
        ...SAMPLE_HANDOUT_DOC,
        sections: [
          ...SAMPLE_HANDOUT_DOC.sections.slice(0, 2),
          {
            id: 'sec-parseval',
            heading: '帕塞瓦尔恒等式与无穷级数求和',
            difficulty: 'olympiad',
            estimatedMinutes: 7,
            blocks: [
              {
                type: 'table',
                caption: '常见级数收敛速度对比',
                header: ['级数名称', '收敛阶', '前10项误差'],
                rows: [['傅里叶余弦级数', '2', '0.5%']],
              },
            ],
          },
        ],
      };

      const onSaveFalse = vi.fn().mockReturnValue(false);
      render(<HandoutReaderView document={docWithMixedTable} onSaveToNote={onSaveFalse} />);

      // 1) 当 onSaveToNote 返回 false 时，绝不假装显示「已转存至笔记」
      const saveBtn = screen.getByRole('button', { name: '转存至笔记' });
      fireEvent.click(saveBtn);
      await waitFor(() => {
        expect(onSaveFalse).toHaveBeenCalledTimes(1);
      });
      expect(saveBtn).toHaveAttribute('data-saved', 'false');
      expect(screen.queryByText('已转存至笔记')).not.toBeInTheDocument();

      // 2) 表格普通文本单元格不加 font-mono tabular-nums，纯数值单元格保留等宽数字排版
      const textCell = screen.getByRole('cell', { name: '傅里叶余弦级数' });
      const intCell = screen.getByRole('cell', { name: '2' });
      const percentCell = screen.getByRole('cell', { name: '0.5%' });
      expect(textCell.className).not.toContain('font-mono');
      expect(intCell.className).toContain('font-mono');
      expect(intCell.className).toContain('tabular-nums');
      expect(percentCell.className).toContain('font-mono');

      // 3) 初始选中第 1 章 (sec-orthogonality, foundation)，筛选 olympiad 后自动回退选中 sec-parseval
      expect(screen.getByTestId('handout-section-sec-orthogonality')).toHaveAttribute(
        'data-active',
        'true',
      );
      const filterGroup = screen.getByRole('group', { name: '难度筛选' });
      fireEvent.click(within(filterGroup).getByRole('button', { name: '竞赛挑战' }));
      expect(screen.getByTestId('handout-section-sec-parseval')).toHaveAttribute(
        'data-active',
        'true',
      );
    });
  });

  describe('2. ContextualMiniChat（OpenChamber 风格伴读悬浮小窗）', () => {
    const pdfAnchor: MiniChatContextAnchor = {
      kind: 'pdf_page',
      label: 'PDF 第 14 页',
      referenceId: 'page-14',
      snippet: '定理 3.2：一致收敛级数可以逐项积分。',
    };

    const videoAnchor: MiniChatContextAnchor = {
      kind: 'video_timestamp',
      label: '04:35 傅里叶收敛定理',
      referenceId: 'ts-275',
    };

    it('2.1 在迷你输入框上方以胶囊形式展示当前绑定的上下文锚点与引用摘要', () => {
      render(<ContextualMiniChat anchor={pdfAnchor} />);

      const pill = screen.getByTestId('mini-chat-anchor-pill');
      expect(pill).toHaveTextContent('PDF 页码');
      expect(pill).toHaveTextContent('PDF 第 14 页');
      expect(
        screen.getByText(/定理 3.2：一致收敛级数可以逐项积分/),
      ).toBeInTheDocument();
    });

    it('2.2 当外部上下文锚点切换（如从 PDF 页切换到视频时间点）时自动更新胶囊，且支持手动移除锚点', () => {
      const onClearAnchor = vi.fn();
      const { rerender } = render(
        <ContextualMiniChat anchor={pdfAnchor} onClearAnchor={onClearAnchor} />,
      );

      expect(screen.getByTestId('mini-chat-anchor-pill')).toHaveTextContent(
        'PDF 第 14 页',
      );

      rerender(
        <ContextualMiniChat anchor={videoAnchor} onClearAnchor={onClearAnchor} />,
      );
      expect(screen.getByTestId('mini-chat-anchor-pill')).toHaveTextContent(
        '视频时间点',
      );
      expect(screen.getByTestId('mini-chat-anchor-pill')).toHaveTextContent(
        '04:35 傅里叶收敛定理',
      );

      fireEvent.click(screen.getByRole('button', { name: '移除上下文锚点' }));
      expect(onClearAnchor).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('mini-chat-anchor-pill')).not.toBeInTheDocument();
      expect(screen.getByText('当前未绑定上下文锚点')).toBeInTheDocument();
    });

    it('2.3 支持最小化为悬浮胶囊（展示 6px 未读回复脉冲点与计数）及重新展开为伴读窗', () => {
      render(
        <ContextualMiniChat
          anchor={videoAnchor}
          defaultMinimized
          unreadCount={3}
        />,
      );

      const pill = screen.getByTestId('contextual-mini-chat-pill');
      expect(pill).toBeInTheDocument();

      const pulseDot = screen.getByTestId('mini-chat-unread-pulse');
      expect(pulseDot.className).toContain('w-1.5');
      expect(pulseDot.className).toContain('h-1.5');

      expect(screen.getByTestId('mini-chat-unread-count')).toHaveTextContent('3');

      // 点击展开伴读小窗
      fireEvent.click(screen.getByRole('button', { name: '展开伴读小窗' }));
      expect(screen.getByTestId('contextual-mini-chat')).toBeInTheDocument();

      // 点击最小化按钮回到胶囊态
      fireEvent.click(screen.getByRole('button', { name: '最小化伴读小窗' }));
      expect(screen.getByTestId('contextual-mini-chat-pill')).toBeInTheDocument();
    });

    it('2.4 点击快捷指令预设（「解释当前段落」、「推导此步公式」、「出一道变式题」）自动携带锚点发送', () => {
      const onSendMessage = vi.fn();
      render(
        <ContextualMiniChat anchor={videoAnchor} onSendMessage={onSendMessage} />,
      );

      fireEvent.click(screen.getByRole('button', { name: '解释当前段落' }));
      expect(onSendMessage).toHaveBeenCalledTimes(1);
      expect(onSendMessage.mock.calls[0][0]).toMatchObject({
        anchor: videoAnchor,
        presetId: 'explain_paragraph',
      });
      expect(onSendMessage.mock.calls[0][0].text).toContain('04:35 傅里叶收敛定理');

      fireEvent.click(screen.getByRole('button', { name: '推导此步公式' }));
      expect(onSendMessage).toHaveBeenCalledTimes(2);
      expect(onSendMessage.mock.calls[1][0].presetId).toBe('derive_formula');

      fireEvent.click(screen.getByRole('button', { name: '出一道变式题' }));
      expect(onSendMessage).toHaveBeenCalledTimes(3);
      expect(onSendMessage.mock.calls[2][0].presetId).toBe('generate_variant');
    });

    it('2.5 支持自由输入伴读提问并触发「迁入主会话（Promote to Main Chat）」回调', () => {
      const onSendMessage = vi.fn();
      const onPromoteToMainChat = vi.fn();

      render(
        <ContextualMiniChat
          anchor={pdfAnchor}
          onSendMessage={onSendMessage}
          onPromoteToMainChat={onPromoteToMainChat}
        />,
      );

      const input = screen.getByRole('textbox', { name: '伴读提问输入框' });
      fireEvent.change(input, {
        target: { value: '为什么非一致收敛不能直接交换积分与极限次序？' },
      });
      fireEvent.click(screen.getByRole('button', { name: '发送伴读提问' }));

      expect(onSendMessage).toHaveBeenCalledWith({
        text: '为什么非一致收敛不能直接交换积分与极限次序？',
        anchor: pdfAnchor,
        presetId: undefined,
      });

      // 点击「迁入主会话」
      fireEvent.click(screen.getByTestId('promote-to-main-chat-btn'));
      expect(onPromoteToMainChat).toHaveBeenCalledTimes(1);
      const promotedPayload = onPromoteToMainChat.mock.calls[0][0];
      expect(promotedPayload.anchor).toEqual(pdfAnchor);
      expect(promotedPayload.messages).toHaveLength(1);
      expect(promotedPayload.messages[0].content).toBe(
        '为什么非一致收敛不能直接交换积分与极限次序？',
      );
    });

    it('2.6 支持将 onSendMessage 返回的伴读回答即时追加到消息流，并兼容 jsdom 新消息自动滚动到底部', async () => {
      const scrollSpy = vi.fn();
      const originalScrollTo = HTMLElement.prototype.scrollTo;
      HTMLElement.prototype.scrollTo = scrollSpy;

      try {
        render(
          <ContextualMiniChat
            anchor={videoAnchor}
            onSendMessage={({ text }) => `伴读解析回复：已定位关键推导（针对「${text}」）`}
          />,
        );

        const input = screen.getByRole('textbox', { name: '伴读提问输入框' });
        fireEvent.change(input, { target: { value: '狄利克雷条件的核心假设是什么？' } });
        fireEvent.click(screen.getByRole('button', { name: '发送伴读提问' }));

        const msgList = screen.getByTestId('mini-chat-message-list');
        expect(msgList).toHaveTextContent('狄利克雷条件的核心假设是什么？');
        expect(msgList).toHaveTextContent('伴读解析回复：已定位关键推导');
        expect(scrollSpy).toHaveBeenCalled();
      } finally {
        HTMLElement.prototype.scrollTo = originalScrollTo;
      }
    });
  });

  describe('3. ProjectKnowledgeDagDrawer（项目知识与学习计划 DAG 拓扑抽屉）', () => {
    it('3.1 绑定 ProjectKnowledgeDagStore 并清晰展示计划进度条与 font-mono tabular-nums 统计', () => {
      const { store } = createSampleDagStore();
      render(<ProjectKnowledgeDagDrawer store={store} />);

      expect(screen.getByText('傅里叶分析三阶段攻坚计划')).toBeInTheDocument();
      expect(screen.getByTestId('dag-completion-badge')).toHaveTextContent(
        '0/3 (0%)',
      );
      expect(screen.getByTestId('dag-ready-count')).toHaveTextContent('1');
      expect(screen.getByTestId('dag-blocked-count')).toHaveTextContent('2');
      expect(screen.getByTestId('dag-completed-count')).toHaveTextContent('0');
    });

    it('3.2 正确区分 Ready（绿点 6px + 就绪可执行）与 Blocked（展示「等待前置：<前置任务名>」徽标且禁止直接勾选）', () => {
      const { store, todo1, todo2, todo3 } = createSampleDagStore();
      render(<ProjectKnowledgeDagDrawer store={store} />);

      const todo1Item = screen.getByTestId(`dag-todo-item-${todo1.id}`);
      const todo2Item = screen.getByTestId(`dag-todo-item-${todo2.id}`);
      const todo3Item = screen.getByTestId(`dag-todo-item-${todo3.id}`);

      expect(todo1Item).toHaveAttribute('data-dag-status', 'ready');
      expect(within(todo1Item).getByText('就绪可执行')).toBeInTheDocument();
      expect(screen.getByTestId(`dag-todo-dot-${todo1.id}`).className).toContain(
        'bg-success',
      );

      expect(todo2Item).toHaveAttribute('data-dag-status', 'blocked');
      expect(screen.getByTestId(`dag-blocked-badge-${todo2.id}`)).toHaveTextContent(
        '等待前置：完成正交函数系基础积分推导',
      );

      expect(todo3Item).toHaveAttribute('data-dag-status', 'blocked');
      expect(screen.getByTestId(`dag-blocked-badge-${todo3.id}`)).toHaveTextContent(
        '等待前置：训练狄利克雷间断点收敛值计算',
      );

      // 被阻塞的任务复选按钮处于 disabled 状态
      const blockedCheckbox = within(todo2Item).getByRole('button', {
        name: /勾选任务：训练狄利克雷间断点收敛值计算/,
      });
      expect(blockedCheckbox).toBeDisabled();
    });

    it('3.3 勾选完成前置 Ready 任务后，下游被阻塞任务自动解锁为 Ready，进度百分比同步更新', () => {
      const { store, todo1, todo2, todo3 } = createSampleDagStore();
      const onToggleTodo = vi.fn();
      render(
        <ProjectKnowledgeDagDrawer store={store} onToggleTodo={onToggleTodo} />,
      );

      // 勾选完成 todo1
      const todo1Checkbox = screen.getByRole('button', {
        name: '勾选任务：完成正交函数系基础积分推导',
      });
      fireEvent.click(todo1Checkbox);

      expect(onToggleTodo).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId(`dag-todo-item-${todo1.id}`)).toHaveAttribute(
        'data-dag-status',
        'completed',
      );

      // 下游 todo2 自动从 blocked 解锁为 ready！
      const todo2Item = screen.getByTestId(`dag-todo-item-${todo2.id}`);
      expect(todo2Item).toHaveAttribute('data-dag-status', 'ready');
      expect(within(todo2Item).getByText('就绪可执行')).toBeInTheDocument();
      expect(
        screen.queryByTestId(`dag-blocked-badge-${todo2.id}`),
      ).not.toBeInTheDocument();

      // 继续勾选完成解锁后的 todo2，验证 todo3 也自动解锁为 ready
      const todo2Checkbox = screen.getByRole('button', {
        name: '勾选任务：训练狄利克雷间断点收敛值计算',
      });
      fireEvent.click(todo2Checkbox);

      const todo3Item = screen.getByTestId(`dag-todo-item-${todo3.id}`);
      expect(todo3Item).toHaveAttribute('data-dag-status', 'ready');
      expect(screen.getByTestId('dag-completion-badge')).toHaveTextContent(
        '2/3 (67%)',
      );
    });

    it('3.4 支持将 Ready 任务一键派发至当前会话执行', () => {
      const { store, plan, todo1 } = createSampleDagStore();
      const onDispatchTodo = vi.fn();
      render(
        <ProjectKnowledgeDagDrawer
          store={store}
          onDispatchTodo={onDispatchTodo}
        />,
      );

      const todo1Item = screen.getByTestId(`dag-todo-item-${todo1.id}`);
      fireEvent.click(within(todo1Item).getByRole('button', { name: '派发' }));

      expect(onDispatchTodo).toHaveBeenCalledTimes(1);
      expect(onDispatchTodo.mock.calls[0][0]).toMatchObject({
        todoId: todo1.id,
        target: 'current_session',
        planId: plan.id,
      });
      expect(onDispatchTodo.mock.calls[0][0].prompt).toContain(
        '完成正交函数系基础积分推导',
      );
    });

    it('3.5 关联课堂笔记支持正常编辑保存，且在并发修改引发乐观锁版本冲突时拦截并支持重新读取', () => {
      const { store, note } = createSampleDagStore();
      const onSaveNote = vi.fn();
      render(
        <ProjectKnowledgeDagDrawer store={store} onSaveNote={onSaveNote} />,
      );

      const noteCard = screen.getByTestId(`dag-note-card-${note.id}`);
      fireEvent.click(within(noteCard).getByRole('button', { name: '编辑笔记' }));

      const textarea = screen.getByRole('textbox', { name: `编辑笔记 ${note.id}` });
      fireEvent.change(textarea, {
        target: { value: '学生本地修改：补充吉布斯现象过冲约 9% 的结论。' },
      });

      // 模拟在学生编辑期间，后台 Agent 更新了同一条笔记，导致乐观锁 expected 不匹配
      store.saveNote({
        id: note.id,
        body: '后台 Agent 已更新：补充了狄利克雷核函数的积分表达式。',
      });

      // 点击保存修改，应触发乐观锁冲突提示
      fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
      expect(onSaveNote).not.toHaveBeenCalled();

      const conflictAlert = screen.getByTestId('dag-note-conflict-alert');
      expect(conflictAlert).toHaveTextContent('正文已变更，请重新读取后再保存');

      // 点击「重新读取最新内容」同步最新正文与乐观锁基线后再保存
      fireEvent.click(
        within(conflictAlert).getByRole('button', { name: '重新读取最新内容' }),
      );
      expect(
        (screen.getByRole('textbox', { name: `编辑笔记 ${note.id}` }) as HTMLTextAreaElement)
          .value,
      ).toContain('后台 Agent 已更新');

      fireEvent.change(screen.getByRole('textbox', { name: `编辑笔记 ${note.id}` }), {
        target: {
          value: '后台 Agent 已更新：补充了狄利克雷核函数的积分表达式（附个人批注）。',
        },
      });
      fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

      expect(onSaveNote).toHaveBeenCalledTimes(1);
      expect(
        screen.getByText(/补充了狄利克雷核函数的积分表达式（附个人批注）/),
      ).toBeInTheDocument();
    });
  });

  describe('4. 讲义阅读器与伴读小窗跨组件锚点联动及视觉规范校验', () => {
    it('4.1 在讲义章节点击「伴读提问」可直接将章节锚点绑定到 ContextualMiniChat 胶囊', () => {
      const Wrapper: React.FC = () => {
        const [anchor, setAnchor] = React.useState<MiniChatContextAnchor | null>(
          null,
        );
        return (
          <div>
            <HandoutReaderView
              document={SAMPLE_HANDOUT_DOC}
              onBindMiniChatAnchor={(nextAnchor) => setAnchor(nextAnchor)}
            />
            <ContextualMiniChat anchor={anchor} />
          </div>
        );
      };

      render(<Wrapper />);
      expect(screen.getByText('当前未绑定上下文锚点')).toBeInTheDocument();

      const sec2 = screen.getByTestId('handout-section-sec-dirichlet');
      fireEvent.click(within(sec2).getByRole('button', { name: '伴读提问' }));

      const pill = screen.getByTestId('mini-chat-anchor-pill');
      expect(pill).toHaveTextContent('讲义章节');
      expect(pill).toHaveTextContent('二、狄利克雷收敛定理');
    });

    it('4.2 三大组件遵循无 Emoji、1px border-border/35 分隔线、6px 状态点与 font-mono tabular-nums 数字规范', () => {
      const { store } = createSampleDagStore();
      const { container } = render(
        <div>
          <HandoutReaderView document={SAMPLE_HANDOUT_DOC} />
          <ContextualMiniChat
            anchor={{
              kind: 'question_id',
              label: '例题 2.4',
              referenceId: 'q-2-4',
            }}
          />
          <ProjectKnowledgeDagDrawer store={store} />
        </div>,
      );

      const html = container.innerHTML;
      expect(html).toContain('border-border/35');
      expect(html).toContain('font-mono tabular-nums');
      expect(html).toContain('w-1.5 h-1.5 rounded-full');
      // 严禁包含常见 Emoji 字符
      expect(container.textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    });
  });
});
