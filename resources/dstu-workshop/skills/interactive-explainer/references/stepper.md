# 算法单步

适用：排序、查找、递推、矩阵运算、推导变形等“每一步状态都可以列出来”的过程。先在本地用已核实的输入算出全部步骤，再用「上一步 / 下一步」在同一个画面里切换；不自动播放，不在每一步请求模型。材料没有给输入时注明“示例输入”。

## 要点

- 步骤数组在脚本里一次算好，每项只记录画面需要的最小状态（范围、指针、比较结果、一句说明）。
- 画面只有一个：当前步骤高亮，已排除的部分弱化（虚线边框或 muted 文字），不能只靠颜色；指针用文字标记（L / M / R）。
- 下方一行说明当前比较和下一步原因，role="status" + aria-live="polite"；边界时禁用对应按钮。
- 保存 `{目标, 当前步骤, 范围}` 到 modelContent，`{version, step}` 到 privateContent；按钮点击后保存。保存未完成时忽略回声恢复，避免连点时画面回退。
- 标记里写好初始步骤（全部单元、初始指针、说明），生成中的预览即是第 0 步。

## 可运行示例：二分查找

无需 libs。

```html
<style>
#binary-search-stepper .cells { display: flex; flex-wrap: wrap; gap: 4px; list-style: none; padding: 0; margin: 8px 0; }
#binary-search-stepper .cell { display: grid; justify-items: center; min-width: 2.75em; padding: 6px 4px 2px; border: 1px solid var(--wbw-border); border-radius: var(--wbw-radius); font-variant-numeric: tabular-nums; }
#binary-search-stepper .cell[data-out] { color: var(--wbw-muted); border-style: dashed; }
#binary-search-stepper .cell[data-mid] { border-color: var(--wbw-accent); box-shadow: inset 0 0 0 1px var(--wbw-accent); }
#binary-search-stepper .cell[data-found] { background: color-mix(in oklch, var(--wbw-accent) 16%, transparent); }
#binary-search-stepper .mark { min-height: 1.5em; font-size: var(--wbw-font-size-small); color: var(--wbw-muted); }
</style>
<section id="binary-search-stepper" aria-label="二分查找单步演示">
  <h3>二分查找：在有序数组中找 23</h3>
  <p class="wbw-muted wbw-small">示例输入。L、R 是当前搜索范围的两端，M 是本步比较的中点；虚线表示已排除。</p>
  <ol class="cells" aria-label="有序数组，共 10 个元素">
    <li class="cell">2<span class="mark">L</span></li>
    <li class="cell">5<span class="mark"></span></li>
    <li class="cell">8<span class="mark"></span></li>
    <li class="cell">12<span class="mark"></span></li>
    <li class="cell">16<span class="mark"></span></li>
    <li class="cell">23<span class="mark"></span></li>
    <li class="cell">38<span class="mark"></span></li>
    <li class="cell">56<span class="mark"></span></li>
    <li class="cell">72<span class="mark"></span></li>
    <li class="cell">91<span class="mark">R</span></li>
  </ol>
  <div class="wbw-controls">
    <button type="button" data-prev disabled>上一步</button>
    <button type="button" class="wbw-primary" data-next>下一步</button>
    <span class="wbw-muted" data-progress>第 0 / 3 步</span>
  </div>
  <p data-detail role="status" aria-live="polite">初始：搜索范围是下标 0–9，尚未比较。</p>
  <p class="wbw-error" data-error role="alert"></p>
</section>
<script>
(() => {
  const root = document.getElementById('binary-search-stepper'), api = window.__wbw ?? window.openchamber;
  const values = [2, 5, 8, 12, 16, 23, 38, 56, 72, 91], target = 23;
  const cells = [...root.querySelectorAll('.cell')];
  const prev = root.querySelector('[data-prev]'), next = root.querySelector('[data-next]');
  const progress = root.querySelector('[data-progress]'), detail = root.querySelector('[data-detail]');
  const error = root.querySelector('[data-error]');
  // All steps are computed locally once; the buttons only choose which one to show.
  const steps = [{ lo: 0, hi: values.length - 1, mid: null, found: false, text: '初始：搜索范围是下标 0–9，尚未比较。' }];
  for (let lo = 0, hi = values.length - 1; lo <= hi;) {
    const mid = Math.floor((lo + hi) / 2), value = values[mid];
    if (value === target) { steps.push({ lo, hi, mid, found: true, text: `比较下标 ${mid} 的 ${value}：等于 ${target}，查找结束。` }); break; }
    if (value < target) {
      steps.push({ lo, hi, mid, found: false, text: `比较下标 ${mid} 的 ${value} < ${target}：目标在右半边，下一步范围 ${mid + 1}–${hi}。` });
      lo = mid + 1;
    } else {
      steps.push({ lo, hi, mid, found: false, text: `比较下标 ${mid} 的 ${value} > ${target}：目标在左半边，下一步范围 ${lo}–${mid - 1}。` });
      hi = mid - 1;
    }
  }
  const last = steps.length - 1;
  let step = 0, pending = 0;
  function render() {
    const s = steps[step];
    cells.forEach((cell, i) => {
      cell.toggleAttribute('data-out', i < s.lo || i > s.hi);
      cell.toggleAttribute('data-mid', i === s.mid);
      cell.toggleAttribute('data-found', s.found && i === s.mid);
      const marks = [i === s.lo && 'L', i === s.mid && 'M', i === s.hi && 'R'].filter(Boolean).join(' ');
      cell.querySelector('.mark').textContent = marks;
    });
    prev.disabled = step === 0; next.disabled = step === last;
    progress.textContent = `第 ${step} / ${last} 步`;
    detail.textContent = s.text;
  }
  function save() {
    if (!api.persistent) return;
    const s = steps[step];
    pending++;
    api.setWidgetState({
      modelContent: { '目标值': target, '当前步骤': `${step} / ${last}`, '搜索范围': `下标 ${s.lo}–${s.hi}`, '本步说明': s.text },
      privateContent: { version: 1, step }
    }).then(() => { error.textContent = ''; })
      .catch(reason => { error.textContent = `未保存：${reason.message || '请重试'}`; })
      .finally(() => { pending--; });
  }
  function restore() {
    if (pending) return; // The ACK echo of an older save must not move the view backwards.
    const saved = api.widgetState?.privateContent;
    step = saved?.version === 1 && Number.isInteger(saved.step) && saved.step >= 0 && saved.step <= last ? saved.step : 0;
    render();
  }
  prev.onclick = () => { if (step > 0) { step--; render(); save(); } };
  next.onclick = () => { if (step < last) { step++; render(); save(); } };
  window.addEventListener('wbw:statechange', restore);
  restore();
})();
</script>
```

## 其他过程的改法

- 排序：每步记录数组快照与正在比较/交换的两个下标；数组超过约 16 项时改用条形图（SVG rect，高度表示值），并在标记里写好初始条形。
- 递推/动态规划：每步记录表格中新填的单元格及其来源单元格，用 `.wbw-table` 语义表格展示，当前格加粗边框并在说明里写出公式代入。
- 推导变形：每步一行等式，只显示到当前步，当前行与上一行的变化在说明里用文字点出；公式用 Unicode 或简单 HTML 上下标书写。
