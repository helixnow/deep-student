# 生成式可视化练习

用本技能 + `show_widget(format="html", code=...)` 生成适合题意的画面与操作，不为每种版式扩展客户端组件或服务器成绩模型。以下是可运行起点，不是所有题型必须遵守的固定模板；可换成拖拽、填空、连线、分步推导等。

## 先分清三条路径

| 用途 | 提交与结果 | 重做与保存 |
| --- | --- | --- |
| 普通 show_widget 教学练习 | HTML 的点击处理器本地核对；清楚标注 AI 参考。主观题只对照参考，缺答案不判对错。不要调用没有绑定的 submitAnswer，也不写正式成绩/错题本 | 原组件「重新练习」清本轮 UI；widgetState/setWidgetState 保存当前状态。重做不请求模型 |
| 正式题库 quiz 的 presentation | setAnswerDraft/submitAnswer 请求宿主提交，answerFeedback + wbw:feedbackchange 展示宿主结果；不得自行伪造 authoritative | 只有宿主支持新尝试时才能重做；不能擦掉本地反馈冒充正式重提成功。现有宿主历史语义不由生成 HTML 改写 |
| ask_user 的 presentation | 回答原问题，交还等待中的工具；不是考试 | 不加正确答案、判分或练习动作 |

## 必须具备的体验

1. 作答阶段不显示答案、解析或暗示正确选项的颜色；不要把答案写在组件外正文提前揭晓。源码中有参考答案并不是考试保密机制。
2. 用户明确提交/完成后，在原组件自动展开参考对错（或主观/待核验状态）、参考答案和解析，不再要求点击「看答案」，不弹阻断模态。结果以文字表达，不只用红绿。
3. 揭晓后显示「重新练习」；清本轮选择/草稿/反馈/参考分数/计时并恢复控件，不重新请求模型。无需强加历史存储；若用户要上次记录，可在 16 KiB 内保存简短记录，不抹掉正式学习数据。
4. `api.widgetState` 可能为空、旧版或非法，校验版本和字段范围后恢复。`wbw:statechange`、首次加载和主题变化只恢复/重绘，绝不反向保存。完成选择、提交与重练才保存，尤其要保存重练后的空白状态。
5. 保存中禁重复提交/重练或串行化操作；失败显示「未保存」及可用重试，保留本轮界面，避免旧请求迟到后把已清空的新轮次改回旧反馈。未绑定持久消息时仅本次页面有效，不声称已保存。保存成功的具体范围由当前宿主决定，不宣称跨设备一致。
6. 用宿主主题变量、原生有 label 的输入、.wbw-controls/.wbw-options/.wbw-choice 等样式。透明无框、适配 320px、控件可换行、结果 aria-live；仅必要 SVG 使用 viewBox，不用固定宽度或 100vh。

## 可运行示例：读图后提交与原地重练

无需 libs。把下列完整片段作为 `show_widget` 的 `code`，保留工具回执引用。此例的单题参考分数仅在揭晓时派生，不进入任何正式成绩或错题记录；计时只累计本页面打开期间到最近一次明确操作，不冒充严谨考试时长。初次加载和恢复不会写状态。

```html
<section id="curve-practice" aria-label="读图参考练习">
  <p class="wbw-muted">AI 参考练习，非正式判分</p>
  <svg viewBox="0 0 300 160" role="img" aria-label="曲线 y 等于 x 的平方，横轴 x，纵轴 y；请根据曲线求值" style="width:100%;max-height:180px">
    <title>y = x²</title>
    <path d="M36 12V132H284" fill="none" stroke="var(--wbw-border)"/>
    <path d="M36 132 Q146 132 256 12" fill="none" stroke="var(--wbw-series-1)" stroke-width="2"/>
    <g fill="currentColor"><text x="12" y="20">y</text><text x="280" y="154">x</text><text x="20" y="152">0</text><text x="132" y="152">1</text><text x="246" y="152">2</text><text x="64" y="28">y = x²</text></g>
  </svg>
  <fieldset class="wbw-options"><legend>当 x = 2 时，y 等于多少？</legend>
    <label class="wbw-choice"><input type="radio" name="curve-value" value="0">2</label>
    <label class="wbw-choice"><input type="radio" name="curve-value" value="1">4</label>
    <label class="wbw-choice"><input type="radio" name="curve-value" value="2">8</label>
  </fieldset>
  <div class="wbw-controls"><button type="button" class="wbw-primary" data-submit>提交答案</button><button type="button" data-restart hidden>重新练习</button></div>
  <div data-feedback hidden aria-live="polite" role="status">
    <p><strong data-result></strong></p>
    <p>参考答案：4</p><p>解析：把 x = 2 代入 y = x²，得到 y = 2 × 2 = 4。</p>
    <p class="wbw-muted" data-score></p>
  </div>
  <p class="wbw-muted wbw-small" data-save role="status" aria-live="polite"></p>
  <p class="wbw-error" data-error role="alert"></p><button type="button" data-retry hidden>重试保存</button>
</section>
<script>
(() => {
  const root = document.getElementById('curve-practice'), api = window.__wbw ?? window.openchamber;
  const inputs = [...root.querySelectorAll('input')];
  const submit = root.querySelector('[data-submit]'), restart = root.querySelector('[data-restart]');
  const feedback = root.querySelector('[data-feedback]'), retry = root.querySelector('[data-retry]');
  const error = root.querySelector('[data-error]'), save = root.querySelector('[data-save]');
  const labels = ['2', '4', '8'];
  let state, started, saving = false, dirty = false;
  function fresh() { return { version: 1, choice: null, phase: 'answering', elapsedMs: 0 }; }
  function restore() {
    // An ACK echo must not replace an in-flight or failed local operation.
    if (saving || dirty) return;
    const s = api.widgetState?.privateContent;
    state = s?.version === 1 && (s.choice === null || Number.isInteger(s.choice) && s.choice >= 0 && s.choice < 3)
      && ['answering', 'revealed'].includes(s.phase) && (s.phase !== 'revealed' || s.choice !== null)
      && Number.isFinite(s.elapsedMs) && s.elapsedMs >= 0 && s.elapsedMs <= 86400000
      ? { version: 1, choice: s.choice, phase: s.phase, elapsedMs: s.elapsedMs } : fresh();
    started = performance.now(); render();
  }
  function clock() {
    if (state.phase === 'answering') state.elapsedMs = Math.min(86400000, state.elapsedMs + performance.now() - started);
    started = performance.now();
  }
  function render() {
    const revealed = state.phase === 'revealed';
    inputs.forEach((input, i) => { input.checked = state.choice === i; input.disabled = revealed || saving; });
    submit.hidden = revealed; submit.disabled = saving || state.choice === null;
    restart.hidden = !revealed; restart.disabled = saving;
    feedback.hidden = !revealed;
    root.querySelector('[data-result]').textContent = revealed ? state.choice === 1 ? '参考核对：答对了（AI 参考）' : '参考核对：再想一想（AI 参考）' : '';
    root.querySelector('[data-score]').textContent = revealed ? `本题参考核对：${state.choice === 1 ? 1 : 0}/1 · 本轮约 ${Math.round(state.elapsedMs / 1000)} 秒（非正式成绩）` : '';
    retry.hidden = !dirty || saving || !api.persistent;
    save.textContent = saving ? '正在保存本轮状态…' : !api.persistent ? '仅本次页面有效，未绑定持久消息。' : dirty ? '本轮状态未保存，刷新会恢复上次成功保存的状态。' : '';
  }
  async function persist() {
    if (saving) return;
    if (!api.persistent) { dirty = false; render(); return; }
    saving = true; dirty = true; error.textContent = ''; render();
    try {
      await api.setWidgetState({
        modelContent: { '练习': 'y = x²（AI 参考）', '阶段': state.phase === 'revealed' ? '已揭晓' : '作答中', '我的选择': state.choice === null ? '未选择' : labels[state.choice] },
        privateContent: { ...state }
      });
      dirty = false;
    } catch (reason) { error.textContent = `保存失败：${reason.message || '请重试'}`; }
    finally { saving = false; render(); }
  }
  inputs.forEach((input, i) => { input.onchange = () => {
    if (saving || state.phase !== 'answering') return;
    clock(); state.choice = i; render(); void persist();
  }; });
  submit.onclick = () => {
    if (saving || state.phase !== 'answering' || state.choice === null) return;
    clock(); state.phase = 'revealed'; render(); void persist();
  };
  restart.onclick = () => {
    if (saving || state.phase !== 'revealed') return;
    state = fresh(); started = performance.now(); error.textContent = ''; render(); void persist();
  };
  retry.onclick = () => { if (!saving && dirty) void persist(); };
  restore(); window.addEventListener('wbw:statechange', restore);
})();
</script>
```

正式题卡的 HTML 展示反馈时，读取 `api.answerFeedback` 并监听 `wbw:feedbackchange`；参考答案和解释用 textContent，不执行反馈中的 HTML。不把上面的本地参考核对改成伪造宿主消息。普通 ask_user 的路线/偏好选择与正式题卡协议见 `host-question.md`。
