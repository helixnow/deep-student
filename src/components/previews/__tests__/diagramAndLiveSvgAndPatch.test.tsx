import { describe, expect, it, beforeEach } from 'vitest';
import {
  compileDiagramExpr,
  DiagramSchemaError,
  LIMITS,
  peekDiagramProgress,
  peekStreamingDiagram,
  renderDiagram,
  renderDiagramSvg,
  validateDiagram,
} from '../diagramEngine';
import {
  classifySvgElementAnimation,
  clearSvgSanitizeCache,
  getSvgSanitizeCacheStats,
  markShapes,
  peekSvgProgress,
  sanitizeSvg,
  sanitizeSvgFragment,
} from '../liveSvgStream';
import {
  applyArtifactReply,
  artifactFences,
  ArtifactUndoStack,
  MAX_ARTIFACT_UNDO_STEPS,
  parseArtifactReply,
  replaceArtifactFence,
} from '../artifactEditEngine';

describe('wave6 diagram, SVG and fence regressions', () => {
  it.each(['{"type":"graph","nodes":[}', '{"nodes":["a" }', '{"type":"graph","nodes":[{"id":"a"]}'])('terminates malformed streaming JSON: %s', (source) => {
    expect(() => peekDiagramProgress(source)).not.toThrow();
    expect(() => peekStreamingDiagram(source)).not.toThrow();
  });

  it('bounds expressions and rejects incomplete exponents while retaining valid scientific notation', () => {
    expect(() => compileDiagramExpr('x'.repeat(513))).toThrow(/512/);
    expect(() => compileDiagramExpr('('.repeat(65) + 'x' + ')'.repeat(65))).toThrow(/64/);
    expect(compileDiagramExpr('('.repeat(64) + 'x' + ')'.repeat(64))(2)).toBe(2);
    for (const source of ['1e', '1E', '1e+', '1E-']) expect(() => compileDiagramExpr(source)).toThrow(/指数/);
    expect(compileDiagramExpr('1e2')(0)).toBe(100);
    expect(() => renderDiagramSvg({ type: 'plot', x: [0, Number.MIN_VALUE], y: [0, Number.MIN_VALUE], curves: [] })).not.toThrow();
  });

  it.each([String.raw`background:u\72l(https://evil.test/a)`, 'background:image-set("https://evil.test/a" 1x)', 'background:image("https://evil.test/a")', String.raw`@\69mport "https://evil.test/a"`])('removes resource-bearing inline CSS: %s', (style) => {
    const clean = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><rect style='${style}' width="10" height="10"/></svg>`);
    expect(clean).not.toContain('style=');
    expect(clean).not.toContain('evil.test');
    expect(sanitizeSvgFragment(`<rect style='${style}'/>`)).not.toContain('style=');
  });

  it('retains ordinary javascript: text labels', () => {
    expect(sanitizeSvg('<svg><text>javascript: is a protocol</text></svg>')).toContain('javascript: is a protocol');
  });

  it('permits paired embedded fence examples but rejects unmatched fence escape', () => {
    const markdown = '```html\n<p>old</p>\n```';
    const paired = '<p>new</p>\n```text\nexample\n```';
    expect(replaceArtifactFence(markdown, 'html', '<p>old</p>', paired)).toContain(paired);
    expect(() => replaceArtifactFence(markdown, 'html', '<p>old</p>', '<p>new</p>\n```\nescaped')).toThrow(/围栏/);
    expect(() => replaceArtifactFence('~~~html\nold\n~~~', 'html', 'old', 'new\n~~~')).toThrow(/围栏/);
  });
});

describe('diagramEngine: compileDiagramExpr, validateDiagram, peekStreamingDiagram, renderDiagramSvg', () => {
  it('supports implicit multiplication, right-associative power 2^3^2 = 512, whitelist functions and constants', () => {
    expect(compileDiagramExpr('2x')(4)).toBe(8);
    expect(compileDiagramExpr('2sin(x)')(Math.PI / 2)).toBeCloseTo(2, 9);
    expect(compileDiagramExpr('x(x+1)')(3)).toBe(12);
    expect(compileDiagramExpr('(x+1)(x-1)')(5)).toBe(24);
    expect(compileDiagramExpr('2^3^2')(0)).toBe(512);
    expect(compileDiagramExpr('-x^2')(3)).toBe(-9);
    expect(compileDiagramExpr('2^-3')(0)).toBeCloseTo(0.125, 9);
    expect(compileDiagramExpr('log(2, 8)')(0)).toBeCloseTo(3, 9);
    expect(compileDiagramExpr('ln(e^2)')(0)).toBeCloseTo(2, 9);
    expect(compileDiagramExpr('cosh(0) + sinh(0) + tanh(0)')(0)).toBeCloseTo(1, 9);
    expect(compileDiagramExpr('sin(pi / 2) + cos(tau)')(0)).toBeCloseTo(2, 9);
    expect(compileDiagramExpr('min(x, 4) + max(x, 10)')(6)).toBe(14);
  });

  it('reports exact character position on syntax errors and blocks call chains or code injection', () => {
    expect(() => compileDiagramExpr('sinn(x)')).toThrow(/表达式第 1 字符附近出错.*不认识的函数「sinn」/);
    expect(() => compileDiagramExpr('2 + (3 * x')).toThrow(/表达式第 11 字符附近出错.*括号没有闭合/);
    expect(() => compileDiagramExpr('x + * 2')).toThrow(/表达式第 5 字符附近出错/);
    expect(() => compileDiagramExpr('sin(x)(2)')).toThrow(/表达式第 7 字符附近出错.*不支持函数调用链/);
    expect(() => compileDiagramExpr('window.alert(1)')).toThrow(/表达式第 7 字符附近出错.*不支持属性访问「\.」/);
    expect(() => compileDiagramExpr("fetch('https://evil.example')")).toThrow(/不认识的字符/);
    expect(() => compileDiagramExpr('constructor(1)')).toThrow(/不认识的函数「constructor」/);
  });

  it('validates graph and plot schemas strictly and lists allowed fields on unknown keys', () => {
    const validGraph = validateDiagram({
      type: 'graph',
      direction: 'LR',
      nodes: [
        { id: 'a', label: '输入层' },
        { id: 'b', label: '隐藏层', shape: 'round' },
      ],
      edges: [{ from: 'a', to: 'b', label: '前向传播' }],
    });
    expect(validGraph.type).toBe('graph');

    expect(() =>
      validateDiagram({
        type: 'graph',
        nodes: [{ id: 'a', label: '节点', unknownKey: 123 }],
      }),
    ).toThrow(/nodes\[0\]有不认识的字段「unknownKey」。可用字段：id \/ label \/ shape/);

    expect(() =>
      validateDiagram({
        type: 'plot',
        x: [-5, 5],
        extraField: true,
      }),
    ).toThrow(/diagram有不认识的字段「extraField」。可用字段：type \/ x \/ y \/ axes \/ curves \/ points \/ segments \/ polygons \/ circles \/ labels/);

    expect(() =>
      validateDiagram({
        type: 'flowchart',
        nodes: [{ id: 'a', label: '节点' }],
      }),
    ).toThrow(/type 必须是 "graph"（结构图）、"plot"（函数\/几何）或 "chart"/);

    expect(() =>
      validateDiagram({
        type: 'graph',
        nodes: [{ id: 'a', label: '节点' }],
        edges: [{ from: 'a', to: 'a' }],
      }),
    ).toThrow(/自环/);

    expect(() =>
      validateDiagram({
        type: 'graph',
        nodes: [{ id: 'a', label: '节点' }],
        edges: [{ from: 'a', to: 'missing' }],
      }),
    ).toThrow(/引用了不存在的节点「missing」/);
  });

  it('extracts completed items progressively from unclosed JSON via peekStreamingDiagram', () => {
    expect(peekStreamingDiagram('')).toBeNull();
    expect(peekStreamingDiagram('{"type":"gr')).toBeNull();

    const partialGraph = peekStreamingDiagram(
      '{"type":"graph","direction":"LR","nodes":[{"id":"n1","label":"客户端"},{"id":"n2","label":"网关"},{"id":"n3","label":"未闭合',
    );
    expect(partialGraph).toEqual({
      type: 'graph',
      direction: 'LR',
      nodes: [
        { id: 'n1', label: '客户端' },
        { id: 'n2', label: '网关' },
      ],
      edges: [],
    });

    const partialPlotSrc = [
      '{"type":"plot","x":[-4,4],"y":[-3,3],',
      '"curves":[{"fn":"sin(x)","label":"正弦"}],',
      '"points":[{"at":[0,0],"label":"O"}],',
      '"segments":[{"from":[-1,-1],"to":[1,1],"dashed":true}],',
      '"polygons":[{"points":[[0,0],[2,0],[1,2]],"label":"三角形"}],',
      '"circles":[{"center":[0,0],"r":1,"label":"单位圆"}],',
      '"labels":[{"at":[1,1],"text":"标注"},{"at":[2,2],"text":"未写完',
    ].join('');

    const partialPlot = peekStreamingDiagram(partialPlotSrc);
    expect(partialPlot).not.toBeNull();
    if (partialPlot && partialPlot.type === 'plot') {
      expect(partialPlot.x).toEqual([-4, 4]);
      expect(partialPlot.y).toEqual([-3, 3]);
      expect(partialPlot.curves).toHaveLength(1);
      expect(partialPlot.points).toHaveLength(1);
      expect(partialPlot.segments).toHaveLength(1);
      expect(partialPlot.polygons).toHaveLength(1);
      expect(partialPlot.circles).toHaveLength(1);
      expect(partialPlot.labels).toEqual([{ at: [1, 1], text: '标注' }]);
    }
  });

  it('renders deterministic SVG for topological graphs and splits asymptotes for tan(x) and 1/x', () => {
    const graphDoc = validateDiagram({
      type: 'graph',
      direction: 'TB',
      nodes: [
        { id: 'a', label: '第一层' },
        { id: 'b', label: '第二层' },
        { id: 'c', label: '第三层' },
      ],
      edges: [
        { from: 'a', to: 'b', label: '步骤一' },
        { from: 'b', to: 'c', label: '步骤二' },
      ],
    });

    const svgLight1 = renderDiagramSvg(graphDoc, { theme: 'light' });
    const svgLight2 = renderDiagramSvg(graphDoc, { theme: 'light' });
    const svgDark = renderDiagramSvg(graphDoc, { theme: 'dark' });
    expect(svgLight1).toBe(svgLight2);
    expect(svgLight1).not.toBe(svgDark);
    expect(svgDark).toContain('#112545');

    const renderedGraph = renderDiagram(graphDoc);
    const getNodeY = (key: string) => {
      const shape = renderedGraph.shapes.find((s) => s.key === key)!;
      const m = / y="([\d.]+)"/.exec(shape.svg);
      return Number(m![1]);
    };
    expect(getNodeY('node:a')).toBeLessThan(getNodeY('node:b'));
    expect(getNodeY('node:b')).toBeLessThan(getNodeY('node:c'));

    // 校验 1/x 与 tan(x) 渐近线处断开为多条子路径（多个 M 指令），不连跨渐近线的竖线
    const plotDoc = validateDiagram({
      type: 'plot',
      x: [-4, 4],
      y: [-6, 6],
      curves: [
        { fn: '1/x', label: '反比例' },
        { fn: 'tan(x)', label: '正切' },
      ],
    });
    const renderedPlot = renderDiagram(plotDoc);
    const invCurve = renderedPlot.shapes.find((s) => s.key === 'curve:0')!;
    const tanCurve = renderedPlot.shapes.find((s) => s.key === 'curve:1')!;
    const invMoves = (/d="([^"]+)"/.exec(invCurve.svg)?.[1].match(/M/g) ?? []).length;
    const tanMoves = (/d="([^"]+)"/.exec(tanCurve.svg)?.[1].match(/M/g) ?? []).length;
    expect(invMoves).toBeGreaterThanOrEqual(2);
    expect(tanMoves).toBeGreaterThanOrEqual(3);
    expect(renderedPlot.svg).not.toMatch(/NaN|Infinity/);

    // 校验流式最后一拍与终态完整渲染一致
    const rawPlot = JSON.stringify(plotDoc);
    const progress = peekDiagramProgress(rawPlot);
    expect(progress?.shapes).toEqual(renderedPlot.shapes);
  });
});

describe('liveSvgStream: peekSvgProgress, camelCase attributes, XSS blocking, LRU cache, animation classification', () => {
  beforeEach(() => {
    clearSvgSanitizeCache();
  });

  it('extracts only closed top-level elements across token-by-token streaming and guards against orphan closing tags', () => {
    const fullSvg = [
      '<svg viewBox="0 0 240 140" xmlns="http://www.w3.org/2000/svg">',
      '<!-- 注释内含 <path d="M0 0"/> -->',
      '<defs><linearGradient id="grad" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#1677ff"/></linearGradient></defs>',
      '</g>', // 孤立闭标签，不应导致 depth < 0
      '<path d="M10 10 L100 100" stroke="#1677ff" fill="none"/>',
      '<rect x="10" y="10" width="50" height="30" fill="url(#grad)"/>',
      '<g><circle cx="60" cy="60" r="12" fill="#f5222d"/><text x="60" y="90">顶点 &gt; 原点</text></g>',
      '</svg>',
    ].join('\n');

    let prevCount = 0;
    for (let step = 5; step <= fullSvg.length; step += 7) {
      const prefix = fullSvg.slice(0, step);
      const progress = peekSvgProgress(prefix);
      if (!progress) continue;
      expect(progress.rootAttrs).toContain('viewBox="0 0 240 140"');
      expect(progress.elements.length).toBeGreaterThanOrEqual(prevCount);
      prevCount = progress.elements.length;
    }

    const finalProgress = peekSvgProgress(fullSvg);
    expect(finalProgress).not.toBeNull();
    expect(finalProgress!.elements).toHaveLength(4);
    expect(finalProgress!.animations).toEqual(['none', 'stroke-draw', 'fade-in', 'fade-in']);
  });

  it('preserves case-sensitive SVG attributes such as viewBox, gradientUnits, and clipPathUnits', () => {
    const svgSrc = [
      '<svg viewBox="0 0 120 80" preserveAspectRatio="xMidYMid meet">',
      '<defs><linearGradient id="lg" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#000"/></linearGradient></defs>',
      '<clipPath id="cp" clipPathUnits="objectBoundingBox"><rect width="1" height="1"/></clipPath>',
      '<path d="M0 0 L50 50" pathLength="100" stroke="#000" fill="none"/>',
      '<text x="10" y="20" textLength="40" lengthAdjust="spacingAndGlyphs">文本</text>',
    ].join('');

    const progress = peekSvgProgress(svgSrc);
    expect(progress).not.toBeNull();
    expect(progress!.rootAttrs).toContain('viewBox="0 0 120 80"');
    expect(progress!.rootAttrs).toContain('preserveAspectRatio="xMidYMid meet"');
    const joined = progress!.elements.join('\n');
    expect(joined).toContain('gradientUnits="userSpaceOnUse"');
    expect(joined).toContain('clipPathUnits="objectBoundingBox"');
    expect(joined).toContain('pathLength="100"');
    expect(joined).toContain('textLength="40"');
    expect(joined).toContain('lengthAdjust="spacingAndGlyphs"');
  });

  it('blocks XSS payloads (<script>, onload/onerror, javascript: URI, external href and external url())', () => {
    const xssSvg = [
      '<svg viewBox="0 0 100 100">',
      '<script>window.__xss = 1;</script>',
      '<rect width="20" height="20" onload="alert(1)" onerror="alert(2)" style="background:url(javascript:alert(3))"/>',
      '<a href="javascript:alert(4)"><circle cx="30" cy="30" r="10" fill="red"/></a>',
      '<image href="https://evil.example/track.png" xlink:href="https://evil.example/track2.png"/>',
      '</svg>',
    ].join('');

    const progress = peekSvgProgress(xssSvg);
    expect(progress).not.toBeNull();
    const combined = progress!.elements.join('');
    expect(combined).not.toMatch(/<script|onload|onerror|javascript:|evil\.example|<image|<a\b/i);
    expect(combined).toContain('<rect');
    expect(combined).toContain('<circle');

    // 外部 url(...) 引用必须直接拒绝
    expect(() =>
      peekSvgProgress('<svg viewBox="0 0 50 50"><rect width="10" height="10" fill="url(https://evil.example/a.svg#x)"/></svg>'),
    ).toThrow(/外部资源/);
    expect(() =>
      sanitizeSvg('<svg viewBox="0 0 50 50"><rect width="10" height="10" fill="url(https://evil.example/a.svg#x)"/></svg>'),
    ).toThrow(/外部资源/);
  });

  it('hits the fragment LRU cache on repeated streaming frames and classifies stroke-draw vs fade-in', () => {
    clearSvgSanitizeCache();
    const frame1 = '<svg viewBox="0 0 100 100"><path d="M0 0 L50 50" stroke="#1677ff" fill="none"/>';
    const frame2 = `${frame1}<rect x="10" y="10" width="20" height="20" fill="#52c41a"/>`;
    const frame3 = `${frame2}<text x="20" y="40">标题</text>`;

    peekSvgProgress(frame1);
    const stats1 = getSvgSanitizeCacheStats();
    expect(stats1.misses).toBe(1);
    expect(stats1.hits).toBe(0);

    peekSvgProgress(frame2);
    const stats2 = getSvgSanitizeCacheStats();
    expect(stats2.misses).toBe(2);
    expect(stats2.hits).toBe(1);

    const p3 = peekSvgProgress(frame3)!;
    const stats3 = getSvgSanitizeCacheStats();
    expect(stats3.misses).toBe(3);
    expect(stats3.hits).toBe(3);

    expect(p3.animations).toEqual(['stroke-draw', 'fade-in', 'fade-in']);
    expect(classifySvgElementAnimation( sanitizeSvgFragment('<line x1="0" y1="0" x2="10" y2="10" stroke="#000"/>'))).toBe(
      'stroke-draw',
    );

    const host = document.createElement('div');
    host.innerHTML = `<svg viewBox="0 0 100 100">${p3.elements.join('')}</svg>`;
    const svgRoot = host.querySelector('svg')!;
    Array.from(svgRoot.children).forEach((child, idx) => markShapes(child, idx));
    expect(svgRoot.querySelector('path')?.getAttribute('pathLength')).toBe('1');
    expect(svgRoot.querySelector('path')?.classList.contains('xmd-svg-stroke')).toBe(true);
    expect(svgRoot.querySelector('rect')?.classList.contains('xmd-svg-fill')).toBe(true);
    expect(svgRoot.querySelector('text')?.classList.contains('xmd-svg-fade')).toBe(true);
  });
});

describe('artifactEditEngine: applyArtifactReply, replaceArtifactFence, and 10-step ArtifactUndoStack', () => {
  it('applies multiple non-overlapping patches against the same original source simultaneously', () => {
    const source = '{"type":"plot","x":[-2,2],"curves":[{"fn":"x^2","label":"二次函数"}]}';
    const reply = parseArtifactReply(
      '```json\n{"edits":[{"search":"[-2,2]","replace":"[-5,5]"},{"search":"x^2","replace":"sin(x)"},{"search":"二次函数","replace":"正弦曲线"}]}\n```',
    );
    const patched = applyArtifactReply(source, reply, 'patch');
    expect(patched).toBe('{"type":"plot","x":[-5,5],"curves":[{"fn":"sin(x)","label":"正弦曲线"}]}');

    // 即使第一项把 a 改成 b、第二项把 b 改成 a，也都基于同一份原始 source 定位
    const swapped = applyArtifactReply(
      'first=alpha, second=beta',
      {
        edits: [
          { search: 'alpha', replace: 'beta' },
          { search: 'beta', replace: 'alpha' },
        ],
      },
      'patch',
    );
    expect(swapped).toBe('first=beta, second=alpha');
  });

  it('rejects overlapping patches, non-unique matches, missing matches, and no-op edits while preserving original content', () => {
    const base = 'node_a -> node_b -> node_c (node_a)';

    // 不唯一匹配（node_a 出现两次）
    expect(() =>
      applyArtifactReply(base, { edits: [{ search: 'node_a', replace: 'node_x' }] }, 'patch'),
    ).toThrow(/不唯一/);

    // 重叠范围（"node_b -> " 与 "-> node_c" 在 "->" 处重叠）
    expect(() =>
      applyArtifactReply(
        base,
        {
          edits: [
            { search: 'node_b ->', replace: 'X' },
            { search: '-> node_c', replace: 'Y' },
          ],
        },
        'patch',
      ),
    ).toThrow(/范围重叠/);

    // 不存在的匹配
    expect(() =>
      applyArtifactReply(base, { edits: [{ search: 'not_found', replace: 'X' }] }, 'patch'),
    ).toThrow(/不存在或不唯一/);

    // 无变化
    expect(() =>
      applyArtifactReply(base, { edits: [{ search: 'node_b', replace: 'node_b' }] }, 'patch'),
    ).toThrow(/没有修改/);
  });

  it('replaces fenced artifacts accurately and blocks fence-escape injection', () => {
    const diagramSrc = '{"type":"plot","curves":[{"fn":"x^2"}]}';
    const nextDiagram = '{"type":"plot","curves":[{"fn":"cos(x)"}]}';
    const svgSrc = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
    const markdown = [
      '第一段讲解正文',
      '',
      '```diagram',
      diagramSrc,
      '```',
      '',
      '中间过渡说明',
      '',
      '~~~svg',
      svgSrc,
      '~~~',
      '',
      '结尾总结',
    ].join('\n');

    expect(artifactFences(markdown)).toHaveLength(2);
    const updated = replaceArtifactFence(markdown, 'diagram', diagramSrc, nextDiagram);
    expect(updated).toContain(nextDiagram);
    expect(updated).toContain(svgSrc);
    expect(updated).toContain('第一段讲解正文');

    // 拦截闭合围栏逃逸注入
    expect(() =>
      replaceArtifactFence(markdown, 'diagram', diagramSrc, `${nextDiagram}\n\`\`\`\n恶意注入正文\n\`\`\`diagram\n{}`),
    ).toThrow(/包含围栏结束标记，已拒绝覆盖/);

    expect(() =>
      replaceArtifactFence(markdown, 'svg', svgSrc, `${svgSrc}\n~~~\n逃逸波浪线围栏`),
    ).toThrow(/包含围栏结束标记，已拒绝覆盖/);
  });

  it('maintains a block-level independent undo stack capped at 10 steps', () => {
    const stack = new ArtifactUndoStack();
    expect(stack.maxSteps).toBe(MAX_ARTIFACT_UNDO_STEPS);
    expect(stack.maxSteps).toBe(10);

    // 压入 12 步修改，最多只保留最近 10 步
    for (let i = 1; i <= 12; i++) {
      stack.push({
        blockKey: 'diagram-1',
        kind: 'diagram',
        before: `v${i - 1}`,
        after: `v${i}`,
      });
    }
    expect(stack.size).toBe(10);
    expect(stack.getHistory()[0].before).toBe('v2');
    expect(stack.getHistory()[9].after).toBe('v12');

    // 不同块独立撤销：插入 svg-2 的修改后，撤销 diagram-1 不影响 svg-2
    stack.push({
      blockKey: 'svg-2',
      kind: 'svg',
      before: '<svg viewBox="0 0 10 10"><rect width="2" height="2"/></svg>',
      after: '<svg viewBox="0 0 10 10"><rect width="8" height="8"/></svg>',
    });
    expect(stack.size).toBe(10);

    const undoneDiagram = stack.undo({ blockKey: 'diagram-1', currentSource: 'v12' });
    expect(undoneDiagram).not.toBeNull();
    expect(undoneDiagram!.before).toBe('v11');
    expect(stack.canUndo({ blockKey: 'svg-2' })).toBe(true);

    // 验证在全文中按块独立撤销围栏修改
    const docContent = [
      '```diagram',
      'v11',
      '```',
      '',
      '```svg',
      '<svg viewBox="0 0 10 10"><rect width="8" height="8"/></svg>',
      '```',
    ].join('\n');

    const { content: afterSvgUndo } = stack.undoFenceInContent(docContent, {
      kind: 'svg',
      currentSource: '<svg viewBox="0 0 10 10"><rect width="8" height="8"/></svg>',
      blockKey: 'svg-2',
    });
    expect(afterSvgUndo).toContain('<rect width="2" height="2"/>');
    expect(afterSvgUndo).toContain('v11');
  });
});
