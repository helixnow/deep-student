# 参数探索起步示例

以下片段可作为 show_widget(format="html",code=...) 的起点，不需要 libs。根据题意改变画面与参数，切勿照搬不相关控件。它只展示一个主要变量，input 重绘，change 保存，追问由宿主确认。

标记里已写好默认读数、画布尺寸、绘图框和 a = 1 时的曲线，生成过程中的无脚本预览就是有效首帧；脚本接管后按实际宽度重绘同一批元素。

```html
<section id="quadratic-explorer" aria-label="抛物线系数探索">
  <h3>抛物线的开口</h3>
  <div class="wbw-controls">
    <label class="wbw-field"><span class="wbw-field-header">系数 a <output class="wbw-value">1.00</output></span>
      <input aria-label="系数 a" type="range" min="-3" max="3" step="0.25" value="1">
    </label>
    <button type="button" data-wbw-prompt="解释当前系数下抛物线的开口和变化">解释当前情况</button>
  </div>
  <div class="wbw-stage">
    <svg role="img" viewBox="0 0 320 240" width="320" height="240" aria-label="y 等于 a 乘以 x 的平方，横轴 x，纵轴 y">
      <title>y = ax²</title>
      <desc>横轴 x 与纵轴 y 均为无量纲数值。改变系数，比较曲线在同一坐标范围内的开口。</desc>
      <rect data-chart-frame x="64" y="32" width="240" height="160" fill="none" stroke="var(--wbw-border)"></rect>
      <g data-grid fill="none" stroke="var(--wbw-border)" stroke-width="1"></g>
      <g data-ticks></g>
      <path data-curve d="M64 89 Q184 135 304 89" fill="none" stroke="var(--wbw-series-1)" stroke-width="2"></path>
      <text class="axis-title" data-axis="x" x="184" y="236" text-anchor="middle">x（无量纲）</text>
      <text class="axis-title" data-axis="y" x="64" y="16">y（无量纲）</text>
    </svg>
  </div>
  <p data-status role="status" aria-live="polite" class="wbw-muted wbw-small"></p>
</section>
<script>
(() => {
  const root = document.getElementById('quadratic-explorer');
  const input = root.querySelector('input');
  const svg = root.querySelector('svg');
  const status = root.querySelector('[data-status]');
  const api = window.__wbw ?? window.openchamber;
  let a = 1;
  const xs = Array.from({length: 81}, (_, i) => -2 + i / 20);
  // Cover all allowed coefficients on one scale so changing a does not merely rescale the axes.
  const envelope = xs.flatMap(x => [Number(input.min) * x * x, Number(input.max) * x * x]);
  const low = Math.min(...envelope), high = Math.max(...envelope), margin = (high - low) * .08;
  const ymin = low - margin, ymax = high + margin;
  function draw() {
    const w = root.querySelector('.wbw-stage').clientWidth || 300;
    const labelSize = parseFloat(getComputedStyle(root).getPropertyValue('--wbw-font-size-small')) || 12;
    const h = 240, left = Math.max(64, labelSize * 4), right = 16;
    const top = 32, bottom = 48, plotW = w - left - right, plotH = h - top - bottom;
    const X = x => left + (x + 2) / 4 * plotW;
    const Y = y => top + (ymax - y) / (ymax - ymin) * plotH;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w); svg.setAttribute('height', h);
    root.querySelector('output').textContent = a.toFixed(2);
    input.value = a;
    const frame = root.querySelector('[data-chart-frame]');
    for (const [key, value] of Object.entries({x: left, y: top, width: plotW, height: plotH})) frame.setAttribute(key, value);
    const xticks = w < 360 ? [-2, 0, 2] : [-2, -1, 0, 1, 2];
    const yticks = labelSize > 13 ? [-12, 0, 12] : [-12, -6, 0, 6, 12];
    root.querySelector('[data-grid]').innerHTML = yticks.map(y => `<path d="M${left},${Y(y)}H${w-right}" opacity="${y === 0 ? 1 : .35}"/>`).join('');
    root.querySelector('[data-ticks]').innerHTML = xticks.map(x => `<text x="${X(x)}" y="${h-bottom+20}" text-anchor="${x === -2 ? 'start' : x === 2 ? 'end' : 'middle'}">${x}</text>`).join('')
      + yticks.map(y => `<text x="${left-8}" y="${Y(y)}" text-anchor="end" dominant-baseline="middle">${y}</text>`).join('');
    root.querySelector('[data-curve]').setAttribute('d', xs.map((x, i) => {
      return `${i ? 'L' : 'M'}${X(x)},${Y(a*x*x)}`;
    }).join(' '));
    const tx = root.querySelector('[data-axis="x"]'), ty = root.querySelector('[data-axis="y"]');
    tx.setAttribute('x', left + plotW / 2); tx.setAttribute('y', h-4); tx.setAttribute('text-anchor', 'middle');
    ty.setAttribute('x', left); ty.setAttribute('y', 16);
  }
  function restore() {
    const saved = api.widgetState?.modelContent;
    const value = saved?.['系数 a'] ?? saved?.a;
    a = typeof value === 'number' && value >= -3 && value <= 3 ? value : 1;
    draw();
  }
  input.oninput = () => { a = Number(input.value); draw(); };
  input.onchange = () => {
    if (!api.persistent) return;
    api.setWidgetState({modelContent: {'系数 a': a}, privateContent: null})
      .then(() => { status.textContent = ''; })
      .catch(error => { status.textContent = error.message; });
  };
  new ResizeObserver(draw).observe(root);
  window.addEventListener('wbw:statechange', restore);
  window.addEventListener('wbw:themechange', draw);
  restore();
})();
</script>
```

## 并排对比两种方案

比较“参数 A 与参数 B 的差别”时，优先把两条曲线画在**同一坐标范围**的同一画面里，用 series-1 实线 / series-2 虚线和直接标签区分；只有两幅图的量纲或坐标不同才拆成 `.wbw-grid` 的两栏，并让两栏共享刻度范围。

- 控件按方案分组，每组用 fieldset/legend 写明「方案 A」「方案 B」，当前值放标签旁。
- 画面下方至多一行差值读数（如「同一 x 处 A 比 B 高 3.0」），推导放正文。
- modelContent 写成 `{"方案 A 系数": 1, "方案 B 系数": 2}`，便于追问时读懂。
- 对比数据较多时用 `.wbw-table` 语义表格，不另做卡片。

算法逐步执行见 `stepper.md`，随时间演化见 `simulation.md`。
