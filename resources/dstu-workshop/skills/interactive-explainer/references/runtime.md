# 浏览器教学组件运行时

宿主在片段脚本前注入 `window.__wbw` 或 `window.openchamber`，用 `const api = window.__wbw ?? window.openchamber` 取得当前桥。每个片段使用唯一根 ID，查询和自定义 CSS 限定到根；不访问 parent 的数据。宿主仅允许内联脚本，不能 eval、加载外部资源或请求网络。

以下状态、主题事件、图片和题卡协议描述原 __wbw 宿主；OpenChamber 仅在实际暴露同名能力时使用，先检查方法是否存在，不虚构兼容 API。只有 `submit(data, summary)` 的 OpenChamber 等待页面须在真实点击时调用 submit，不能将其当作 setWidgetState、sendPrompt 或正式题卡 submitAnswer。不支持状态保存时只保留本地界面，不声称已持久化；主题/尺寸可用 CSS 变量及 ResizeObserver 重绘，不依赖未提供的事件。事件名按宿主实际协议使用，不自行假设 openchamber:* 事件。

图片优先用内联 SVG/CSS 绘制，不编造 Base64。已有材料图片目录返回的引用可写成 `<img data-wbw-image="#source-image/材料ID/图片key" alt="图片说明">`（不要设置 src/srcset），每个作品最多 6 张。宿主只解析原始源码里声明的引用，读取本机原图后提供给沙箱；没有请求图片、任意文件或网址的运行时 API。单图最多 2 MiB、合计 8 MiB；过大时先裁图。外链原图需先导入本机。缺图显示占位，不影响其他控件。CSS 不使用外链 url()/@import，字体使用系统字体；Chart.js 通过 libs 声明。预检失败时按工具诊断修改再提交，不让用户用重试预览修复源码。

## 状态 API

```js
const api = window.__wbw ?? window.openchamber;
const saved = api.widgetState; // null 或 { modelContent, privateContent }
// 两部分均为 JSON 值或 null；省略即 null，每次替换整个快照。
if (api.persistent) {
  await api.setWidgetState({
    modelContent: { coefficient: 2, step: 1 },
    privateContent: { detailsOpen: false }
  });
}
```

- api.persistent 表示此组件绑定了已保存消息、可以在当前设备保存交互状态，不代表每次写入一定成功。catch 错误并显示在操作旁；没有持久化能力时不声称保存成功。
- 只接受 JSON：有限数字、字符串、布尔值、数组、普通对象或 null。不要存 undefined、函数、Date、DOM、循环引用。嵌套最多 16 层，UTF-8 序列化后总计最多 16 KiB。
- 在 change、步骤切换等有意义的操作结束后保存。input/拖动期间只重绘，不逐帧保存；也不要在 load 或状态恢复事件里保存。
- 宿主完成 IndexedDB 事务后才确认写入。刷新、列表重新挂载、同一组件的独立预览可以恢复快照；更换源码则旧快照失效。
- 快照只保存在当前浏览器的本机 IndexedDB 独立表，不写聊天消息、不进入云同步，不自动发送模型或触发新一轮生成；刷新可恢复，但不跨设备。两部分均不要存秘密。
- 点击后先立即更新画面，再异步保存，不等待保存确认才切换。保存回执只确认本机事务，运行时不会用较早的保存回声覆盖尚未保存完的新操作；首次打开或空闲时另一同源窗口的更新仍可恢复。

```js
function restore() {
  const candidate = api.widgetState?.modelContent?.coefficient;
  coefficient = typeof candidate === 'number' && candidate >= -3 && candidate <= 3 ? candidate : 1;
  render();
}
restore();
window.addEventListener('wbw:statechange', restore);
window.addEventListener('wbw:themechange', render);
```

主题变化不重载 iframe。颜色、强调色、宿主字号、字体和圆角通过真实所在表面的令牌同步；独立预览保留原表面的样式。CSS 变量会自动更新；canvas/Chart.js 需在 wbw:themechange 中重新读取颜色和字号后重绘，无需自己向 parent 发消息。

## 用户主动追问

```js
button.onclick = () => {
  api.sendPrompt('请解释当前参数下的变化').catch((error) => {
    status.textContent = error.message;
  });
};
```

- 必须从真实点击或键盘动作调用；不能从定时器、加载或调参回调调用。
- API 等待此前排队的状态保存，然后打开宿主确认框。确认框以易读的“当前情况”列出 modelContent，原始数据可按需展开；用户可修改问题或取消。取消不请求模型。
- 确认后只附带这份 modelContent，并标记为不可信数据；宿主不附带 privateContent、HTML 或内联库。
- Promise 成功表示追问已交给聊天入口，不表示模型已经完成回答。生成中、失效或只读入口会拒绝。
- 静态追问按钮也可直接写 `<button type="button" data-wbw-prompt="解释当前情况">解释当前情况</button>`，同样需要宿主确认。不同时为同一按钮绑定两种追问方式。

宿主没有通用工具调用、读文件或业务写入 API；不要虚构这些能力。

## 正文位置

show_widget 的成功回执包含 `wbw-widget` 围栏，围栏内是宿主给出的引用 ID，不是 HTML。把完整引用原样放在相关文字之间。每次调用保存独立画面、独立快照；后图不覆盖前图。引用只能展示当前消息自身的载荷，不能读取其他消息。旧消息或遗漏引用的载荷在正文末尾兼容显示，不依赖模型完美输出才能保住图形。

HTML 作品不强制标题，可以省略 title，宿主不会补默认作品标题；确需标题时可传 `title="作品短标题"`（建议 2~12 字，组装时仅首个 append 传入），画面内不重复。无论有无标题，完整校验并保存后都直接隔离渲染，不套源码代码卡、不要求用户再点预览。普通 html 代码示例仍默认展示源码、手动预览；有标题、脚本或按钮都不自动成为作品。

ask_user 与正式题卡的 `presentation`（answerInput、submitAnswer、answerFeedback）见 `host-question.md`；普通交互件不需要读取。

## 生成中的渐进显示

工具参数还在生成时，宿主把已到达的片段放进**不执行脚本**的隔离预览：保留 style、SVG 与语义结构，去掉 script、事件属性和外链，控件不可操作。参数完整并通过校验后，同一位置换成可交互作品，沿用预览高度。

- 顺序写：`<style>` → 结构与静态首帧 → 唯一的 `<script>` 放最后。不要把样式写在脚本后，也不要用脚本生成全部 DOM。
- 首帧用标记写出：必要控件及默认值、`<output>` 默认读数、带 viewBox/width/height 的 svg 或 canvas（给出与最终一致的尺寸）、坐标轴和图例。标题按需，不强制添加。脚本接管后重绘同一元素，避免高度跳动。
- 数据驱动的大量图元可由脚本生成，但预留区域的尺寸要在标记里确定。

## 外观、布局与样式类

- 优先用原生 button/input/select 及 .wbw-controls、.wbw-field、.wbw-field-header、.wbw-value、.wbw-primary、.wbw-muted、.wbw-small、.wbw-stage、.wbw-grid，不重复实现按钮、滑块、焦点或键盘行为。
- 颜色只用 --wbw-foreground、--wbw-muted、--wbw-border、--wbw-surface、--wbw-accent、--wbw-series-1/2/3/4；SVG 可用 currentColor。canvas/Chart.js 先解析 CSS 变量为颜色，并在 wbw:themechange 重绘。字体、字号和圆角由宿主令牌同步，不写第二套调色板；正文用默认字号，次要标注 .wbw-small，字重只用 400/500。单系列只用 series-1，多系列同时用线型或直接标签区分。
- 透明外层，支持 320px 宽；控件换行，图形按实际容器重绘。以本轮回答内容区宽高比组织画面，主图高度参考 --wbw-available-height；SVG 给 viewBox 保持比例，窄屏减少刻度而不缩字，复杂图拆分或重排。不要用固定大宽度、内层滚动或裁切代替响应式排版。
- api.display（桥来自 window.__wbw 或 window.openchamber，若宿主提供）提供 {width,height}（height 是宿主给主图的可用高度，不是 iframe 高度）。监听宿主支持的 wbw:displaychange 或 ResizeObserver 重排；Canvas 适配 devicePixelRatio。不用 100vh 撑高自动测高的 iframe。
- 图、控件与整个讲解透明无框，不包带底色/阴影的卡片；绘图区只给必要的细中性边界。刻度、单位和重要数值必须可见，y 轴至少留 64px；取值范围来自数据和参考值并留余量。
- 只提供题意需要的控件，当前值放在标签旁；不自动加重置、筛选、总结卡或设计调参面板（练习揭晓后的「重新练习」除外）。
- 控件用可见 label，按钮写清动作，图形给 aria-label/title/desc。动态结果 aria-live="polite"，错误 role="alert"；重要操作不依赖 hover。
- 选项用 fieldset/legend + label.wbw-choice 内的原生 radio/checkbox，外层 .wbw-options 或 .wbw-segmented。对比表用 `<div class="wbw-table" tabindex="0" role="region" aria-label="…">` 包语义 table，数值 .wbw-num。状态 `.wbw-badge` 配 data-tone="success|warning|error" 且必须有文字；错误 .wbw-error 配 role="alert"，字段用 aria-invalid 与 aria-describedby。
- 图例：`<div class="wbw-legend"><span><i class="wbw-swatch" aria-hidden="true"></i>方案 A（实线）</span><span><i class="wbw-swatch" style="--series-color:var(--wbw-series-2);border-top-style:dashed" aria-hidden="true"></i>方案 B（虚线）</span></div>`，图上线型须与图例一致，不单靠红绿区分。

## 动效

- 不自动播放、不循环。需要观察随时间变化时提供「播放/暂停」与「单步/拖动时间」，由用户启动，播完停在终态。
- `matchMedia('(prefers-reduced-motion: reduce)')` 为真时，播放直接跳到终态或按单步推进，不做连续动画。
- 用 requestAnimationFrame 和真实经过时间推进，不用 setInterval；页面隐藏（visibilitychange）或交互件滚出视口（IntersectionObserver）时暂停。
- 播放中只重绘，不逐帧保存；暂停、结束或调参完成后再 setWidgetState。
- 单步只更新同一个画面，不堆叠全部步骤；不加装饰性过渡。可运行例子见 `simulation.md`。
