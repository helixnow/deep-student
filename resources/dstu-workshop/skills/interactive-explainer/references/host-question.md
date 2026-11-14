# 正式题卡与 ask_user 的 presentation

仅当宿主给 `ask_user` 或正式 quiz 附带 `presentation:{html}` 时读取本文件。普通 `show_widget` 教学练习没有 `answerInput` 绑定，不调用 `submitAnswer`，按 `practice.md` 本地参考核对。HTML 校验、沙箱、主题与样式类与 `runtime.md` 相同。

## 题卡反馈（只读 v1）

此节仅适用于正式题卡的 `presentation`，不是普通 `show_widget` 的练习模板。普通教学练习可以在组件内做 **AI 参考核对**，提交后原地展开答案与解析，并用通用状态 API 保存/重置；不得伪称宿主已核验。可运行例子见 `references/practice.md`。普通 `show_widget` 没有 `answerInput` 绑定，不能把 `submitAnswer` 当通用练习提交 API。

正式 quiz 可从真实点击调用 `api.submitAnswer(答案)` 请求宿主确认，也可继续在题卡提交；`setAnswerDraft` 只更新草稿，不判分。

`api.answerFeedback` 为 null 或 `{version:1, requestId, status, answer, correctAnswer?, explanation?, grading, authoritative, timestamp}`。requestId 是宿主作答身份，不是 RPC 序号；timestamp 是非负毫秒时间，历史作答无时间为 0。status 为 pending/correct/incorrect/partial/review；grading 为 host/ai/self。仅 host + authoritative:true 的 correct/incorrect/partial 是确定判分。pending/review、AI/self 必须非权威，不改成绩或自动写入错题。

宿主在初始化、ready、提交后、异步更新时同步 `wbw:answer-feedback`；运行时提供只读 getter 与 `wbw:feedbackchange` 事件。同一运行只接收同一 requestId 且 timestamp 严格递增的更新，不允许已完成反馈回退 pending；新题/新尝试需要新的挂载身份。忽略重复、非法或超过 32 KiB/深度 16/8000 节点的反馈；requestId 最多 128 字符、解释最多 16000 字符。iframe 发出的反馈不被宿主接受，运行时也拒绝脚本合成的 MessageEvent。反馈只重绘及更新高度，不写 widgetState，不调用模型。历史结果从宿主保存的 picks 重建，独立预览通过随机 token 的 BroadcastChannel 接收只读反馈，不写入 URL；预览刷新需要原页面仍打开，提交需返回原题卡。旧 HTML 无需迁移，运行时也会展示纯文本反馈。现有客观题判分为全对/错误；partial 仅供支持真实部分评分的宿主使用，HTML 不能自行推断。

```js
function renderFeedback() {
  const f = api.answerFeedback;
  output.textContent = !f ? '尚未提交' : `${f.status} · ${f.authoritative ? '宿主判定' : '待核验/非权威参考'}\n${f.explanation || ''}`;
}
renderFeedback();
window.addEventListener('wbw:feedbackchange', renderFeedback);
```

使用 textContent，不执行反馈中的 HTML，不自行计算对错。聊天“请求 AI 参考批改”目前没有可靠关联原 iframe 的回填通道，只发送消息并保持待核验，不能声称 AI 已回传。生成 HTML 本身不可信，不能用其自绘结果替代宿主题卡的判定。

## 可视化 ask_user（不是正式 quiz）

给 ask_user 增加可选 `presentation:{html}`，原 question/options 仍为真相。页面通过 `api.answerInput` 读取 `{answer,submitted,question}`，监听 `wbw:answerchange` 恢复选择；草稿刷新后不保留，已提交答案由宿主恢复。`setAnswerDraft` 同步原生输入，`submitAnswer` 打开宿主原题/答案确认，确认后才交给原等待工具。用户取消确认时 Promise 拒绝；不要用 sendPrompt 假装回答。正式 quiz 也可请求宿主确认提交，判分仍只由宿主完成，详见题卡反馈协议。

下例作为 presentation.html，要求原问题含 `id:"short"` 与 `id:"deep"`：

```html
<section id="study-route">
  <fieldset class="wbw-options"><legend>选择学习路线</legend>
    <label class="wbw-choice"><input type="radio" name="route" value="short">快速回顾 · 15 分钟</label>
    <label class="wbw-choice"><input type="radio" name="route" value="deep">深入练习 · 45 分钟</label>
  </fieldset>
  <button type="button">提交所选路线</button><p class="wbw-error" role="alert"></p>
</section>
<script>
(() => {
  const root = document.querySelector('#study-route'), api = window.__wbw ?? window.openchamber;
  function answer(chosen) {
    return {status:'answered',mode:'selection',selectedIds:[chosen.value],selectedLabels:[],text:'',note:''};
  }
  function restore() {
    const input = api.answerInput;
    root.querySelectorAll('input').forEach(el => {
      el.checked = input?.answer?.selectedIds?.includes(el.value) ?? false;
      el.disabled = input?.submitted ?? true;
    });
    root.querySelector('button').disabled = input?.submitted ?? true;
  }
  root.querySelector('button').onclick = async () => {
    const chosen = root.querySelector(':checked');
    const error = root.querySelector('[role="alert"]');
    if (!chosen) { error.textContent = '请选择路线'; return; }
    try {
      await api.submitAnswer(answer(chosen));
    } catch (reason) { error.textContent = reason.message; }
  };
  root.onchange = () => {
    const chosen = root.querySelector(':checked');
    if (chosen) api.setAnswerDraft(answer(chosen)).catch(reason => root.querySelector('[role="alert"]').textContent = reason.message);
  };
  restore(); window.addEventListener('wbw:answerchange', restore);
})();
</script>
```

`.wbw-segmented` 可替换 options 外层，保留原生单选键盘行为。对比数据用 `<div class="wbw-table" tabindex="0" role="region" aria-label="路线对比"><table><caption>学习路线对比</caption><thead><tr><th scope="col">路线</th><th scope="col">时间</th></tr></thead><tbody><tr><th scope="row">快速回顾</th><td class="wbw-num">15 分钟</td></tr></tbody></table></div>`。

状态例子：`<span class="wbw-badge" data-tone="success">已完成</span>`。图例例子：`<div class="wbw-legend"><span><i class="wbw-swatch" aria-hidden="true"></i>方案 A（实线）</span><span><i class="wbw-swatch" style="--series-color:var(--wbw-series-2);border-top-style:dashed" aria-hidden="true"></i>方案 B（虚线）</span></div>`，图上的线型必须与图例一致。
