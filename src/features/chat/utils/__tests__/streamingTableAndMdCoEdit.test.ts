import { describe, expect, it, vi } from 'vitest';

import {
  computeTableCollapseState,
  detectNumericColumns,
  escapeMarkdownCell,
  estimateFrozenColumnWidthsPx,
  filterStreamingTableRows,
  MAX_COLUMN_WIDTH_PX,
  MIN_COLUMN_WIDTH_PX,
  StreamingColumnWidthFreezer,
  tableToCsv,
  tableToMarkdown,
  visualLength,
} from '../streamingMarkdownTable';
import {
  AgentCoEditHistoryManager,
  applyAgentMarkdownEdits,
  computeLivePreviewSyntaxVisibility,
} from '@/features/learning-hub/utils/mdLivePreviewAndAgentCoEdit';

describe('streamingMarkdownTable', () => {
  describe('filterStreamingTableRows & detectNumericColumns', () => {
    const headers = ['模块', '耗时', '完成率'];

    it('仅保留单元格数与表头列数对齐的完整行，剔除少一格的半截行与流式全空占坑行', () => {
      const rows = [
        { cells: ['解析器', '12ms', '98%'] },
        { cells: ['   ', '  ', '\t'] }, // 流式全空白占坑行
        { cells: ['索引器', '45ms'] }, // 少一格的半截行
        { cells: ['渲染器', '8ms', '100%', '多余列'] }, // 列数超出
      ];

      const streamingFiltered = filterStreamingTableRows(headers, rows, true);
      expect(streamingFiltered).toEqual([{ cells: ['解析器', '12ms', '98%'] }]);

      // 流式结束后保留对齐的空白行，但依然剔除列数不齐的坏行
      const staticFiltered = filterStreamingTableRows(headers, rows, false);
      expect(staticFiltered).toEqual([
        { cells: ['解析器', '12ms', '98%'] },
        { cells: ['   ', '  ', '\t'] },
      ]);
    });

    it('残缺半行绝不参与数值列右对齐判定，避免整列对齐在流式期间左右跳变', () => {
      const rowsWithPartial = [
        { cells: ['阶段A', '120ms', '95.5%'] },
        { cells: ['阶段B', '—', '100%'] },
        { cells: ['阶段C', '正在输入非数值半截行'] }, // 少一格的残缺行，第2列含非数值文字
      ];

      const numericCols = detectNumericColumns(headers, rowsWithPartial);
      expect([...numericCols]).toEqual([1, 2]);

      // 若作者显式指定了某列对齐方式，则尊重作者设定不自动覆盖
      const numericWithExplicit = detectNumericColumns(
        headers,
        rowsWithPartial,
        [null, 'left', null],
      );
      expect([...numericWithExplicit]).toEqual([2]);
    });
  });

  describe('estimateFrozenColumnWidthsPx & StreamingColumnWidthFreezer', () => {
    it('按 CJK 2 单位、ASCII 1 单位估算首帧前 3 行列宽，遵守 64px 下限与 320px 上限', () => {
      expect(visualLength('时长')).toBe(4);
      expect(visualLength('ABC')).toBe(3);
      expect(visualLength('时长ABC')).toBe(7);

      const headers = ['时长', '进度', '说明'];
      const rows = [
        ['1s', '10%', '短说明'],
        ['2s', '20%', '这是一段非常非常长的中文说明文本用来触发三百二十像素的最大列宽上限封顶逻辑测试验证完毕'],
      ];

      const widths = estimateFrozenColumnWidthsPx(headers, rows);
      // 「时长」「进度」均为 2 个汉字（4 单位）=> 4 * 7.5 + 24 = 54px -> 夹紧到下限 64px
      expect(widths[0]).toBe(MIN_COLUMN_WIDTH_PX);
      expect(widths[1]).toBe(MIN_COLUMN_WIDTH_PX);
      // 超长列封顶 320px
      expect(widths[2]).toBe(MAX_COLUMN_WIDTH_PX);
    });

    it('流式首帧算出列宽后立即冻结，后续新行到来绝不重算，流式结束释放回自动布局', () => {
      const freezer = new StreamingColumnWidthFreezer();
      const headers = ['名称', '详情'];

      const firstFrameRows = [['项目A', '简短描述']];
      const initialWidths = freezer.resolveColumnWidths(
        headers,
        firstFrameRows,
        true,
      );
      expect(initialWidths).not.toBeNull();
      expect(freezer.isFrozen()).toBe(true);

      // 新行到来且包含更长文本，流式期间列宽保持不变
      const laterFrameRows = [
        ['项目A', '简短描述'],
        ['项目B', '后续流式追加的一段超长文本内容不应该导致已冻结的列宽发生重新分配与抖动'],
      ];
      const secondWidths = freezer.resolveColumnWidths(
        headers,
        laterFrameRows,
        true,
      );
      expect(secondWidths).toEqual(initialWidths);

      // 流式结束，释放列宽回自动布局
      const releasedWidths = freezer.resolveColumnWidths(
        headers,
        laterFrameRows,
        false,
      );
      expect(releasedWidths).toBeNull();
      expect(freezer.isFrozen()).toBe(false);
    });
  });

  describe('computeTableCollapseState', () => {
    it('单列表格（colCount === 1）在流式与结束后均全部露出且永不折叠', () => {
      const streamingSingleCol = computeTableCollapseState(1, 15, true, false);
      expect(streamingSingleCol.needsVerticalCollapse).toBe(false);
      expect(streamingSingleCol.visibleRowCount).toBe(15);
      expect(streamingSingleCol.showStreamingProgressHint).toBe(false);
      expect(streamingSingleCol.showExpandButton).toBe(false);

      const doneSingleCol = computeTableCollapseState(1, 15, false, false);
      expect(doneSingleCol.needsVerticalCollapse).toBe(false);
      expect(doneSingleCol.visibleRowCount).toBe(15);
      expect(doneSingleCol.showExpandButton).toBe(false);
    });

    it('多列表格超出 6 行时：流式期固定露前 6 行并显示生成提示态，结束后切换为「展开全部 · N 行」', () => {
      const streamingMultiCol = computeTableCollapseState(3, 12, true, false);
      expect(streamingMultiCol.needsVerticalCollapse).toBe(true);
      expect(streamingMultiCol.visibleRowCount).toBe(6);
      expect(streamingMultiCol.hiddenRowCount).toBe(6);
      expect(streamingMultiCol.showStreamingProgressHint).toBe(true);
      expect(streamingMultiCol.streamingProgressText).toBe('正在生成更多行…');
      expect(streamingMultiCol.showExpandButton).toBe(false);

      const finishedCollapsed = computeTableCollapseState(
        3,
        12,
        false,
        false,
        false,
      );
      expect(finishedCollapsed.needsVerticalCollapse).toBe(true);
      expect(finishedCollapsed.visibleRowCount).toBe(6);
      expect(finishedCollapsed.showStreamingProgressHint).toBe(false);
      expect(finishedCollapsed.showExpandButton).toBe(true);
      expect(finishedCollapsed.expandButtonText).toBe('展开全部 · 12 行');
      expect(finishedCollapsed.showBottomFadeMask).toBe(true);

      const finishedExpanded = computeTableCollapseState(
        3,
        12,
        false,
        false,
        true,
      );
      expect(finishedExpanded.visibleRowCount).toBe(12);
      expect(finishedExpanded.expandButtonText).toBe('收起');
      expect(finishedExpanded.showBottomFadeMask).toBe(false);
    });
  });

  describe('tableToMarkdown & tableToCsv', () => {
    it('tableToMarkdown 严格按「反斜杠 -> 管道符 -> 换行转 <br>」顺序转义，避免二次转义', () => {
      expect(escapeMarkdownCell('a\\b|c\nd')).toBe('a\\\\b\\|c<br>d');

      const md = tableToMarkdown(
        ['表达式', '结果'],
        [['a\\b | c', '第一行\n第二行']],
        ['left', 'right'],
      );
      expect(md).toBe(
        [
          '| 表达式 | 结果 |',
          '| :--- | ---: |',
          '| a\\\\b \\| c | 第一行<br>第二行 |',
        ].join('\n'),
      );
    });

    it('tableToCsv 遵循 RFC 4180：逗号/双引号/换行外包双引号且内部双引号翻倍，行尾统一使用 CRLF', () => {
      const csv = tableToCsv(
        ['姓名', '备注'],
        [
          ['张三', '普通文本'],
          ['李四,王五', '含"引号"与\n换行'],
        ],
      );
      expect(csv).toBe(
        '姓名,备注\r\n张三,普通文本\r\n"李四,王五","含""引号""与\n换行"',
      );
    });
  });
});

describe('mdLivePreviewAndAgentCoEdit', () => {
  describe('computeLivePreviewSyntaxVisibility', () => {
    it('光标与语法节点相交时露出原始 Markdown 语法符号，移开后立即隐藏', () => {
      const markdown = '# 章节标题\n\n这是**重点概念**与`inlineCode`以及[参考链接](https://example.com)。\n';
      const boldFrom = markdown.indexOf('**重点概念**');
      const boldTo = boldFrom + '**重点概念**'.length;
      const codeFrom = markdown.indexOf('`inlineCode`');
      const codeTo = codeFrom + '`inlineCode`'.length;
      const linkFrom = markdown.indexOf('[参考链接](https://example.com)');
      const linkTo = linkFrom + '[参考链接](https://example.com)'.length;

      const syntaxNodes = [
        { type: 'heading', from: 0, to: 6 },
        { type: 'StrongEmphasis', from: boldFrom, to: boldTo },
        { type: 'InlineCode', from: codeFrom, to: codeTo },
        { type: 'link', from: linkFrom, to: linkTo },
      ];

      // 1. 无光标相交：全部语法符号均隐藏，文档纯文本保持 100% 不变
      const idleResult = computeLivePreviewSyntaxVisibility(
        markdown,
        syntaxNodes,
        [],
      );
      expect(idleResult.markdown).toBe(markdown);
      expect(idleResult.every((item) => item.hidden && !item.syntaxVisible)).toBe(
        true,
      );
      // 标题隐藏 `# `（含紧随其后的空格）
      expect(idleResult[0].activeHiddenRanges).toEqual([{ from: 0, to: 2 }]);
      // 粗体隐藏前后 `**`
      expect(idleResult[1].activeHiddenRanges).toEqual([
        { from: boldFrom, to: boldFrom + 2 },
        { from: boldTo - 2, to: boldTo },
      ]);

      // 2. 光标落入 `**重点概念**` 内部：仅粗体露出语法符号，其余保持隐藏
      const cursorInBold = computeLivePreviewSyntaxVisibility(
        markdown,
        syntaxNodes,
        [{ from: boldFrom + 3, to: boldFrom + 3 }],
      );
      expect(cursorInBold[1].cursorIntersects).toBe(true);
      expect(cursorInBold[1].syntaxVisible).toBe(true);
      expect(cursorInBold[1].hidden).toBe(false);
      expect(cursorInBold[1].activeHiddenRanges).toEqual([]);

      expect(cursorInBold[0].hidden).toBe(true);
      expect(cursorInBold[2].hidden).toBe(true);
      expect(cursorInBold[3].hidden).toBe(true);
    });

    it('围栏代码块首尾两行标记为 blockLineCollapse: true（折成零高度行），代码正文保持原样直接可编辑', () => {
      const markdown = '```ts\nconst answer = 42;\n```\n';
      const fenceNode = {
        type: 'FencedCode',
        from: 0,
        to: markdown.length - 1,
      };

      // 光标在代码块外：首尾两行折叠为零高度行，代码正文加代码块样式且直接可编辑
      const collapsedResult = computeLivePreviewSyntaxVisibility(
        markdown,
        [fenceNode],
        [],
      );
      const fenceItem = collapsedResult[0];
      expect(fenceItem.blockLineCollapse).toBe(true);
      expect(fenceItem.hidden).toBe(true);
      expect(fenceItem.codeBodyEditable).toBe(true);
      expect(
        markdown.slice(
          fenceItem.codeBodyRange?.from,
          fenceItem.codeBodyRange?.to,
        ),
      ).toBe('const answer = 42;\n');
      expect(collapsedResult.collapsedFenceLines).toEqual([
        { from: 0, to: 5 },
        { from: 25, to: 28 },
      ]);

      const collapseDecorations = collapsedResult.decorations.filter(
        (d) => d.kind === 'collapse',
      );
      expect(collapseDecorations).toEqual([
        { kind: 'collapse', from: 0, to: 5, blockLineCollapse: true },
        { kind: 'collapse', from: 25, to: 28, blockLineCollapse: true },
      ]);

      // 光标进入代码块内部：首尾围栏行立即显露供用户编辑
      const activeResult = computeLivePreviewSyntaxVisibility(
        markdown,
        [fenceNode],
        [{ from: 10, to: 10 }],
      );
      expect(activeResult[0].syntaxVisible).toBe(true);
      expect(activeResult[0].hidden).toBe(false);
      expect(activeResult.collapsedFenceLines).toEqual([]);
    });
  });

  describe('applyAgentMarkdownEdits & AgentCoEditHistoryManager', () => {
    const sampleDoc = [
      '# 机器学习导论',
      '',
      '梯度下降每次迭代更新参数。',
      '损失函数用于衡量预测误差。',
      '梯度下降每次迭代更新参数。',
    ].join('\n');

    it('当 old_string 未找到或存在多处匹配时返回带行号与匹配处数的诊断结果，绝不盲改文档', () => {
      // 1. 多处匹配诊断
      const multiMatch = applyAgentMarkdownEdits(sampleDoc, {
        edits: [
          {
            old_string: '梯度下降每次迭代更新参数。',
            new_string: '随机梯度下降按小批量更新参数。',
          },
        ],
      });
      expect(multiMatch.ok).toBe(false);
      expect(multiMatch.markdown).toBe(sampleDoc);
      expect(multiMatch.matchCount).toBe(2);
      expect(multiMatch.matchedLines).toEqual([3, 5]);
      if (!multiMatch.ok) {
        expect(multiMatch.error).toContain('2 处');
        expect(multiMatch.error).toContain('3、5');
      }

      // 2. 未找到时给出相似文本行号诊断
      const notFound = applyAgentMarkdownEdits(sampleDoc, {
        edits: [
          {
            old_string: '损失函数用于衡量模型的预测偏差。',
            new_string: '交叉熵损失函数用于分类任务。',
          },
        ],
      });
      expect(notFound.ok).toBe(false);
      expect(notFound.markdown).toBe(sampleDoc);
      expect(notFound.matchedLines).toContain(4);
    });

    it('单次 Agent 调用内的多处非重叠 edits 合并为单一撤销事务（isolateHistory: true），产出正确平移的绿色 Diff 高亮区间并支持一键退回与重分块回调', () => {
      const rechunkSpy = vi.fn();
      const doc = '第一章：基础概念\n第二章：核心算法\n第三章：工程实践\n';
      const manager = new AgentCoEditHistoryManager(doc, {
        onRechunkMaterialBlocks: rechunkSpy,
      });

      const applyRes = manager.applyAgentEdits({
        edits: [
          {
            old_string: '第一章：基础概念',
            new_string: '第一章：数学与基础概念导览',
          },
          {
            old_string: '第三章：工程实践',
            new_string: '第三章：分布式工程实践与应用',
          },
        ],
      });

      expect(applyRes.ok).toBe(true);
      if (!applyRes.ok) return;

      expect(applyRes.isolateHistory).toBe(true);
      expect(applyRes.changedCount).toBe(2);
      expect(manager.getMarkdown()).toBe(
        '第一章：数学与基础概念导览\n第二章：核心算法\n第三章：分布式工程实践与应用\n',
      );

      // 验证新文档坐标系下的绿色 Diff 高亮区间精确对应修改后的文本
      const highlights = manager.getHighlightRanges();
      expect(highlights).toHaveLength(2);
      expect(
        manager
          .getMarkdown()
          .slice(highlights[0].from, highlights[0].to),
      ).toBe('第一章：数学与基础概念导览');
      expect(
        manager
          .getMarkdown()
          .slice(highlights[1].from, highlights[1].to),
      ).toBe('第三章：分布式工程实践与应用');

      // 编辑保存后自动触发重新分块回调
      expect(rechunkSpy).toHaveBeenCalledTimes(1);
      expect(rechunkSpy).toHaveBeenLastCalledWith(manager.getMarkdown());

      // 用户按一次撤销即可将本次 Agent 全部改动一步退回（含按 from 降序还原）
      const undoRes = manager.undoLastAgentEdit();
      expect(undoRes.ok).toBe(true);
      expect(manager.getMarkdown()).toBe(doc);
      expect(manager.getHighlightRanges()).toEqual([]);
      expect(rechunkSpy).toHaveBeenCalledTimes(2);
      expect(rechunkSpy).toHaveBeenLastCalledWith(doc);
    });

    it('支持纯删除操作的逆向一步还原，且当用户后续编辑破坏了 Agent 改动区间时拒绝盲目覆盖', () => {
      const doc = 'AAABBBCCC';
      const manager = new AgentCoEditHistoryManager(doc);

      // 删除 BBB 并将 CCC 扩展为 CCCCC
      const res = manager.applyAgentEdits([
        { old_string: 'BBB', new_string: '' },
        { old_string: 'CCC', new_string: 'CCCCC' },
      ]);
      expect(res.ok).toBe(true);
      expect(manager.getMarkdown()).toBe('AAACCCCC');

      // 按 from 降序一步还原回 AAABBBCCC（若按升序则会丢掉刚还原的 BBB）
      const undoRes = manager.undoLastAgentEdit();
      expect(undoRes.ok).toBe(true);
      expect(manager.getMarkdown()).toBe('AAABBBCCC');

      // 再次执行 Agent 编辑后，用户在前方插入文字导致坐标漂移，此时撤销应安全中止而不误删用户文字
      manager.applyAgentEdits([{ old_string: 'BBB', new_string: 'XXX' }]);
      manager.applyUserEdit('USER_PREFIX_AAAXXXCCC');
      const conflictUndo = manager.undoLastAgentEdit();
      expect(conflictUndo.ok).toBe(false);
      expect(manager.getMarkdown()).toBe('USER_PREFIX_AAAXXXCCC');
    });
  });
});
