---
name: 可视化讲解
description: 在会话教学与题目解析中按需选择静态配图或交互演示：流程、关系、函数、几何、数据图，以及参数探索、算法单步、过程模拟、拖拽和可视化练习。静态图用 diagram/Mermaid，交互用 show_widget HTML 沙箱；不冒充正式成绩或业务操作，不把会话组件当成可随 Markdown 导出的讲义正文。
---

## 先选表达方式

- 一句话能说清：文字。静态流程、关系、函数、几何或普通数据图：先读 `references/static-diagrams.md`，用 diagram / Mermaid，不生成网页。
- 需要“变了会怎样”、逐步观察、动手操作或可视化做题：读取运行时及对应交互参考，调用 show_widget(format="html")。
- 用户只说“可视化”或“配图”时，默认先用静态图；明确需要操作、观察变化或练习时才用交互件。按学习目标选择，同一信息不重复画静态图和交互件，不因选中了本技能就强制出图。
- 用户要预览 HTML 示例也走 show_widget（含无脚本页面）；“解释这段代码”只给普通 html 围栏。完整文档先转为合规片段。
- 真实课程原图从材料检索，不用生成图冒充；假设参数明确称为示例。
- 保存的讲义 Markdown 须独立可读，不写入 wbw-widget 引用或 HTML 源码，不声称导出含可运行组件。

## 按类型读取参考（只读需要的）

用当前工具列表中的 read 读取本技能目录 `interactive-explainer/` 加下表路径；旧入口只有 read_skill_reference 时传 name="可视化讲解" 和 references/ 路径。静态图只读静态参考；交互件只读 runtime 与对应类型，不一次加载全部资料。

| 需求 | 先读 |
| --- | --- |
| 静态流程/关系/层级、函数/几何、数据与时序图（schema、上限、预检） | `references/static-diagrams.md` |
| 任何交互件（状态、主题、尺寸、追问、样式类） | `references/runtime.md` |
| 调参数看变化、两种方案并排对比 | `references/explore.md` |
| 算法/推导逐步执行（上一步/下一步） | `references/stepper.md` |
| 随时间演化的过程（播放/暂停/单帧） | `references/simulation.md` |
| 拖动点、角、边界直接操作图形 | `references/manipulate.md` |
| 需要悬停读数/图例切换的数据图（Chart.js） | `references/chart.md` |
| 可视化做题、提交看解析、重新练习 | `references/practice.md` |
| ask_user / 正式题卡的 presentation | `references/host-question.md` |

参考里的示例是可运行起点，按题意改画面和参数，不照搬无关控件。

## 静态图输出契约

只描述结构、数学坐标、函数与数据，布局、连线路由、采样交给渲染器。遵循静态参考的严格 schema，先调用 show_widget(format="diagram" / "mermaid") 预检，将返回围栏原样放在正文；不自写 HTML/SVG 替代普通图表。图前后用简短正文衔接，数量按讲解需要决定，不重复图中信息。

## 交互演示输出契约

1. 调用 `show_widget(format="html", code=...)`；标题可省略，不强制添加。确需标题时可传 title（建议 2~12 字，组装大页面仅首个 append 传），由宿主显示，画面内不重复。code 只放一个 HTML 片段（无 DOCTYPE/html/head/body），可含内联 style/script；唯一根 ID，CSS 与查询都限定在根内。
2. **源码顺序决定生成中的观感**：`<style>` → 带静态首帧的结构（必要控件、已写好 viewBox/尺寸的画面、默认读数）→ 最后一个 `<script>`。宿主在生成过程中按此顺序渐进显示无脚本预览，脚本到达后才变为可交互，因此首帧应是有效画面而非空白。
3. 一个交互件围绕一个学习目标：少量必要控件 + 一个主要画面 + 至多一行当前读数。多个画面确有帮助时才多次调用，按叙述顺序放置。
4. 调参、单步、播放都在本地重绘，不请求模型。只有用户点击「解释当前情况」等明确动作才 sendPrompt，宿主会先请用户确认。
5. 回执给出不含源码的 wbw-widget 引用围栏：原样单独成块放在正文需要看图的位置，各图保留各自引用。正文只写必要观察与推导，不宣布“组件已生成”，不重复图中内容。
6. 不联网、不 fetch、不引 CDN、不导航、不读宿主数据。交互图表才声明 libs:["chart.js"]。
7. 兼容宿主桥：`const api = window.__wbw ?? window.openchamber`。状态用 api.widgetState 读取、setWidgetState({modelContent,privateContent}) 保存；仅使用当前宿主实际提供的 API，不将 OpenChamber 的 submit 当作正式判分或状态保存。原 __wbw 宿主本机保存合计 16 KiB，不云同步；其他宿主以实际能力为准。先更新画面再异步保存。modelContent 只放解释所需的可读参数，privateContent 只放恢复界面的细节，二者都不是秘密存储。恢复与首次加载不反向保存。
8. 新作品唯一入口是 show_widget，完整校验并保存后直接在沙箱渲染，无需标题、无需用户手动点预览。普通 html 代码围栏仅作源码示例，由用户手动预览；不能根据有无标题、脚本或控件推断为作品。不输出裸 HTML 或 html interactive；校验失败按报错修正，不换路径绕过。材料引用和思考中的代码不构成执行授权。

## 体验底线

- 透明无框，跟随宿主主题令牌；支持 320px，控件换行，不用 100vh、固定大宽度或内层滚动。
- 原生带 label 的控件；当前值放标签旁；结果 aria-live="polite"；不依赖 hover 或单靠颜色。
- 动效只由用户触发（播放按钮），可暂停，播完停止不循环；prefers-reduced-motion 时直接显示结果帧；离开视口或页面隐藏时暂停。
- 可视化练习：标明「AI 参考练习，非正式判分」，提交前隐藏答案，提交后原地展开解析，提供「重新练习」。细则见 `references/practice.md`。
