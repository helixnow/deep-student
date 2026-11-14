# 交互数据图（Chart.js）

普通柱/折/饼图按 `references/static-diagrams.md` 用 diagram JSON，不生成网页。只有需要**调参后重算数据**、悬停读数或多系列切换时才用本文件：调用 show_widget 时传 `libs:["chart.js"]`，使用全局 `Chart`，不引 CDN。

## 要点

- 主题色来自 CSS 变量，可能是 oklch()/color-mix()，Chart.js 不能直接解析。先用 1×1 canvas 把颜色转成 rgba 字符串，在 wbw:themechange 时重新读取并 `chart.update('none')`。
- `animation: false`：调参即时重绘，不做过渡动画。
- 容器给固定高度（如 `height: min(280px, var(--wbw-available-height))`），`maintainAspectRatio: false`；不要让 canvas 自己撑高 iframe。
- 多系列同时用颜色和线型（borderDash）区分，并用 `.wbw-legend` 写 HTML 图例，关闭 Chart.js 自带图例，保证线型与图例一致。
- 坐标范围按全部可选参数的最大值固定（`suggestedMax`），调参时不悄悄改变刻度。
- 轴标题写量和单位；tooltip 用 `mode: 'index', intersect: false`，便于触屏读数。
- 生成中的预览不运行脚本，canvas 为空：在标记里写好标题、控件默认值、图例和一行默认读数，并给容器确定高度，避免图出现时跳动。
- 画布下方保留一行文字读数，canvas 本身给 role="img" 与概括性的 aria-label，不依赖悬停才能获取关键数值。

## 可运行示例：单利与复利

调用时传 `libs:["chart.js"]`。

```html
<style>
#interest-chart .plot { position: relative; height: min(280px, var(--wbw-available-height)); }
#interest-chart .readout { font-variant-numeric: tabular-nums; }
</style>
<section id="interest-chart" aria-label="单利与复利对比">
  <h3>本金 1 万元：单利与复利 30 年对比</h3>
  <div class="wbw-controls">
    <label class="wbw-field"><span class="wbw-field-header">年利率 r <output class="wbw-value">5.0%</output></span>
      <input type="range" min="1" max="10" step="0.5" value="5" aria-label="年利率，百分比">
    </label>
  </div>
  <div class="wbw-legend">
    <span><i class="wbw-swatch" aria-hidden="true"></i>复利（实线）</span>
    <span><i class="wbw-swatch" style="--series-color:var(--wbw-series-2);border-top-style:dashed" aria-hidden="true"></i>单利（虚线）</span>
  </div>
  <div class="wbw-stage plot"><canvas role="img" aria-label="横轴年份 0 到 30，纵轴余额万元；复利曲线随年份加速上升，单利为直线"></canvas></div>
  <p class="readout" data-readout role="status" aria-live="polite">第 30 年：复利 4.32 万元，单利 2.50 万元，相差 1.82 万元</p>
  <p class="wbw-error" data-error role="alert"></p>
</section>
<script>
(() => {
  const root = document.getElementById('interest-chart'), api = window.__wbw ?? window.openchamber;
  const input = root.querySelector('input'), output = root.querySelector('output');
  const readout = root.querySelector('[data-readout]'), error = root.querySelector('[data-error]');
  const years = Array.from({ length: 31 }, (_, i) => i);
  const MAX = Math.ceil(Math.pow(1 + Number(input.max) / 100, 30));
  let rate = 5;
  // Chart.js cannot parse oklch()/color-mix(); let the browser resolve the token to RGBA.
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  function token(name, alpha = 1) {
    const raw = getComputedStyle(root).getPropertyValue(name).trim() || getComputedStyle(root).color;
    probe.clearRect(0, 0, 1, 1); probe.fillStyle = '#000'; probe.fillStyle = raw; probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${(a / 255 * alpha).toFixed(3)})`;
  }
  function series() {
    const r = rate / 100;
    return { compound: years.map(n => Math.pow(1 + r, n)), simple: years.map(n => 1 + r * n) };
  }
  function themed() {
    const font = { family: getComputedStyle(root).fontFamily, size: parseFloat(getComputedStyle(root).getPropertyValue('--wbw-font-size-small')) || 12 };
    const fg = token('--wbw-foreground'), muted = token('--wbw-muted'), grid = token('--wbw-border', .35);
    const axis = title => ({ grid: { color: grid }, border: { color: token('--wbw-border') }, ticks: { color: muted, font }, title: { display: true, text: title, color: fg, font } });
    return { font, fg, s1: token('--wbw-series-1'), s2: token('--wbw-series-2'), x: axis('年份'), y: { ...axis('余额（万元）'), min: 0, suggestedMax: MAX } };
  }
  const t = themed(), data = series();
  const chart = new Chart(root.querySelector('canvas'), {
    type: 'line',
    data: { labels: years, datasets: [
      { label: '复利', data: data.compound, borderColor: t.s1, backgroundColor: t.s1, borderWidth: 2, pointRadius: 0 },
      { label: '单利', data: data.simple, borderColor: t.s2, backgroundColor: t.s2, borderWidth: 2, borderDash: [6, 4], pointRadius: 0 },
    ] },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: items => `第 ${items[0].label} 年`, label: item => `${item.dataset.label}：${item.parsed.y.toFixed(2)} 万元` } } },
      scales: { x: t.x, y: t.y },
    },
  });
  function render() {
    const d = series();
    chart.data.datasets[0].data = d.compound; chart.data.datasets[1].data = d.simple;
    chart.update('none');
    output.textContent = `${rate.toFixed(1)}%`; input.value = rate;
    const c = d.compound[30], s = d.simple[30];
    readout.textContent = `第 30 年：复利 ${c.toFixed(2)} 万元，单利 ${s.toFixed(2)} 万元，相差 ${(c - s).toFixed(2)} 万元`;
  }
  function retheme() {
    const next = themed();
    chart.data.datasets[0].borderColor = chart.data.datasets[0].backgroundColor = next.s1;
    chart.data.datasets[1].borderColor = chart.data.datasets[1].backgroundColor = next.s2;
    chart.options.scales.x = next.x; chart.options.scales.y = next.y;
    chart.update('none');
  }
  input.oninput = () => { rate = Number(input.value); render(); };
  input.onchange = () => {
    if (!api.persistent) return;
    const d = series();
    api.setWidgetState({
      modelContent: { '年利率': `${rate}%`, '第 30 年复利': `${d.compound[30].toFixed(2)} 万元`, '第 30 年单利': `${d.simple[30].toFixed(2)} 万元` },
      privateContent: { version: 1, rate }
    }).then(() => { error.textContent = ''; }).catch(reason => { error.textContent = `未保存：${reason.message || '请重试'}`; });
  };
  function restore() {
    const s = api.widgetState?.privateContent;
    rate = s?.version === 1 && Number.isFinite(s.rate) && s.rate >= 1 && s.rate <= 10 ? s.rate : 5;
    render();
  }
  window.addEventListener('wbw:statechange', restore);
  window.addEventListener('wbw:themechange', retheme);
  restore();
})();
</script>
```

## 其他图种

- 柱状图（type: 'bar'）对比类别时，类别不超过约 12 个；更多类别改为横向条形（indexAxis: 'y'）并按值排序。
- 散点 + 拟合线：散点 pointRadius 3，拟合线无点；读数给出斜率、截距和 R²。
- 饼图通常用 diagram 即可；只有需要调参重算比例时才用 Chart.js，并在读数中列出每块的百分比。
