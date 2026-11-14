# 直接操作（拖动图形）

适用：拖动点、角、边界、控制点来观察几何或函数关系，比滑块更直观的场景。拖动只是额外入口：每个可拖动对象同时必须能用键盘操作，并在标签旁显示当前值。

## 要点

- 用 Pointer Events（pointerdown/move/up + setPointerCapture），一套代码覆盖鼠标、触屏和笔，不分别写 mouse/touch。
- `touch-action: none` 只加在拖动手柄上，不加在整幅图上，避免手指放在图上时无法滚动聊天。手柄可见半径小一些，但透明命中区至少 22px 半径（约 44px 触控目标）。
- 手柄是 `role="slider"`、`tabindex="0"`，带 aria-label、aria-valuemin/max/now 与 aria-valuetext；方向键微调，Shift + 方向键大步，Home/End 到端点。处理过的按键调用 preventDefault 和 stopPropagation，不让宿主把它当成滚动。
- 指针坐标用 `svg.getScreenCTM().inverse()` 转为 SVG 坐标，不手算缩放比例，宽度变化后也正确。
- 拖动中只重绘；pointerup / 键盘 keyup 时保存一次。
- 当前值读数放在图下，aria-valuetext 已能朗读，不要再给每次拖动加 aria-live。
- 标记里写好默认角度下的全部图元位置，生成中的预览就是有效首帧。

## 可运行示例：单位圆上的 sin 与 cos

无需 libs。

```html
<style>
#unit-circle .handle { cursor: grab; touch-action: none; outline: none; }
#unit-circle .handle:active { cursor: grabbing; }
#unit-circle .handle:focus-visible .ring { stroke: var(--wbw-focus); stroke-width: 3; }
#unit-circle svg { max-width: min(100%, 360px); }
#unit-circle .readout { font-variant-numeric: tabular-nums; }
</style>
<section id="unit-circle" aria-label="单位圆角度探索">
  <h3>单位圆：拖动点 P 改变角度 θ</h3>
  <div class="wbw-stage">
    <svg viewBox="0 0 280 280" width="280" height="280" role="group" aria-label="单位圆，圆心 O，半径 1；P 在圆上，横向虚线长度为 cos θ，纵向实线长度为 sin θ">
      <title>单位圆上的 sin θ 与 cos θ</title>
      <line x1="20" y1="140" x2="260" y2="140" stroke="var(--wbw-border)"/>
      <line x1="140" y1="20" x2="140" y2="260" stroke="var(--wbw-border)"/>
      <circle cx="140" cy="140" r="100" fill="none" stroke="currentColor" stroke-opacity=".5"/>
      <path data-arc d="M168 140 A28 28 0 0 0 164.2 126" fill="none" stroke="currentColor"/>
      <line data-radius x1="140" y1="140" x2="226.6" y2="90" stroke="currentColor"/>
      <line data-cos x1="140" y1="140" x2="226.6" y2="140" stroke="var(--wbw-series-2)" stroke-width="3" stroke-dasharray="6 4"/>
      <line data-sin x1="226.6" y1="140" x2="226.6" y2="90" stroke="var(--wbw-series-1)" stroke-width="3"/>
      <text x="128" y="156" fill="currentColor">O</text>
      <text x="262" y="136" fill="currentColor">1</text>
      <g class="handle" data-handle tabindex="0" role="slider" aria-label="角度 θ" aria-valuemin="0" aria-valuemax="359" aria-valuenow="30" aria-valuetext="θ = 30°，cos θ = 0.866，sin θ = 0.500">
        <circle data-hit cx="226.6" cy="90" r="22" fill="transparent"/>
        <circle class="ring" data-dot cx="226.6" cy="90" r="7" fill="var(--wbw-surface)" stroke="var(--wbw-accent)" stroke-width="2"/>
        <text data-label x="236.6" y="80" fill="currentColor">P</text>
      </g>
    </svg>
  </div>
  <div class="wbw-legend">
    <span><i class="wbw-swatch" aria-hidden="true"></i>sin θ（纵向实线）</span>
    <span><i class="wbw-swatch" style="--series-color:var(--wbw-series-2);border-top-style:dashed" aria-hidden="true"></i>cos θ（横向虚线）</span>
  </div>
  <p class="readout" data-readout>θ = 30°　cos θ = 0.866　sin θ = 0.500</p>
  <div class="wbw-controls"><button type="button" data-wbw-prompt="解释当前角度下 sin 和 cos 的符号与大小">解释当前情况</button></div>
  <p class="wbw-error" data-error role="alert"></p>
</section>
<script>
(() => {
  const root = document.getElementById('unit-circle'), api = window.__wbw ?? window.openchamber;
  const svg = root.querySelector('svg'), handle = root.querySelector('[data-handle]');
  const error = root.querySelector('[data-error]');
  const CX = 140, CY = 140, R = 100;
  let deg = 30, dragging = false;
  const q = selector => root.querySelector(selector);
  const set = (el, attrs) => { for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, typeof v === 'number' ? v.toFixed(1) : v); };
  function draw() {
    const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    const px = CX + R * c, py = CY - R * s;
    set(q('[data-radius]'), { x2: px, y2: py });
    set(q('[data-cos]'), { x2: px });
    set(q('[data-sin]'), { x1: px, x2: px, y2: py });
    set(q('[data-hit]'), { cx: px, cy: py }); set(q('[data-dot]'), { cx: px, cy: py });
    set(q('[data-label]'), { x: px + (c >= 0 ? 10 : -20), y: py + (s >= 0 ? -10 : 20) });
    const ax = CX + 28 * c, ay = CY - 28 * s;
    set(q('[data-arc]'), { d: `M${CX + 28} ${CY} A28 28 0 ${deg > 180 ? 1 : 0} 0 ${ax.toFixed(1)} ${ay.toFixed(1)}` });
    const text = `θ = ${deg}°，cos θ = ${c.toFixed(3)}，sin θ = ${s.toFixed(3)}`;
    handle.setAttribute('aria-valuenow', deg); handle.setAttribute('aria-valuetext', text);
    q('[data-readout]').textContent = `θ = ${deg}°　cos θ = ${c.toFixed(3)}　sin θ = ${s.toFixed(3)}`;
  }
  function save() {
    if (!api.persistent) return;
    const t = deg * Math.PI / 180;
    api.setWidgetState({
      modelContent: { '角度 θ': `${deg}°`, 'cos θ': Number(Math.cos(t).toFixed(3)), 'sin θ': Number(Math.sin(t).toFixed(3)) },
      privateContent: { version: 1, deg }
    }).then(() => { error.textContent = ''; })
      .catch(reason => { error.textContent = `未保存：${reason.message || '请重试'}`; });
  }
  function fromPointer(event) {
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    const angle = Math.atan2(CY - point.y, point.x - CX) * 180 / Math.PI;
    deg = (Math.round(angle) + 360) % 360;
    draw();
  }
  handle.addEventListener('pointerdown', event => { dragging = true; handle.setPointerCapture(event.pointerId); handle.focus(); fromPointer(event); });
  handle.addEventListener('pointermove', event => { if (dragging) fromPointer(event); });
  const end = () => { if (dragging) { dragging = false; save(); } };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('keydown', event => {
    const big = event.shiftKey ? 15 : 1;
    const delta = { ArrowRight: -big, ArrowDown: -big, ArrowLeft: big, ArrowUp: big }[event.key];
    if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault(); event.stopPropagation();
    deg = event.key === 'Home' ? 0 : event.key === 'End' ? 359 : (deg + delta + 360) % 360;
    draw();
  });
  handle.addEventListener('keyup', event => { if (/^Arrow|^Home$|^End$/.test(event.key)) save(); });
  function restore() {
    if (dragging) return;
    const s = api.widgetState?.privateContent;
    deg = s?.version === 1 && Number.isInteger(s.deg) && s.deg >= 0 && s.deg < 360 ? s.deg : 30;
    draw();
  }
  window.addEventListener('wbw:statechange', restore);
  restore();
})();
</script>
```

## 其他对象的改法

- 函数图像上的点：只沿曲线移动时，把指针 x 转成定义域内的值再算 y；读数给出 (x, f(x)) 与该点切线斜率。
- 几何图形顶点：三角形三个顶点各是一个 slider 组（键盘用方向键在二维移动，aria-valuetext 写坐标），读数给出角度和/边长。
- 区间边界：两个手柄限制在同一轴上，左手柄不能越过右手柄；也可直接用两个原生 range 输入，更简单时优先原生控件。
