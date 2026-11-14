import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as OpenUILangBarrel from '../index';
import * as GenerativeUIBarrel from '../../index';
import {
  OpenUILangRenderer,
  parseOpenUILang,
} from '../index';

describe('openui-lang parser & clean barrel exports', () => {
  it('parses line-based declarations, resolves root and identifier references, and handles objects/arrays', () => {
    const dsl = `
      // Dashboard header and metrics
      root = Stack([header, metrics, detailsBlock])
      header = Callout("Sprint 14 velocity increased by **18%**.", "success", "Sprint Summary")
      metrics = Row([s1, s2])
      s1 = Stat("Velocity", "42 pts", "+18%", "success")
      s2 = Stat("Open Issues", 3, "-2", "info")
      detailsBlock = Details("Steps", [steps1])
      steps1 = Steps([{title: "Design", status: "done"}, {title: "Implement", status: "active"}], "vertical")
    `;

    const program = parseOpenUILang(dsl);
    expect(program.errors).toEqual([]);
    expect(program.root).not.toBeNull();
    expect(program.root?.name).toBe('Stack');
    expect(program.hasInteractiveControls).toBe(false);

    const children = program.root?.args[0] as unknown[];
    expect(Array.isArray(children)).toBe(true);
    expect(children).toHaveLength(3);
  });

  it('tolerates streaming incomplete lines and cyclic references without throwing', () => {
    const cyclicAndPartial = `
      root = Stack([a, b, missingRef])
      a = b
      b = a
      c = Stat("Users", "1,200
    `;
    const program = parseOpenUILang(cyclicAndPartial);
    expect(program.root?.name).toBe('Stack');
    expect(program.statements.has('c')).toBe(true);
  });

  it('exports multiCardDecisionAndHeal symbols from openui-lang/index.ts and generative-ui/index.ts', () => {
    expect(OpenUILangBarrel.MultiCardDecisionCollector).toBeDefined();
    expect(typeof OpenUILangBarrel.scanDecisionCardUnits).toBe('function');
    expect(typeof OpenUILangBarrel.ensureAwaitAnswerSubmitButton).toBe('function');
    expect(typeof OpenUILangBarrel.detectOpenUILangSyntaxErrors).toBe('function');
    expect(typeof OpenUILangBarrel.buildOnNotDrawnAutoHealResult).toBe('function');

    expect(GenerativeUIBarrel.MultiCardDecisionCollector).toBe(
      OpenUILangBarrel.MultiCardDecisionCollector,
    );
    expect(GenerativeUIBarrel.OpenUILangRenderer).toBe(OpenUILangBarrel.OpenUILangRenderer);
  });
});

describe('OpenUILangRenderer', () => {
  it('renders data & layout components, uses standard ARIA tab semantics without aria-pressed, and supports ArrowLeft/ArrowRight keyboard switching', () => {
    const dsl = `
      root = Stack([topCard, tabs])
      topCard = Card("System Overview", [callout, statsRow, prog, kv])
      callout = Callout("All services operating normally.", "info", "Status")
      statsRow = Row([stat1, badge1])
      stat1 = Stat("Requests", "12,480", "+8.4%", "success")
      badge1 = Badge("Healthy", "success")
      prog = Progress("Quota Usage", 75, 100)
      kv = KeyValue([{label: "Region", value: "ap-east-1"}, {label: "Uptime", value: "99.98%"}])
      tabs = Tabs([tabCharts, tabData])
      tabCharts = Tab("Charts", [barChart, lineChart])
      barChart = BarChart(["Q1", "Q2"], [Series("Revenue", [120, 180]), Series("Cost", [80, 110])], "k", true)
      lineChart = LineChart(["Q1", "Q2"], [Series("Latency", [45, 38])], "ms")
      tabData = Tab("Table & Steps", [tbl, steps, det])
      tbl = Table(["Service", "Latency"], [["Auth", "12ms"], ["Search", "28ms"]])
      steps = Steps([{title: "Build", status: "done"}, {title: "Deploy", status: "active"}], "horizontal")
      det = Details("More Info", [Text("Detailed **release** notes.")])
    `;

    const { container } = render(<OpenUILangRenderer source={dsl} />);

    expect(screen.getByText('System Overview')).toBeInTheDocument();
    expect(screen.getByText('All services operating normally.')).toBeInTheDocument();
    expect(screen.getByText('12,480')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('75 / 100 (75%)')).toBeInTheDocument();
    expect(screen.getByText('ap-east-1')).toBeInTheDocument();

    // BarChart and LineChart rendered in initial first tab with 6px (h-1.5 w-1.5) legend dots and border-border/35
    const barChartEl = container.querySelector('[data-openui-component="BarChart"]');
    const lineChartEl = container.querySelector('[data-openui-component="LineChart"]');
    expect(barChartEl).not.toBeNull();
    expect(lineChartEl).not.toBeNull();
    expect(lineChartEl?.className).toContain('border-border/35');
    expect(barChartEl?.querySelector('.h-1\\.5.w-1\\.5')).not.toBeNull();
    expect(lineChartEl?.querySelector('.h-1\\.5.w-1\\.5')).not.toBeNull();

    // Verify role="tab" buttons have aria-selected and NO illegal aria-pressed
    const chartsTab = screen.getByRole('tab', { name: 'Charts' });
    const tableTab = screen.getByRole('tab', { name: 'Table & Steps' });
    expect(chartsTab).toHaveAttribute('aria-selected', 'true');
    expect(chartsTab).not.toHaveAttribute('aria-pressed');
    expect(tableTab).toHaveAttribute('aria-selected', 'false');
    expect(tableTab).not.toHaveAttribute('aria-pressed');

    // Switch tab via ArrowRight keyboard navigation
    fireEvent.keyDown(chartsTab, { key: 'ArrowRight' });
    expect(tableTab).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(tableTab);
    expect(screen.getByText('Auth')).toBeInTheDocument();
    expect(screen.getByText('Deploy')).toBeInTheDocument();

    // Expand Details
    fireEvent.click(screen.getByRole('button', { name: 'More Info' }));
    expect(screen.getByText('release')).toBeInTheDocument();

    // Switch back via ArrowLeft keyboard navigation
    fireEvent.keyDown(tableTab, { key: 'ArrowLeft' });
    expect(chartsTab).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(chartsTab);
  });

  it('fires inline onNotDrawn at most once per broken source even across parent re-renders and StrictMode', () => {
    const notDrawnSpy = vi.fn();

    const ParentWithInlineHandler: React.FC<{ brokenSource: string }> = ({ brokenSource }) => {
      const [renderTick, setRenderTick] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setRenderTick((n) => n + 1)}>
            rerender-{renderTick}
          </button>
          <OpenUILangRenderer
            source={brokenSource}
            onNotDrawn={(result) => {
              notDrawnSpy(result);
              // 模拟父组件在 onNotDrawn 中 setState 引发新内联函数重渲染，绝不能陷入无限循环
              setRenderTick((n) => (n === 0 ? 1 : n));
            }}
          />
        </div>
      );
    };

    const { rerender } = render(
      <React.StrictMode>
        <ParentWithInlineHandler brokenSource="" />
      </React.StrictMode>,
    );

    expect(notDrawnSpy).toHaveBeenCalledTimes(1);

    // 强制父组件重渲染并创建全新的内联 onNotDrawn 箭头函数，同一份 source 不应重复触发
    fireEvent.click(screen.getByRole('button', { name: /rerender-/ }));
    expect(notDrawnSpy).toHaveBeenCalledTimes(1);

    // 更换为另一份损坏的 DSL 源码时，应为新源码再触发 1 次
    rerender(
      <React.StrictMode>
        <ParentWithInlineHandler brokenSource="broken_without_root = 123" />
      </React.StrictMode>,
    );
    expect(notDrawnSpy).toHaveBeenCalledTimes(2);
  });

  it('collects interactive form values (Choice, Input, DateInput, Slider, note) and triggers onSubmit when Button is clicked', () => {
    const onSubmit = vi.fn();
    const dsl = `
      root = Card("Export Settings", [fmt, tags, titleInput, scheduleDate, dpiSlider, actions])
      fmt = Choice("format", [{label: "PDF", value: "pdf", description: "Vector output"}, {label: "Markdown", value: "md"}], "Format", false)
      tags = Choice("sections", ["Summary", "Appendix"], "Sections", true)
      titleInput = Input("docTitle", "Title", "Enter title...", false)
      scheduleDate = DateInput("publishDate", "Publish Date", false, "2026-11-08")
      dpiSlider = Slider("dpi", 72, 300, "DPI", 10, 150, "dpi")
      actions = Row([btnExport, btnDraft])
      btnExport = Button("Export Now", "primary", "export")
      btnDraft = Button("Save Draft", "outline", "draft")
    `;

    render(<OpenUILangRenderer source={dsl} awaitAnswer onSubmit={onSubmit} />);

    // Select single choice "PDF"
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }));
    // Select multi choice "Summary" and "Appendix"
    fireEvent.click(screen.getByRole('button', { name: 'Summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Appendix' }));

    // Fill Input
    fireEvent.change(screen.getByPlaceholderText('Enter title...'), {
      target: { value: 'Deep Student Report' },
    });

    // Fill optional note
    fireEvent.change(screen.getByTestId('openui-note-input'), {
      target: { value: 'Include cover page' },
    });

    // Click primary button
    fireEvent.click(screen.getByRole('button', { name: 'Export Now' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.data).toEqual({
      button: 'Export Now',
      value: 'export',
      values: {
        format: 'pdf',
        sections: ['Summary', 'Appendix'],
        docTitle: 'Deep Student Report',
        publishDate: '2026-11-08',
        dpi: 150,
      },
      note: 'Include cover page',
    });
    expect(payload.summary).toContain('Export Now');
    expect(payload.summary).toContain('format: pdf');
    expect(payload.summary).toContain('Include cover page');
  });

  it('restores answered state and locks controls when answer prop is provided', () => {
    const dsl = `
      root = Stack([choice1, btn1])
      choice1 = Choice("mode", ["Fast", "Thorough"], "Mode", false)
      btn1 = Button("Apply", "primary", "apply")
    `;
    render(
      <OpenUILangRenderer
        source={dsl}
        awaitAnswer
        answer={{
          button: 'Apply',
          value: 'apply',
          values: { mode: 'Thorough' },
          note: 'Use cached index',
        }}
      />,
    );

    const thoroughBtn = screen.getByRole('button', { name: 'Thorough' });
    expect(thoroughBtn).toHaveAttribute('aria-pressed', 'true');
    expect(thoroughBtn).toBeDisabled();
    expect(screen.getByTestId('openui-note-input')).toHaveValue('Use cached index');
  });
});
