# 过程模拟（随时间演化）

适用：运动学、波动、扩散、种群增长、电路充放电等“状态随时间连续变化”的过程。用户点击「播放」才开始，可暂停，播完停在终态，不循环。时间也可以用滑块直接拖到任意时刻，因此不播放也能完整观察。

## 动效规则

- 只由用户启动；没有自动播放、循环、装饰性过渡。
- `prefers-reduced-motion: reduce` 时，「播放」直接跳到终态；用户仍可拖动时间滑块逐帧查看。
- 用 requestAnimationFrame + 真实经过时间推进（不同刷新率速度一致），不用 setInterval。
- 页面隐藏（visibilitychange）或交互件滚出视口（IntersectionObserver）时暂停，不在后台继续耗电；回来后由用户继续。
- 播放中只更新画面与读数，不逐帧保存、不逐帧朗读。暂停、结束、调参完成时保存一次，并在 role="status" 里说一句结论。
- 调参时停止播放并回到 t = 0，避免旧轨迹与新参数混在一起。
- 坐标范围按全部可选参数的最大值固定，改参数不会悄悄重设刻度。

## 可运行示例：斜抛运动

无需 libs。标记里写好默认参数（v₀ = 20 m/s、θ = 45°）下的完整轨迹、坐标框和读数，生成中的预览就是终态示意。

```html
<style>
#projectile-sim .readout { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 4px 0 0; font-variant-numeric: tabular-nums; }
#projectile-sim [data-path] { stroke-dasharray: 4 4; }
</style>
<section id="projectile-sim" aria-label="斜抛运动模拟">
  <h3>斜抛运动：初速度与抛射角</h3>
  <div class="wbw-controls">
    <label class="wbw-field"><span class="wbw-field-header">初速度 v₀ <output class="wbw-value" data-out="v">20 m/s</output></span>
      <input type="range" data-input="v" min="5" max="30" step="1" value="20" aria-label="初速度，米每秒">
    </label>
    <label class="wbw-field"><span class="wbw-field-header">抛射角 θ <output class="wbw-value" data-out="a">45°</output></span>
      <input type="range" data-input="a" min="10" max="80" step="1" value="45" aria-label="抛射角，度">
    </label>
    <label class="wbw-field"><span class="wbw-field-header">时间 t <output class="wbw-value" data-out="t">2.89 s</output></span>
      <input type="range" data-input="t" min="0" max="1" step="0.001" value="1" aria-label="时间，占全程比例">
    </label>
  </div>
  <div class="wbw-controls">
    <button type="button" class="wbw-primary" data-play>播放</button>
    <button type="button" data-wbw-prompt="解释当前初速度和抛射角下的射程与最高点">解释当前情况</button>
  </div>
  <div class="wbw-stage">
    <svg role="img" viewBox="0 0 320 220" width="320" height="220" aria-label="斜抛轨迹，横轴水平距离米，纵轴高度米">
      <title>斜抛轨迹</title>
      <desc>虚线是完整轨迹，实心圆是 t 时刻的位置。忽略空气阻力，g = 9.8 m/s²。</desc>
      <rect data-frame x="64" y="16" width="240" height="160" fill="none" stroke="var(--wbw-border)"/>
      <g data-ticks fill="currentColor"></g>
      <path data-path d="M64 176 Q113 110.8 161.9 176" fill="none" stroke="var(--wbw-series-1)" stroke-width="1.5"/>
      <path data-trail d="M64 176 Q113 110.8 161.9 176" fill="none" stroke="var(--wbw-series-1)" stroke-width="2.5"/>
      <circle data-ball cx="161.9" cy="176" r="6" fill="var(--wbw-series-1)"/>
      <text data-axis="x" x="184" y="214" text-anchor="middle">水平距离 x（m）</text>
      <text data-axis="y" x="64" y="12">高度 y（m）</text>
    </svg>
  </div>
  <p class="readout wbw-small"><span data-read="pos">x = 40.8 m，y = 0.0 m</span><span data-read="sum">射程 40.8 m · 最高点 10.2 m · 飞行 2.89 s</span></p>
  <p data-status role="status" aria-live="polite" class="wbw-muted wbw-small"></p>
  <p class="wbw-error" data-error role="alert"></p>
</section>
<script>
(() => {
  const root = document.getElementById('projectile-sim'), api = window.__wbw ?? window.openchamber;
  const g = 9.8, input = name => root.querySelector(`[data-input="${name}"]`);
  const out = name => root.querySelector(`[data-out="${name}"]`);
  const svg = root.querySelector('svg'), stage = root.querySelector('.wbw-stage');
  const play = root.querySelector('[data-play]'), status = root.querySelector('[data-status]'), error = root.querySelector('[data-error]');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  // Fixed scale: the largest range/height any allowed parameter can produce.
  const vmax = Number(input('v').max), XMAX = Math.ceil(vmax * vmax / g / 10) * 10, YMAX = Math.ceil(vmax * vmax / (2 * g) * Math.sin(80 * Math.PI / 180) ** 2 / 10) * 10;
  let v = 20, a = 45, p = 1, playing = false, raf = 0, last = 0, visible = true;
  const flight = () => 2 * v * Math.sin(a * Math.PI / 180) / g;
  const at = t => { const r = a * Math.PI / 180; return { x: v * Math.cos(r) * t, y: Math.max(0, v * Math.sin(r) * t - g * t * t / 2) }; };
  function layout() {
    const w = Math.max(280, Math.round(stage.clientWidth || 320)), h = 220;
    const left = 64, right = 16, top = 16, bottom = 44;
    return { w, h, left, top, pw: w - left - right, ph: h - top - bottom };
  }
  function draw() {
    const L = layout(), T = flight(), t = p * T;
    const X = x => L.left + x / XMAX * L.pw, Y = y => L.top + L.ph - y / YMAX * L.ph;
    svg.setAttribute('viewBox', `0 0 ${L.w} ${L.h}`); svg.setAttribute('width', L.w);
    const frame = root.querySelector('[data-frame]');
    frame.setAttribute('width', L.pw); frame.setAttribute('height', L.ph);
    const xt = L.w < 360 ? [0, XMAX / 2, XMAX] : [0, XMAX / 4, XMAX / 2, XMAX * 3 / 4, XMAX];
    root.querySelector('[data-ticks]').innerHTML = xt.map(x => `<text x="${X(x)}" y="${L.top + L.ph + 18}" text-anchor="middle">${x}</text>`).join('')
      + [0, YMAX / 2, YMAX].map(y => `<text x="${L.left - 8}" y="${Y(y)}" text-anchor="end" dominant-baseline="middle">${y}</text>`).join('');
    const points = n => Array.from({ length: n + 1 }, (_, i) => at(i / 60 * T));
    const full = points(60), trail = points(Math.round(p * 60)).concat([at(t)]);
    const d = list => list.map((q, i) => `${i ? 'L' : 'M'}${X(q.x).toFixed(1)},${Y(q.y).toFixed(1)}`).join(' ');
    root.querySelector('[data-path]').setAttribute('d', d(full));
    root.querySelector('[data-trail]').setAttribute('d', d(trail));
    const now = at(t), ball = root.querySelector('[data-ball]');
    ball.setAttribute('cx', X(now.x)); ball.setAttribute('cy', Y(now.y));
    const tx = root.querySelector('[data-axis="x"]'); tx.setAttribute('x', L.left + L.pw / 2);
    out('v').textContent = `${v} m/s`; out('a').textContent = `${a}°`; out('t').textContent = `${t.toFixed(2)} s`;
    input('v').value = v; input('a').value = a; input('t').value = p;
    const range = v * v * Math.sin(2 * a * Math.PI / 180) / g, apex = (v * Math.sin(a * Math.PI / 180)) ** 2 / (2 * g);
    root.querySelector('[data-read="pos"]').textContent = `x = ${now.x.toFixed(1)} m，y = ${now.y.toFixed(1)} m`;
    root.querySelector('[data-read="sum"]').textContent = `射程 ${range.toFixed(1)} m · 最高点 ${apex.toFixed(1)} m · 飞行 ${T.toFixed(2)} s`;
    play.textContent = playing ? '暂停' : p >= 1 ? '重新播放' : '播放';
  }
  function save() {
    if (!api.persistent) return;
    const range = v * v * Math.sin(2 * a * Math.PI / 180) / g;
    api.setWidgetState({
      modelContent: { '初速度 v₀': `${v} m/s`, '抛射角 θ': `${a}°`, '当前时刻 t': `${(p * flight()).toFixed(2)} s`, '射程': `${range.toFixed(1)} m` },
      privateContent: { version: 1, v, a, p }
    }).then(() => { error.textContent = ''; })
      .catch(reason => { error.textContent = `未保存：${reason.message || '请重试'}`; });
  }
  function stop(message) {
    playing = false; cancelAnimationFrame(raf); raf = 0; draw();
    if (message) status.textContent = message;
    save();
  }
  function tick(now) {
    if (!playing) return;
    p = Math.min(1, p + (now - last) / 1000 / flight()); last = now; draw();
    if (p >= 1) { stop('落地。'); return; }
    raf = requestAnimationFrame(tick);
  }
  play.onclick = () => {
    if (playing) { stop(`已暂停在 t = ${(p * flight()).toFixed(2)} s。`); return; }
    if (p >= 1) p = 0;
    if (reduce.matches || !visible) { p = 1; stop('已显示落地时刻（减少动态效果）。'); return; }
    playing = true; status.textContent = ''; last = performance.now(); draw(); raf = requestAnimationFrame(tick);
  };
  for (const name of ['v', 'a']) {
    input(name).oninput = () => { if (playing) { playing = false; cancelAnimationFrame(raf); } v = Number(input('v').value); a = Number(input('a').value); p = 0; draw(); };
    input(name).onchange = () => { status.textContent = '参数已改变，点击播放观察新轨迹。'; save(); };
  }
  input('t').oninput = () => { if (playing) { playing = false; cancelAnimationFrame(raf); } p = Number(input('t').value); draw(); };
  input('t').onchange = save;
  document.addEventListener('visibilitychange', () => { if (document.hidden && playing) stop('页面隐藏，已暂停。'); });
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (!visible && playing) stop('已滚出视野，已暂停。'); }).observe(root);
  function restore() {
    if (playing) return;
    const s = api.widgetState?.privateContent;
    const ok = s?.version === 1 && Number.isInteger(s.v) && s.v >= 5 && s.v <= 30 && Number.isInteger(s.a) && s.a >= 10 && s.a <= 80 && Number.isFinite(s.p) && s.p >= 0 && s.p <= 1;
    if (ok) { v = s.v; a = s.a; p = s.p; }
    draw();
  }
  new ResizeObserver(() => draw()).observe(stage);
  window.addEventListener('wbw:statechange', restore);
  window.addEventListener('wbw:themechange', draw);
  restore();
})();
</script>
```

## 其他过程的改法

- 指数增长/衰减、RC 充放电：横轴时间、纵轴数量，已走过的部分实线、未来部分虚线；读数给出当前值与半衰期/时间常数。
- 波动：两个以上质点的位置随时间变化时，用同一 SVG 中的折线逐帧重画，额外给一个「单帧前进」按钮供无动效用户使用。
- 粒子/扩散：粒子数不超过几百个，用 canvas 并适配 devicePixelRatio；随机过程固定种子，保证重播一致，并在说明里注明“示例随机数”。
