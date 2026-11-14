/**
 * openui-lang：命名参数 + 组件别名/灵活签名的回归。
 *
 * LLM 常写 `Stat(label="QPS", value=12)` 这类具名参数，以及 Root / Row / Header /
 * Text / Chart 等别名；两者都必须渲染成功，不能退回空白。
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OpenUILangRenderer, parseOpenUILang } from '../index';
import { isOpenUIComponentNode } from '../parser';

describe('openui-lang named arguments', () => {
  it('parses key = value and key: value into args + namedArgs', () => {
    const program = parseOpenUILang(
      `root = Stack([stat])\nstat = Stat(label = "QPS", value: 1200, delta = "+8%", trend = "success")`,
    );

    expect(program.errors).toEqual([]);
    const stat = program.statements.get('stat');
    expect(isOpenUIComponentNode(stat)).toBe(true);
    if (!isOpenUIComponentNode(stat)) return;

    expect(stat.name).toBe('Stat');
    expect(stat.args).toEqual(['QPS', 1200, '+8%', 'success']);
    expect(stat.namedArgs).toEqual({
      label: 'QPS',
      value: 1200,
      delta: '+8%',
      trend: 'success',
    });
  });

  it('supports mixed positional and named arguments in call order', () => {
    const program = parseOpenUILang(
      `root = Card(title = "配置", [choice, submit])\nchoice = Choice("mode", ["快", "稳"], "模式", false)\nsubmit = Button(label = "应用", value = "apply")`,
    );

    const root = program.root;
    expect(root?.namedArgs).toEqual({ title: '配置' });

    const button = program.statements.get('submit');
    expect(isOpenUIComponentNode(button)).toBe(true);
    if (isOpenUIComponentNode(button)) {
      expect(button.args).toEqual(['应用', 'apply']);
      expect(button.namedArgs).toEqual({ label: '应用', value: 'apply' });
    }
  });

  it('resolves named-argument references through statements', () => {
    const program = parseOpenUILang(
      `root = Stack([a, b])\nitems = ["一", "二"]\na = Table(columns = ["列"], rows = [[items]])\nb = Text(content = "ok")`,
    );
    const table = program.statements.get('a');
    expect(isOpenUIComponentNode(table)).toBe(true);
    if (isOpenUIComponentNode(table)) {
      expect(table.namedArgs?.columns).toEqual(['列']);
    }
    expect(program.errors).toEqual([]);
  });
});

describe('openui-lang component aliases', () => {
  it('renders Root / Header / Text aliases', () => {
    const dsl = `
      root = Root([header, paragraph, card])
      header = Header("学习概览")
      paragraph = Text("本周完成 **12** 次练习。")
      card = Card(title = "今日计划", [Text("先复习闪卡")])
    `;

    const { container } = render(<OpenUILangRenderer source={dsl} />);

    expect(screen.getByText('学习概览')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('今日计划')).toBeInTheDocument();
    expect(screen.getByText('先复习闪卡')).toBeInTheDocument();
    expect(container.querySelector('[data-openui-component="Root"]')).toHaveAttribute(
      'data-direction',
      'column',
    );
  });

  it('treats a single array argument to Card as children', () => {
    const dsl = `
      root = Card([Header("无标题卡片"), Text("正文")])
    `;
    render(<OpenUILangRenderer source={dsl} />);
    expect(screen.getByText('无标题卡片')).toBeInTheDocument();
    expect(screen.getByText('正文')).toBeInTheDocument();
  });

  it('renders Stat / Progress named signatures', () => {
    const dsl = `
      root = Stack([s1, p1, p2])
      s1 = Stat(label = "请求数", value = "12,480", change = "+8.4%", trend = "success")
      p1 = Progress(label = "配额", value = 92, max = 100)
      p2 = Progress("完成度", 3, 4)
    `;
    render(<OpenUILangRenderer source={dsl} />);

    expect(screen.getByText('请求数')).toBeInTheDocument();
    expect(screen.getByText('12,480')).toBeInTheDocument();
    expect(screen.getByText('+8.4%')).toBeInTheDocument();
    expect(screen.getByText('92 / 100 (92%)')).toBeInTheDocument();
    expect(screen.getByText('3 / 4 (75%)')).toBeInTheDocument();
  });

  it('renders Progress with a string caption instead of a max', () => {
    const dsl = `
      root = Progress("配额", 92, "剩余 8 个")
    `;
    render(<OpenUILangRenderer source={dsl} />);
    expect(screen.getByText('剩余 8 个')).toBeInTheDocument();
  });

  it('renders Table with string columns and array rows', () => {
    const dsl = `
      root = Table(["方案", "通信复杂度", "适用场景"], [
        ["Parameter Server", "O(K)", "中心化训练"],
        ["Ring AllReduce", "O(1)", "大规模集群", true]
      ])
    `;
    render(<OpenUILangRenderer source={dsl} />);

    expect(screen.getByText('方案')).toBeInTheDocument();
    expect(screen.getByText('通信复杂度')).toBeInTheDocument();
    expect(screen.getByText('Parameter Server')).toBeInTheDocument();
    expect(screen.getByText('O(K)')).toBeInTheDocument();
    expect(screen.getByText('大规模集群')).toBeInTheDocument();
  });

  it('renders Table from named columns / rows', () => {
    const dsl = `
      root = Table(columns = [{ key: "name", label: "名称" }], rows = [{ name: "甲" }])
    `;
    render(<OpenUILangRenderer source={dsl} />);
    expect(screen.getByText('名称')).toBeInTheDocument();
    expect(screen.getByText('甲')).toBeInTheDocument();
  });

  it('renders Steps items with title / markdown aliases', () => {
    const dsl = `
      root = Steps([{ title: "设计", markdown: "先画线框", status: "completed" }, { name: "实现", status: "current" }], "vertical")
    `;
    const { container } = render(<OpenUILangRenderer source={dsl} />);
    expect(screen.getByText('设计')).toBeInTheDocument();
    expect(screen.getByText('先画线框')).toBeInTheDocument();
    expect(screen.getByText('实现')).toBeInTheDocument();
    expect(container.querySelector('[data-step-status="done"]')).not.toBeNull();
    expect(container.querySelector('[data-step-status="active"]')).not.toBeNull();
  });

  it('aliases BarChart / LineChart / Chart with a variant', () => {
    const dsl = `
      root = Stack([bar, line, chartLine])
      bar = BarChart(["Q1", "Q2"], [Series("收入", [120, 180])], "万")
      line = LineChart(["Q1", "Q2"], [Series("延迟", [45, 38])], "ms")
      chartLine = Chart(variant = "line", categories = ["A", "B"], series = [Series("值", [1, 2])])
    `;
    const { container } = render(<OpenUILangRenderer source={dsl} />);

    expect(container.querySelector('[data-openui-component="BarChart"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-openui-component="LineChart"]')).toHaveLength(2);
    // LineChart 用 svg 折线渲染；BarChart 用进度条
    expect(container.querySelectorAll('svg[role="img"]')).toHaveLength(2);
    expect(screen.getAllByText('Q1').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('renders Details and Accordion without losing content', () => {
    const dsl = `
      root = Stack([det, acc])
      det = Details(title = "更多信息", content = [Text("发布说明")])
      acc = Accordion([{ title: "第一节", content: [Text("内容一")] }, { title: "第二节", content: [Text("内容二")] }])
    `;
    render(<OpenUILangRenderer source={dsl} />);

    fireEvent.click(screen.getByRole('button', { name: '更多信息' }));
    expect(screen.getByText('发布说明')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '第一节' }));
    expect(screen.getByText('内容一')).toBeInTheDocument();
    expect(screen.queryByText('内容二')).not.toBeInTheDocument();
  });

  it('keeps named-argument form controls submittable', () => {
    const dsl = `
      root = Card(title = "导出设置", [choice, input, actions])
      choice = Choice(name = "format", options = [{ label: "PDF", value: "pdf" }], label = "格式", multiple = false)
      input = Input(name = "title", label = "标题", placeholder = "输入标题")
      actions = Row([submit])
      submit = Button(label = "导出", value = "export")
    `;
    render(<OpenUILangRenderer source={dsl} awaitAnswer />);

    fireEvent.click(screen.getByRole('button', { name: /PDF/ }));
    fireEvent.change(screen.getByPlaceholderText('输入标题'), { target: { value: '报告' } });
    expect(screen.getByRole('button', { name: '导出' })).toBeInTheDocument();
  });
});
