# 真机文件预览修复与手写能力扩展总体计划

> 状态：**已批准；2026-11-04明确恢复后A–E代码、已知阻断与可运行的本地F门禁已收尾，设备／外部环境验收另列未完成。** undo容量／跨block authority、双TS／ratchet／分层、原生Wry双尺寸和自动保存均有本轮主验；创建已由仓库同事务writer guard接管，统一菜单开放。最新见 [唯一交接](HANDOFF-IMPLEMENTATION.md) 和第17节。第13–16节是历史时点，不从其中恢复旧worker或closure。代码收尾后用户另行要求Android模拟器／实机测试及bug抓取，官方两ABI构建成功、新ARM64包已保留数据安装；真机锁屏使业务复现阻断，资源ID异常尚未关联具体bug。最新设备取证见 [问题第7节](issues/android-import-preview.md#7-2026-11-04新包与实机bug抓取)，新证据在`resume-20261104/android-validation-20261104/`；无Git提交／外部模型调用。原本地门禁证据保留于`resume-20261104/finalization-20261104/`，拟议checkbox不等于最终设备验收完成。
> 继续遵守：子 agent 探索／补测试／修改，主 agent 审查并亲自运行验收；不自动提交、推送、安装新包或调用模型。此前治理／调查记录为已完成的上一阶段，不作为新代码验收。

**目标**：修复 Android 导入后不支持预览的问题，在已有轻量手写模块上完整增加更多颜色和粗细、可调橡皮、圈选入对话、笔迹复制粘贴及独立无限画布。

**架构**：保留 VFS／DSTU、canonical manifest、共享 renderer、不可变图片与现有 Chat 链路。固定分页与自由画布是两种明确模式；只为自由画布引入必要的 v2 格式和分块内容，不重建文件系统或引入新运行时依赖。

**技术栈**：React／TypeScript、Canvas 2D／Pointer Events、IndexedDB、Tauri／Rust、现有 SQLite／content-addressed blobs。

**必读**：[当前架构](design.md)、[真机问题调查](issues/android-import-preview.md)、[使用说明](usage.md)。此前完成的测试和 APK 身份见 [验收基线](acceptance.md)，不据历史结果把新任务标成已验收。

## 1. Context 与本轮结论

### 1.1 新问题

真机已安装包 SHA256 与此前 ARM64 测试 APK 一致。应用启动后资源库确实显示“此文件类型不支持预览”；失败项 MIME 为 `application/octet-stream`，显示名无扩展名，显示大小362.5KB。

已确认直接失败层为前端文件预览分派。源码中存在明确缺口：前端先按 URI 末段扩展名分类，opaque SAF URI 进入普通附件通道后缺少 native 元数据／内容识别，最终可能以无后缀名称及 octet-stream 落库。原始字节及当次导入调用未读取，**该导入原因仍需自建夹具复现，不将推断写成已经证实的完整根因**。

### 1.2 能力扩展现状

- 目前黑／红／蓝3色，笔宽2／8／12；格式本身已允许 hex 颜色和 `0 < width <= 256`。
- 橡皮目前只在 pointerdown 以半径8删除最上方命中对象，不连续拖擦。
- 没有圈选或矢量剪贴板；现有 renderer／render API 已支持固定页裁剪。
- 当前所有坐标、页内容预算、artifact、同步和工具裁剪均有固定页假设。无限画布必须跨层设计，不能只改前端滚动容器或移除边界检查。

## 2. 推荐产品语义

以下推荐默认设计随用户“实施计划”的明确要求整体进入实施；无限画布保持独立空白模式，不更改既有分页资料。

| 能力 | 推荐语义 |
| --- | --- |
| 颜色 | 12个常用预设＋自定义 hex／颜色选择器；笔和荧光笔分别记住最近设置，荧光笔可调不透明度 |
| 笔宽 | 8个快捷值 `1/2/4/6/8/12/18/24`，连续调整 `0.5–64` logical units；底层仍执行原 width<=256 校验 |
| 荧光笔宽 | 快捷值 `4/8/12/18/24/32`，连续调整 `2–64`；不改变旧笔迹样式 |
| 橡皮 | 明确命名“整笔擦”，可调直径 `4/8/16/32/64` logical units，支持连续拖动；命中用户／AI可编辑批注，底图和只读源高亮不可擦 |
| 圈选 | 自由套索选择可编辑对象；矩形选区用于快速圈定内容。操作区域与对象选择分开，即使区域内没有笔迹也能发送底图内容 |
| 选区入对话 | 将选区外接矩形内的底图＋可见批注合成不可变 PNG，加至目标 Chat；不自动发送、不调用模型。套索外接框的预览会明确展示发送范围，不谎称多边形精确抠图 |
| 笔迹复制粘贴 | 保留矢量、样式、层级顺序；支持同页、跨页、跨笔记粘到当前目标页；不复制源背景，不继承 AI 撤销权。跨文档是复制，不是跨库原子剪切 |
| 无限画布 | 新建空白笔记时可选“分页笔记／自由画布”；二维平移缩放、无预设页面边缘，原点可向负方向扩展。PDF／图片／Office批注继续固定分页，不自动转换 |
| 画布输出 | 当前视口／选区输出 PNG 或单框扁平 PDF；导出整个画布使用明确框定的多页区域及顺序，不创建巨型位图 |

不额外承诺像素橡皮／局部切断笔画、OCR、手写字形合成、协作、源PDF页面自由排版或云转换。可调整笔擦满足本轮橡皮尺寸诉求，局部擦若要加入须作为明确的新范围，而不是以透明涂抹破坏原背景。

## 3. 全局约束

1. 不覆盖原始资料，不删除手机数据，不以卸载／重导入作为旧错误条目的修复方案。
2. 沿用当前功能分支；不重建依赖环境、不装Office／Docker，不新增运行时依赖，不改 ignore 或 lint 基线。
3. `.dsink` canonical 内容与派生 metadata 分离，CAS、operation ID、锁序、同步／GC／备份闭包不退化。
4. 新编辑动作先恢复草稿再 CAS；一次手势／一次粘贴只产生一个 undo 单元，不按每个采样点保存。
5. 图片上限仍为单4MiB／长边2048、请求最多4图／总16MiB；编辑器16M像素上限保留。导出继续现有有限像素、文件及取消预算。
6. 模型破坏性写入仍精确一次性审批；复制不克隆 backend receipt／AI authority。AI在画布上操作必须基于不可变 render mapping。
7. 所有 UI 新文案有中英词条、暗／亮主题和移动端可访问交互；使用项目已有组件。
8. 此前真实模型验收仍11次实际请求，不重开20次额度。本轮及默认实施回归不外发模型请求；需要新的真实模型验收时另确认用途和额度。
9. 每阶段主 agent 先观察真实失败，再审阅最小修改并运行相关已有测试；环境OOM／0 tests不算RED，不删失败证据或弱化断言。
10. 本计划未授权 Git commit／push／merge／publish、新APK覆盖安装或个人文件外发。后续需要这些动作时按具体目标确认。

## 4. 代码改动地图与复用点

| 领域 | 当前文件／复用点 | 计划变化 |
| --- | --- | --- |
| URI／导入分流 | `src/features/learning-hub/sidebar/importActions.ts`、`src/utils/fileManager.ts` | 分类前使用 native 解析描述，而不是仅URI字符串 |
| 流式暂存与检测 | `src/utils/stagedUpload.ts`、`src-tauri/crates/dstu-storage/src/{staged_upload,unified_file_manager}.rs` | 复用 open_read_stream／resolve_file_info／magic与ZIP识别，补描述返回和预算测试 |
| 附件创建与节点 | `src-tauri/crates/dstu-vfs/src/dstu/{handlers.rs,handler_utils/node_converters.rs}`、`src/dstu/adapters/attachmentDstuAdapter.ts` | 类型一致性兜底、旧条目重识别；不在预览页盲猜PDF |
| 文件预览 | `src/features/learning-hub/apps/{UnifiedAppPanel.tsx,views/FileContentView.tsx,views/filePreviewResolver.ts}` | 修正元数据后走已有renderer；支持明确重识别／重试，不隐藏unknown |
| 工具栏 | `src/features/ink/{InkEditor,InkToolbar,InkPageView}.tsx` | 数据化画笔预设、尺寸面板、整笔擦手势和选区工具 |
| 几何／输入 | `src/features/ink/{geometry,input,renderer}.ts` | 复用screenToPage／pageToScreen和命中几何，抽离套索／选区，不引入绘图库 |
| 新的小型纯模块 | 拟新增 `src/features/ink/{toolSettings,selection,clipboard,camera}.ts` | 分别管理设置、几何选择、不可信粘贴、视口变换；避免持续膨胀InkEditor |
| 入对话 | `LazyInkEditor.tsx`、`api.ts`、`renderBridge.ts` | 复用 renderInkSnapshot(crop) 与 referenceToChat，不另写截图上传链路 |
| 保存恢复 | `useInkDocument.ts`、`drafts.ts` 与 VFS Ink repo | 固定页保留，画布增加 changed-chunk保存和journal，不整幅画布复制历史 |
| 格式与内容生命周期 | `src/features/ink/types.ts`、`src-tauri/crates/dstu-vfs/src/vfs/ink/`、`repos/ink_*` | v1不变，新增v2 board；chunk依赖参与引用、同步、GC、备份和复制 |
| 工具／artifact | `ink_bridge.rs`、`ink_jobs.rs`、`chat_v2/tools/ink_executor.rs`、前端`ink-tools.ts` | board-aware有限世界裁剪、可信mapping、输出框；保持六工具，不新增重复工具组 |
| 同步 | `src-tauri/crates/dstu-sync/src/data_governance/sync/{ink.rs,mod.rs}` | v2闭包及已有格式协商／缺blob隔离；不假设旧客户端已支持 |

## 5. 阶段A：预览缺陷闭环（最高优先级）

### A1. 自建夹具确认导入原因

- [ ] 准备自己的2页PDF、PNG、DOCX、PPTX、未知二进制和损坏容器；不使用个人资料。
- [ ] 对同一PDF分别通过正常有后缀路径、Downloads provider不透明ID、带编码中文／空格URI导入。
- [ ] 在每个边界记录脱敏结果：provider类别／是否opaque、resolved extension／MIME、实际导入通道、VFS type／previewType；不记录完整URI或正文。
- [ ] 新增自动回归并由主 agent 运行见RED。普通有后缀夹具若也失败，继续排查 type hint、metadata传输、去重和renderer，不能认定SAF假设已成立。

**测试位置**：拟新增 `sidebar/__tests__/importActions.fileInfo.test.ts`；现有 `src/utils/__tests__` 与 stagedUpload测试；Rust storage暂存／统一文件管理测试及VFS真实数据库fixture。

### A2. 统一可靠的导入描述

建议新增的最小接口（名称为拟议，不代表已有）：

```ts
interface ResolvedImportInfo {
  displayName: string;
  extension: string | null;
  mimeType: string;
  kind: 'document' | 'image' | 'media' | 'file';
}
```

- [ ] 在分类前通过 native 获得描述；Android优先可用的DISPLAY_NAME／MIME，generic／缺失时使用现有有界内容检测。显示名与内部安全文件名分开，路径不作为目标写路径。
- [ ] 正常PDF／OOXML继续现有document导入；图片走image；unknown保留file。只把可靠识别结果用于分流，不能把所有octet-stream认作PDF。
- [ ] 普通附件入口复用同一有限识别能力，防其他调用方再次写错类型；保持所有暂存所有权、失败清理、媒体流式和原大小护栏。
- [ ] 检测畸形ZIP／无权限URI／截断数据必须有界失败，不解压整包来猜类型，不多次整文件读入内存。

### A3. 已导入错误条目原位修复

- [ ] 从资源的既有blob受控识别，更新MIME／文件类别／preview派生字段；保留ID、bytes、hash、目录、收藏和引用，不默认改用户名称。
- [ ] 由用户在unsupported页点击重识别／重试触发，不在启动时扫描全库；返回明确的“已识别／仍未知／内容缺失／内容损坏”。
- [ ] 后端事务和事件接现有仓库路径；正确处理去重返回旧错误条目，不能新导入仍指回错误metadata。
- [ ] 真DB断言内容hash及ID不变、重识别幂等、失败无修改、sync镜像一致。

**交付门禁**：自建PDF／图片／DOCX／PPTX在真机导入后实际显示内容；PDF翻页；旧错条目不清数据即可重识别打开；进入手写批注并保存重开。unknown仍明确unsupported，损坏文件不假成功。未完成这些之前不开始用新工具功能掩盖预览缺陷。

## 6. 阶段B：颜色、粗细与连续整笔擦

### B1. 工具设置

- [ ] 用 `toolSettings.ts` 数据表替换黑红蓝／small-medium-large重复union，沿用style.color和style.width，不改v1格式。
- [ ] 预设12色：黑、深灰、白、红、橙、黄、绿、青、蓝、靛、紫、粉；同时支持自定义hex。白色在白纸上保留真实效果，不为了暗主题偷偷变色。
- [ ] 笔／荧光笔各自记住颜色、宽度和透明度；默认仍保持旧黑色及宽度8，避免升级后意外换笔。
- [ ] 桌面弹出面板、手机紧凑底部面板；尺寸有真实预览、数值、选中语义，不能只靠颜色辨认状态。

### B2. 橡皮手势

- [ ] 采用显示直径明确的整笔擦；命中半径=直径/2，尺寸为逻辑单位，光标按zoom映射。
- [ ] pointerdown→move→up/cancel连续采样；用相邻采样线段的扫掠区域命中，快速滑动不能跳过对象。复用／扩展现有几何算法，不仅检查离散点。
- [ ] 一次手势收集全部命中可编辑对象，视觉预览后一次提交；一次undo完整恢复原顺序。背景和源高亮始终只读。
- [ ] 远端revision改变、中途离页、pointercancel按现有草稿与冲突策略结束，不重复删／漏保存。

**回归**：预设和自定义色宽持久化重开；压感／multiply像素不退化；快扫、单击、不同zoom、大小橡皮、底图不擦、undo-redo／强停恢复。新增 `toolSettings.test.ts`／擦除几何测试，扩展 `tests/ct/ink-editor/inkEditor.spec.tsx`。

## 7. 阶段C：圈选、矢量复制粘贴与选区入对话

### C1. 几何选择

- [ ] 新增自由套索和矩形区域状态；均存逻辑坐标，仅为UI transient state，不进manifest。
- [ ] stroke按线段／宽度与多边形相交判定，形状按真实轮廓或填充判定；不能只看stroke首点或包围框，避免误选外接框空白。
- [ ] 选中整个可编辑对象，不切断stroke。底图不成为可编辑对象，但任何有效区域仍可“发到对话”。
- [ ] 翻页、外部revision改变或目标对象删除时失效／重新校验，不能把旧选区对象覆盖回新版本。

### C2. 笔迹剪贴板

- [ ] 复用 `copyTextToClipboard`／`readTextFromClipboard`；只在明确复制或粘贴时访问，不后台监视剪贴板。
- [ ] 结构化payload带format/version、选区原点／边界、按层级排列的对象内容；不包含原文档路径、权限receipt、background hash或个人标题。原作者字段不形成粘贴authority。
- [ ] 输入按不可信文本处理：JSON大小、版本、unknown字段、嵌套／对象数／样本总数、颜色、finite数、时间单调全部校验。先全量验证目标容量和边界，再一次性粘贴；失败零写入。
- [ ] 粘贴到当前页／当前画布：重新生成对象ID和时间，作者为当前用户；保留样式、相对位置和先后顺序。不同页面／文档来源可粘贴，不修改来源。
- [ ] 同页默认偏移16单位；跨页／文档放到可见区域中心。固定页只整体平移到页内，不逐点clamp或静默缩放；选区大于目标页时明确提示改用自由画布，不截掉笔迹。
- [ ] 一次粘贴一个undo／一次journal和CAS；撤销只删除本次新对象，后来无关编辑不被覆盖。手机有显式复制／粘贴按钮，桌面快捷键不抢文本输入框焦点。

系统剪贴板可能被其他应用访问；复制是用户显式操作，UI文案应说明复制的是可编辑笔迹数据。不宣称与其他笔记应用的专有矢量格式互通。

### C3. 选区入对话

- [ ] 扩展 `InkEditor` 对宿主的回调为含 `{documentId,pageId,revision,crop}` 的明确请求，先结束活动手势并flush；save失败不截旧图。
- [ ] 以圈选区域的外接矩形生成有限裁剪，展示范围预览；`renderInkSnapshot`统一合成底图、源高亮和所有可见批注，不只是选中的对象。
- [ ] 复用 `LazyInkEditor` 的 `referenceToChat({sourceType:'image',sourceId:artifact.file_id,...})`；不改为DOM截图或直接base64上传，不自动发送／调用模型。
- [ ] 保存revision／crop／render_id／hash的不可变关系；之后改笔迹不改变历史附件。超预算缩放或明确拒绝，不能加空附件假成功。

**回归**：复杂折线、空选区、只有底图的区域、缩放后坐标、选区像素边界；同页／跨页／跨文档粘贴；恶意JSON／NaN／超限零写入；save失败不入Chat、附件真实像素／hash一致、历史不漂移。新增 `selection.test.ts`／`clipboard.test.ts`，扩展 `LazyInkEditor.actions.test.tsx`、renderer与真实CT。

## 8. 阶段D：无限画布格式与分块持久化

### D1. 模式和兼容

- [ ] 新建空白文档选择paged或board。v1分页文档仍原样读写，不因打开自动升级；board写明确schema v2，保留稳定document_id和一个surface/page_id用于artifact定位。
- [ ] v2仅blank来源，支持空白／横线／方格。拒绝resource来源与board混合；已有PDF／图片／Office的固定背景和页序不变。
- [ ] TS／Rust共同fixture定义v2 discriminated variant；严格unknown fields和unsupported版本错误不放宽成任意JSON。

### D2. 不能用一张8MiB页冒充无限画布

推荐**按对象批次分块，不按几何瓷砖切断笔画**：

- manifest为唯一权威，列出稳定chunk_id、内容hash、对象／sample数、粗包围范围；每个chunk存完整对象，跨空间区域的笔画不复制，不割裂。
- 每个对象具有稳定ID及明确z顺序。renderer可按chunk粗范围筛选后按对象层级合成，包围盒只用于加速，不决定canonical内容。
- 单次编辑只改受影响chunk／新chunk和manifest；撤销使用对象变化，不为每一步复制整幅board。空chunk在同一CAS提交里移除。
- 初始工程预算：manifest仍1MiB；单chunk不超过现有page的8MiB／10000对象／100000samples上限；board总序列化内容64MiB、最多256chunks／100000对象／2000000samples，先到者生效。一次读入的JSON预算16MiB，按需加载并受可见对象预算约束。上述是新模式的推荐硬上限，不提高v1任何限制，实施时用真实内存测量验证，不能只按JSON大小估算JS堆。
- 允许signed世界坐标，所有数有限，初始数值安全范围为±10000000 logical units；接近精度／容量护栏时明确提示，不静默丢笔、截断或无限申请内存。“无限”指无预设纸张边缘，不代表无限资源。
- 单次用户手势若会超预算，在修改前拒绝并保留当前草稿／原文档；跨chunk操作先完整验证后原子发布manifest，不部分粘贴。

### D3. 引用、同步、恢复是同阶段交付

- [ ] VFS依赖枚举、refcount/recount、pin、GC、软删／purge、复制、冲突双方引用、备份与恢复均包含chunk blob；不能只更新编辑器。
- [ ] 锁序保持BlobMutationGuard→SQLite；先写新blob，再CAS发布canonical及引用组，失败不悬挂错误manifest。
- [ ] IndexedDB为board记录受影响对象／chunk和base revision；pagehide、强停重启恢复，remote epoch清陈旧undo，冲突保留双方不覆盖。
- [ ] sync严格验证v2完整pointer tuple和依赖闭包，缺一个chunk时隔离整个文档变更，补齐后才能发布。
- [ ] 复用现有sync format/min_reader/min_writer协商及数据库schema兼容门禁。为新v2写入增加必要的VFS能力迁移，并证明旧客户端拒绝不兼容同步而非丢chunk。旧备份由新客户端读取；新board备份对旧客户端明确不可恢复，不伪装v1。
- [ ] 只有在格式门禁无法明确保护旧客户端时才调整现有sync协议版本；不可仅加一个旧客户端忽略的capability字段就宣称安全。混合版本测试是board启用前的阻断项。

**门禁**：v1bytes／页语义不变；v2合法／恶意fixture；跨chunkCAS失败回滚、幂等、GC和引用重算、缺chunk隔离、真备份恢复、两客户端兼容拒绝、复制新身份。需要SQL迁移时按既有注册和migration-lock追加，不修改旧迁移。

## 9. 阶段E：画布视口、输入与有限输出

### E1. 相机与渲染

- [ ] `camera.ts`集中管理world↔screen变换；render、pointer、eraser、lasso、粘贴均用同一变换，不能再用page width推测scale。
- [ ] Canvas固定为可见窗口尺寸＋受限DPR，只绘制当前world rect及相交对象；保留active overlay、16M像素上限，不按内容范围创建整块位图。
- [ ] 格线以world origin稳定平铺，负坐标和zoom后不跳动。平移／缩放不改笔迹真实坐标。
- [ ] 手写笔书写；touch drawing关闭时手指导航，开启时单指书写／双指导航；两指进入时正确结束／取消笔迹，不产生连接长线。桌面手形／空格拖动、滚轮缩放均围绕锚点。
- [ ] 相机位置作为本机查看状态保存，不因平移触发canonical revision或同步冲突。重开恢复视口，并提供回到内容／原点。
- [ ] 画布复用阶段B/C工具，不发布一个不能擦、不能复制或不能问AI的半套模式。

### E2. Chat／工具／artifact

- [ ] fixed-page继续normalized crop；board render增加显式绝对world rect，必须有限、有正宽高并在数值安全范围内。
- [ ] board apply几何强制绑定based_on_render_id，通过render_crop的0..1映射还原世界坐标；不凭当前UI相机猜位置，不允许没有有限参考框的page-normalized board操作。
- [ ] 一致更新 `ink_bridge`、renderer、geometry/input、export、artifact repo、sync validator、tool schema／executor；负原点只对board开放，不放宽固定页边界。
- [ ] renderer profile纳入新语义版本，render_id含模式／裁剪／revision／profile；旧不可变artifact与历史继续原样有效，不重绘替换。
- [ ] 六工具支持board create/get/render/apply/export；append_page对board明确拒绝，get只返回有界概览／内容范围／chunk摘要，不返回点数组。
- [ ] 新schema必须重新测独立Ink和全量token预算；先复用已有render_crop几何和严格schema，不能靠删校验／提高旧组预算掩盖增长。必要预算变更明示评审。

### E3. 输出

- [ ] PNG／问AI默认当前视口或选区，走不可变有限图像链路和原预算。
- [ ] PDF提供“当前框”及“指定区域分页”；用户先看页面网格与顺序，按左到右／上到下输出，页数不超过现有500页及总输出预算。
- [ ] 不提供暗中缩成不可读缩略图的“整幅无限导出”。内容范围过大时要求缩小区域或分批，拒绝不能兑现的导出。

**门禁**：负坐标、远离原点、zoom锚定、DPR／旋转窗口、快速移动、两指与笔输入、offscreen对象不绘、跨chunk层级正确、内存有界；视口／选区像素、AI mapping、过时render拒绝、PNG／PDF页序比例与取消无残留。

## 10. 阶段F：完整回归与真机验收

### 每阶段

由主 agent 运行新增回归的RED／GREEN和对应已有套件，记录实际命令、退出码、用例数和skipped。子 agent不能以自己的总结替代主 agent验收；阶段失败先闭环再继续依赖阶段。

### 最终源码冻结后

```bash
npm run typecheck
npm run lint
npm run check:lint-ratchet
npm run check:frontend-layers
npm run check:i18n
npm run licenses:check
NODE_OPTIONS=--max-old-space-size=8192 npx --no-install playwright test -c playwright-ct.config.ts tests/ct/ink-editor --workers=1
NODE_OPTIONS=--max-old-space-size=8192 npm run build
```

另跑全部Ink浏览器CT（renderer／source／Office／export）及新增导入CT；完整Vitest按 `npx --no-install vitest run --shard=N/4` 跑四片，不以定向绿替代。

Rust按 `docs/dev/local-testing.md` 和当前workflow执行：

- `cargo test --manifest-path src-tauri/Cargo.toml -p dstu-vfs --lib`，完整storage／sync／Agent／app及ACL／Phase5集成。
- `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets -- -D clippy::correctness`。
- 新迁移static／base-ref不可变性和迁移测试；crate分层、tool token budget、shared fixture、native内容识别测试。

门禁命令在实施前以当前workspace／workflow核对；这不是本轮已运行的测试列表。旧12670／55等数字只属于基线，不作为新功能完成证据。

### 真机矩阵

1. **预览**：自建PDF／PNG／DOCX／PPTX，普通路径与opaque SAF；打开实际内容，PDF翻页，旧错条目原位重识别；unknown／损坏文件诚实失败。
2. **固定页**：不同色宽、拖擦、undo-redo、套索、只含底图选区、同页和跨文档粘贴、保存强停重开、原件不变。
3. **对话**：当前页与选区附件确为不同裁剪的真实PNG；不点发送，修改文档后旧附件hash／像素不漂移。无需收费模型即可验证这一层。
4. **画布**：向四向书写和平移，负坐标、两指缩放、笔／touch模式切换；超过旧单页容量仍正确分块，后台／进程重启恢复；超新预算明确拒绝且原内容不丢。
5. **画布输出**：视口／选区入Chat；区域分页PDF顺序、比例、笔迹；跨chunk复制、undo、sync、备份恢复。
6. **设备体验**：有真实支持的笔才测pressure／掌触；记录设备／WebView／刷新设置和采样方法。没有硬件能力时写未验证，不以ADB swipe替代。

新包必须使用兼容当前测试证书的构建，安装前确认目标、签名及保留数据；不卸载正式应用。构建沿用官方Android mobile-slim配置、16KiB／ABI／签名／体积门禁。API24运行未覆盖时继续明确列出，不因API36通过扩大结论。

## 11. 顺序、完成定义和交付

依赖顺序：**A预览修复 → B工具 → C圈选／复制／入对话 → D格式／存储 → E画布交互和全部输出 → F冻结回归／真机**。B/C纯UI或几何子任务可在独立所有权下准备，但不得跳过A的产品阻断或D的格式门禁。

| 阶段 | 独立可验收成果 | 禁止的半完成状态 |
| --- | --- | --- |
| A | 新导入和旧错条目均可正确识别预览 | 只改提示词／要求用户删数据重导 |
| B | 色宽和拖动整笔擦能保存、撤销、恢复 | 只有工具栏按钮或每点保存 |
| C | 可编辑矢量粘贴和真实选区附件 | 只贴位图、只有对象JSON、无底图上下文 |
| D | v2内容闭包和旧客户端保护完整 | 单页8MiB“无限”、sync漏chunk、备份丢内容 |
| E | 无限视口＋全部工具＋Chat／导出 | 巨型canvas、负坐标只改一层、模型无可信mapping |
| F | 新代码测试和设备验收有新证据 | 拿旧55CT／旧模拟器结论冒充新功能真机通过 |

后续交付更新当前README／usage／acceptance和对应issue，不再创建多份互相竞争的长交接。原始过程材料按 [governance](governance.md) 归档；最终报告保留所测范围与未覆盖项。

## 12. 计划交付时点的冻结结果

**此前已完成**：旧过程材料完整归档并校验；当前文档去冲突；连接真机核对安装包身份和脱敏失败状态；主 agent审阅导入／预览与核心Ink连接代码；形成上述统一计划。

**此前未做**：计划交付时没有修复或新增业务代码，没有为新功能运行测试，没有生成／安装APK，没有调用模型，没有读取个人内容或应用数据库，没有Git暂存／提交／推送。随后用户已要求实施；最新执行结果见下一节，不能用本段否定后来的实际变更。

## 13. 历史实施记录（2026-11-03至11-04，保留发生时点）

本节按发生顺序保留失败、修复和当时状态；其中“正在／待修”等不代表当前仍有后台实现。当前冻结状态以第14节和唯一交接为准。

沿用现有功能分支与工作副本，保留文档治理差异；不新建worktree、不重装依赖、不暂存／提交。原始日志统一保存在本地忽略目录 `docs/archive/handwriting-annotation/2026-11-03-implementation/`，不新增常驻逐agent报告或重复交接。

下表保留compact前的冻结快照；恢复后的新证据见本节末“2026-11-04compact后恢复”，不要把快照当成当前停止指令。

| 阶段 | compact前冻结状态／证据 |
| --- | --- |
| A | **未完成、冻结**。分流19/19、storage337/337、去重2项／MIME派生3项／既有blob3项曾通过；provider→textbooks_add一致性及BMP/control/ZIP审查项未闭合。冻结重识别UI仍缺按钮，真机未复验 |
| B | **部分通过、未验收、冻结**。冻结编辑器CT中原28项与新工具3项通过；设置持久化、紧凑面板／触摸目标／指示光标及新增几何边界仍待闭合 |
| C | **未完成、冻结**。纯模块首轮18/18通过；粘贴合计容量、ID碰撞、footprint审查问题待修。冻结圈选／复制粘贴UI的2项CT仍失败，无真实选区附件交付 |
| D | **未完成、冻结**。域29/29、sync版本predicate3/3通过；repo仍schema1转发／scaffold，6项失败，hook仍loading/noop，8项失败；完整chunk闭包、备份和旧端门禁未完成 |
| E | **未完成、冻结**。相机8/8通过、renderer代码typecheck通过，但无board view/editor/入口；artifact负裁剪RED未闭合，工具／有限输出未接通 |
| F | **未完成、冻结**。最新typecheck通过；前端78通过／9失败；编辑器CT31通过／2失败。全VFS开始698项但按冻结要求停止，无最终汇总；观察到6个scaffold失败。旧基线结果不冒充本轮最终验收 |

### 实施前依赖与冲突核对

| 阶段／接口对 | 核对结果与执行约束 |
| --- | --- |
| A | 新导入识别与旧条目修复均必需；未知／损坏文件不得被猜成PDF。新APK安装未获授权，自动回归不等同真机GREEN |
| B | 只沿用v1样式；预设2／8／12旧快捷语义与新数值设置兼容，手势按一次undo保存 |
| C | 套索对象选择与截图区域分开，复制不继承authority；先flush再生成固定裁剪 |
| D | v1分页不自动升级，v2chunks必须进入所有生命周期闭包；兼容门禁是启用前阻断项 |
| E | 所有board世界映射复用同一有限参考框，固定页边界不放开；不申请巨型Canvas |
| F | 只接受冻结后新证据，旧测试／APK／模型记录不是本次通过证明 |
| A → B/C | 预览修复优先；B/C纯设置／几何可独立准备，不以其完成掩盖A的设备待验 |
| B → C → E | InkEditor／InkPageView／工具栏为共享写入面，按顺序交接，避免并行覆盖 |
| C → D/E | 选区、剪贴板、草稿须接受模式明确的坐标与容量，v1行为不变 |
| D → E | 先定义严格v2格式与存储接口，再实现视口和工具，禁止UI先发布不安全board |
| D/E → F | sync／GC／备份／AI mapping均属于完成门禁，不能以仅前端可画代替 |

### 2026-11-04compact后恢复

- 用户明确要求“继续任务”；58文件冻结SHA256全部匹配，无新增源码差异，HEAD与分支未变、index为空。保持原工作副本，不恢复旧worker，不新增提交／APK／应用模型调用。
- A3 UI重跑确认真实RED：1项失败，unsupported页缺少重识别动作。日志 `resume-20261104/a3-ui-red.log`。
- A2补边界回归后主agent运行7项：4通过／3失败，分别证实BM文本误判、1KiB后控制字节漏检、越界ZIP错误识别ODS；有效BMP正对照通过。最小修复首跑遇offset类型推断编译错误，未执行测试；显式usize修正后完整storage **341/341通过**，独立审查仍在进行。日志 `resume-20261104/a2-detection-red.log`、`a2-storage-green-r1.log`、`a2-storage-green-r2.log`。
- 导入／staging／creator／preview resolver相邻回归 **22/22通过**；既有native重识别DB回归 **3/3通过**。这不覆盖inline附件或真实SAF，后端inline支持仍需补测。日志 `resume-20261104/a-import-adjacent.log`、`a3-vfs-existing.log`。
- A3 UI扩展13项真实组件测试全部RED（缺显式动作），包含busy／结果状态／失败重试／切换资源／ABA／卸载竞态；最小实现后相关3文件 **17/17通过**，typecheck通过。随后审查补测“已识别但仍无法预览”和无回调宿主，17项中15通过／2失败，正在最小修复。日志 `resume-20261104/a3-ui-expanded-red.log`、`a3-ui-green-r1.log`、`a3-ui-review-red.log`、`a3-typecheck.log`。
- A2审查中的OS/2 BMP兼容回归已见8通过／1失败，再补12字节DIB分支后完整storage **343/343通过**，独立复审规格／质量通过。检测只是类型路由，ZIP完整entry名称可在payload落样本外时路由，后续解析器独立校验；控制字节按C0（保留文本空白／formfeed）处理，不宣称完整Unicode控制检测。日志 `resume-20261104/a2-bmp-review-red.log`、`a2-storage-green-r3.log`。
- 真实PDF／图片／Office固化浏览器CT **12/12通过**，不是Android SAF导入／预览证据。日志 `resume-20261104/a-real-source-ct.log`。
- A3后端审查发现并经主agent新DB测试证实：inline小附件错误返回missing、Ink canonical被通用重识别改为JSON。5项中3通过／2失败，开始修复；新增用真实PngEncoder夹具，不再把签名＋IEND叫完整PNG。另有生产去重路径未接verified bytes、resources类型／MIME镜像漏更和SVG被弱文本检测覆盖，尚待逐项闭环。日志 `resume-20261104/a3-inline-ink-red.log`。
- Ruling：`FileContentView` 无 `onNodeReclassified` 的宿主不提供重识别动作——不能保证成功后切换到图像等正确视图；保存／重试继续保留。资源库主路径有回调且不受影响；若其他宿主需要该能力，必须先接完整reroute，不能只塞setNode冒充可预览。
- A3 UI复审两项已修，主agent相关6文件 **41/41通过**，独立复审规格／质量通过；定向eslint为0 errors／4条既有warnings（原有touch尺寸与全局监听），未禁规则或改基线。新增真实宿主＋FileContentView集成 **2/2通过**，证明同tab改选image及仅MIME变化进入DOCX分支，不重新取资源或关tab。日志 `resume-20261104/a3-ui-green-r2.log`、`a-import-ui-lint.log`、`a3-host-routing.log`。
- inline读取／Ink保护最小修复后，主agent原5项全部通过；新增资源MIME镜像和writer已开启时failfast两项真实失败，开始修复。SVG弱XML检测覆盖可靠MIME、PNG内容与错误JPEG MIME不纠正的两项也均真实RED。日志 `resume-20261104/a3-inline-ink-green-review-red.log`、`a3-upload-correction-red.log`。
- provider描述原生窗口测试首跑被冻结代码的sync跨chunk ID借用生命周期编译错误阻断；修为持有String保留校验后，第二次又被Ink bridge/jobs/executor半套board接口的19处编译错误阻断，均未进入断言、不计RED。逐文件SHA256确认无任务范围外并发修改，这些是冻结残留而非新回归；先前口头误判已纠正。日志 `resume-20261104/a2-provider-descriptor-red.log`、`a2-provider-descriptor-red-r2.log`。
- Ruling：暂不为验证A而提前实现整套D/E；从现有resolver原样提取最小纯组装函数，以provider描述及strong检测冲突测试见RED。Wry原生窗口测试保留，不能用纯单测替代最终app编译／设备验收；19处board编译残留仍是最终门禁阻断。
- A3重识别后端7项 **7/7通过**（含inline／Ink拒绝／镜像与锁序）；SVG／PNG纠正2项 **2/2通过**，还在独立复审，未当作全VFS验收。日志 `resume-20261104/a3-reclassify-green-r2.log`、`a3-upload-correction-green-r1.log`。
- provider纯组装3项 **2通过／1失败**，真实确认strong xlsx检测与`sheet.docx`显示后缀冲突；后缀规范和textbooks共享入口已修改，完整storage随后 **348/348通过**（含provider及ZIP新回归）。实际Wry窗口测试仍未执行到断言。日志 `resume-20261104/a2-provider-pure-red.log`、`a2-storage-green-r4.log`。
- ZIP路由ODT／ODP伪装OOXML及普通ZIP目录误判两项已见9通过／2失败后修复；旧50MiB图片上限不提高，弱文本不覆盖具体类型。日志 `resume-20261104/a2-zip-review-red.log`。
- 新损坏结构回归10项中8通过／2失败：签名＋IEND垃圾PNG被recognized是真实RED；inline两case复用相同hash导致UNIQUE约束是夹具装配失败，不计业务RED，独立修夹具。日志 `resume-20261104/a3-png-structure-red.log`。
- 最新TypeScript检查通过；预览views／宿主／导入／staging既有回归 **19文件118/118通过**。i18n默认模式exit0，报告182个存量引用缺键；新重识别词条中英一致，不把默认exit0冒称零缺键。日志 `resume-20261104/a3-typecheck-r2.log`、`a-views-regression.log`、`a-i18n.log`。未进行APK／手机／模型或提交操作。
- verified-bytes生产创建／去重两项真实DB回归均RED：PNG仍沿用octet-stream，开始接通带data的folder API及dstu_create汇合点，保持媒体流式与图片50MiB护栏。日志 `resume-20261104/a3-verified-folder-red.log`。
- Ruling：为解除A原生窗口测试的编译阻断，允许三文件机械兼容修复（bridge/jobs/executor），v1 wire与行为保持、未完成board render/export显式fail-closed；保留原board工作，不把编译修复算成阶段E完成。修改前原始三文件保存在 `resume-20261104/before-compile-fix/`。兼容修复独立审查通过，原生Wry窗口描述测试已实际执行 **1/1通过**；不是Android provider真机验收。日志 `resume-20261104/a2-provider-native-r3.log`。
- PNG有限结构筛查（不做CRC／像素完整解码）后重识别 **10/10通过**；后续新增chunk次数／IHDR尺寸两项和inactive资源一项真实RED，已加65536 chunks／2^31-1规范边界及活跃状态守卫，相关完整仓库套件运行中。日志 `resume-20261104/a3-png-structure-green-r1.log`、`a3-png-budget-red.log`、`a3-file-repo-r3.log`。
- i18n初跑182并非全是存量：新增API错误词条两处遗漏已补，复跑回到既有 **180** 个引用缺键告警（默认exit0），不能弱化为零缺键。日志 `resume-20261104/a-i18n-r2.log`。
- 最新相关套件：完整storage **350/350**；file_repo **24/24**、attachment_repo **23/23**、file_reclassify **2/2**、node_converters **23/23**均通过。不是全VFS或真机通过。日志 `resume-20261104/a2-storage-green-r5.log`、`a-vfs-*-tests.log`。
- 最终定向审查仍发现需闭合的可达入口：verified创建／显式重识别对generic＋SVG名称的弱文本降级、低层verified API元组校验、重复导入blob引用补偿，以及provider数字／bin后缀与opaque名称边界。已由主agent见provider **5通过／3失败**、file_repo **23通过／4失败**，开始最后一批共享纠正规则／tuple／created引用补偿修复；未拿旧GREEN覆盖新场景。日志 `resume-20261104/a2-provider-final-red.log`、`a3-verified-final-red.log`。
- 最新原生回归：描述器真实Wry窗口 **1/1**、Ink bridge **15/15**、Ink jobs准备／导出 **11/11**通过，保留系统portal/FUSE环境告警且退出码均0。日志 `resume-20261104/a-app-*.log`。新批次修复后仍须重跑受影响部分。
- 最后一批A修复：完整storage **353/353通过**，provider三项复审通过；file_repo **27/27**、attachment_repo **23/23**、file_reclassify **2/2通过**，SVG／tuple／created引用补偿／50MiB四项定向复审关闭。附件纠正仍有局部helper副本，记录为低风险重复，不宣称所有helper已完全合并。日志 `resume-20261104/a2-storage-green-r6.log`、`a-final-*-tests.log`。只格式化本轮触及Rust文件；全项目fmt仍有冻结board未格式化内容，尚不算最终门禁通过。
- B工具偏好：先见重开后画笔设置丢失RED（另4项通过），接入已有load/save后原28编辑器＋5工具CT **33/33通过**，独立审查无阻断。localStorage失败不影响IDB／CAS。紧凑桌面／手机面板与eraser cursor新增3项已见 **5通过／3失败**，开始复用Popover／Sheet实现。日志 `resume-20261104/b-preferences-red.log`、`b-preferences-green-r1.log`、`b-panel-cursor-red.log`。
- C粘贴预算／IDs：先见对象／sample／跨module ID三项真实RED，随后仅字节预算仍RED；修正错误常量名后clipboard／selection／geometry／settings **31/31通过**，独立复审通过。目标合计容量在返回候选页前校验，失败不修改原页；byte预算是UTF-8而非JS字符数。日志 `resume-20261104/c-clipboard-capacity-red.log`、`c-clipboard-bytes-red.log`、`c-pure-green-r3.log`（常量名错误仍失败）、`c-pure-green-r4.log`。
- A最新完整app库 **1052/1052通过**，含共享导入描述Wry回归及v1 bridge/jobs；原始日志 `resume-20261104/a-app-full.log`。配合storage353、相关仓库及预览118回归，A自动修复链路已通过；**真机SAF／新包原位修复仍未验收**，没有构建或安装新包授权。
- C几何新增可见footprint三项真实RED（细笔宽0.01下限／pressure taper／大椭圆薄边），10通过／3失败；共享primitive修复后相关 **34/34通过**、typecheck通过，独立几何复审中。C3宿主选区Chat新增2项真实RED、4项原有通过，正接入；工具栏按所有权交接，不并行覆盖。日志 `resume-20261104/c-footprint-red.log`、`c-footprint-green-r1.log`、`bc-typecheck-r1.log`、`c-chat-crop-red.log`。
- B紧凑面板／cursor首跑35通过／1桌面色块目标尺寸失败；修为明确44px后 **36/36编辑器CT通过**（原28＋工具8），typecheck通过。C实现前的B两文件验证快照保存在 `resume-20261104/b-ui-verified/` 供独立审查，不与C进行中代码混审。日志 `resume-20261104/b-panel-cursor-green-r1.log`、`b-panel-cursor-green-r2.log`、`b-panel-typecheck.log`。
- D repo六项真实迁移DB测试复跑先 **0通过／6失败**（v1转发与scaffold），实现create→get→save分块CAS后 **6/6通过**。独立审查发现粗描边／箭头头部bounds漏算、可见范围clamp及跨chunk z重复，正补回归；不开放board入口，生命周期／旧端门禁仍属同阶段阻断。日志 `resume-20261104/d-board-repo-red-r3.log`、`d-board-repo-green-r3.log`。
- C核心UI首轮typecheck、**38/38编辑器CT**、**6/6宿主动作测试**通过；套索、跨页／视口中心、remote epoch和失败路径继续补测，不当作C全部验收。全来源／renderer／export浏览器运行实际65项，63通过／2当时未接selection控件失败（CLI路径匹配包含ink-editor），不能写成全部通过。日志 `resume-20261104/c-ui-typecheck-r1.log`、`c-selection-ui-green-r1.log`、`c-chat-crop-green-r1.log`、`bc-render-prepare-export-ct.log`。
- 极细长椭圆补两反例先见13通过／2失败，改为第一象限有界括根求解后geometry／selection／clipboard **28/28通过**；此前34项GREEN未覆盖该比率，保留RED。日志 `resume-20261104/c-ellipse-ratio-red.log`、`c-ellipse-ratio-green-r1.log`。
- board hook先为scaffold：复跑 **1通过／8失败**；替换load/journal/CAS/event/session并统一现有IDB v2后，初跑8通过／2失败（公开error与session flush）。修正拒绝的async act装配、session flush接真正CAS后 **10/10通过**，typecheck通过。曾为测试引入error ref/getter已撤回，不让框架装配问题污染生产API。缓存容量／对象归属仍继续补测。原9MiB chunk夹具违反单chunk8MiB，改为三块6MiB同样证明16MiB分批，不放宽生产预算。日志 `resume-20261104/d-board-hook-red-r2.log`、`d-board-hook-green-r1.log`、`d-board-hook-green-r2.log`、`d-board-hook-green-r3.log`、`cd-typecheck-r3.log`。
- board包围范围追加粗箭头／压感关闭反例后先见9通过／3失败（含旧连接保护）；修renderer同公式和首次发布同事务guard后仓库 **12/12通过**，两公式定向复审通过。迁移修复连接能力先见pending未回填RED，注册后 **1/1通过**。能力模块原始4项首次verify通过，不冒称它们先见RED。日志 `resume-20261104/d-board-formula-red.log`、`d-board-legacy-writer-red.log`、`d-migration-writer-red.log`、`d-board-guard-formula-green-r1.log`、`d-migration-writer-green-r1.log`、`d-capability-first.log`。
- C追加套索真实bbox／滚动缩放viewport粘贴两项RED后，扩展 **6/6CT通过**；随后空对象复制与touch、clipboard串行、超大几何明确提示三项已见 **6通过／3失败**，正集中修复。日志 `resume-20261104/c-selection-expanded-red.log`、`c-selection-expanded-green-r1.log`、`c-selection-safety-red.log`。
- D sync／真备份board5项：首跑仅测试import编译错误，不计RED；修装配后 **3通过／2真实失败**（board copy丢surface/chunks、缺chunk却backup+restore假成功），完整备份恢复和缺chunk同步隔离／补齐重试通过。随后copy／backup修复已保存但冻结前未复跑。日志 `resume-20261104/d-sync-backup-board-red.log`、`d-sync-backup-board-red-r2.log`。

## 14. 当前冻结状态（2026-11-04，C安全批次收尾）

用户最新要求“当前阶段完成后冻结代码，准备写交接文档，即将compact”。当前C批次已收尾；**业务源码冻结、等待明确恢复，整套A–F仍不可交付**。唯一恢复事实源为 [HANDOFF-IMPLEMENTATION](HANDOFF-IMPLEMENTATION.md)，不从第13节中间的进行时文字自动继续。

### 当前批次的最后验证

- `freeze-typecheck.log`：exit0。
- `freeze-c-unit.log`：8文件 **54/54通过**，exit0。
- `freeze-c-editor-ct.log`：**46/46通过**，exit0。
- 收尾前先见 `c-paste-target-red.log` 错页粘贴真实RED，再绑定点击目标／revision／epoch并原子预检保存；定向复审无当前严重阻断。套索旧用例因Copy现在正确禁用仍click超时，已改assert disabled，保留零写入／bbox／crop断言。
- 该批次不包含boardDocument后来新增的3个未实现负例，也不代表D原生库最新全部通过。

### 阶段边界

| 阶段 | 当前事实 |
| --- | --- |
| A | 自动修复链有storage353、app1052、预览118等当时证据；后续D变更未完整重跑，手机旧包／SAF真机仍待验 |
| B | 偏好、紧凑桌面／手机面板和光标实现，36CT及定向审查通过，后纳入最新46CT |
| C | 当前批次收尾，54单测／46CT／typecheck通过；保留跨文档实例绑定、幽灵undo等非阻断窄边界及真机／性能未测 |
| D | 仓库12、钩子10、capability4、迁移repair1曾通过；新packing/cache/ownership负例未运行／未实现，复制和backup闭包修复已保存但未GREEN，命令和旧端恢复未全部验收；create gate=false |
| E | board view/editor／新建选项／可信world crop／六工具／有限输出未完成，render/export保持fail-closed；renderer CT新文件未运行 |
| F | 最终四片、完整Rust库与全部CI／设备门禁未执行，不用历史GREEN替代 |

### 冻结保全

- 88个非docs变更源码／配置／迁移／测试文件，index=0；HEAD仍 `d48bec383fc478c8567a3f26fa0f424f46fa251f`。
- 清单：本地归档 `resume-20261104/frozen-source-state-20261104-after-c.json`。
- 清单行SHA256：`c91a1afe116fefe7ea557bdc881c1fbf8c8ade42548cd82e7f85bed3c4440264`。
- 原始文件包：`frozen-source-files-20261104-after-c.tar.gz`，88项逐一大小／SHA256核验一致；包SHA256 `d16164764794e39cfdb734c5165a10d94cbe6e23874a97c0e76e616a943c618e`。
- 所有实现停止，无新提交／APK／手机／模型操作。只更新这一份交接，不新增竞争入口；恢复先闭合D已知严重钩子与备份兼容问题，不批量恢复旧worker。

## 15. 第二次compact后恢复（2026-11-04，历史实施记录）

本节保留已发生的RED／GREEN与当时进行中状态，不代表第三次冻结后仍有后台实现。**最新停点与权限以第16节和唯一交接为准。**

- 用户明确要求“继续任务”。主agent核验88文件SHA256、文件集合及4,609,842 bytes全部匹配，清单行摘要仍为`c91a1afe116fefe7ea557bdc881c1fbf8c8ade42548cd82e7f85bed3c4440264`；分支／HEAD不变，index=0。第14节保留为历史冻结，不是本次继续实施的阻断。
- 继续执行第8节已批准D设计。约束仍为原工作副本、不新建worktree、子agent补测／实现、主agent独占运行验收、不提交／APK／模型。原始过程日志仍入同一本地归档，不生成竞争活动ledger。
- D钩子冻结负例主agent首跑 **10通过／3真实失败**：300新对象创建300chunks；移动视口未淘汰clean cache；未载入对象编辑触发全量hydrate而非拒绝。日志`resume-20261104/d2-board-hook-baseline.log`，exit1。
- 保存竞态新增5项确定性回归后 **11通过／7失败**，新增真实RED为跨文档旧队列写新chunk、无echo已提交草稿残留、CAS期间同内容高sequence残留、nonretryable错误未公开且会重发；pending CAS新edit保留为通过护栏。日志`resume-20261104/d2-save-races-red.log`，exit1，开始最小保存修复，不混入packing/cache/ownership。
- Ruling：旧测试中“CAS成功后仍保留草稿”的两处断言与恢复安全契约冲突，改为检查journal先于CAS、未保存pagehide确有草稿、成功CAS后无已提交残留。保留payload／时序／新dirty保护，不删除业务断言；若裁决错误会削弱对未提交草稿的保护，因此新deferred pending-edit回归必须继续通过。
- 已保存生命周期修复主agent复跑 **5/5通过**：board复制／rename／source purge、新身份与refs、完整备份恢复、缺chunk同步隔离补齐、缺chunk备份拒绝及版本predicate。日志`resume-20261104/d2-board-lifecycle-baseline.log`，exit0；不是旧备份兼容或真实旧binary门禁。只读追踪确认旧schema被无差别拒绝且生产slot恢复未经过新增closure校验，正补实际旧v1／无Ink／坏库回归。
- 原生命令现有套件主agent **20/20通过**，含严格request、board create gate仍关闭、get/save revision／预算、v1 typed拒绝与surface事件。日志`resume-20261104/d2-native-command-baseline.log`，exit0；不是应用ACL或完整app验证。
- 保存竞态最小修复后主agent **15通过／3既知失败**（packing/cache/ownership未改），新增5项通过；pending新edit的journal base_revision断言是在修复后追加，不冒称该断言先见RED。日志`resume-20261104/d2-save-races-green-r1.log`，exit1；正在独立规格／质量审查，异步cleanup和session切换仍须闭环。
- 旧备份兼容首跑因4处`&TempDir`传给`&Path`编译失败，未进入业务、不计RED；修tests装配后 **0通过／5真实失败**：旧v1／无Ink误拒、schema0 board绕过、缺required column假成功、Ink证据存在但NULL canonical pointer被略过。日志`resume-20261104/d2-backup-compat-red{,-r2}.log`，开始共享闭包最小修复，不放宽合法board的schema／guard要求。
- writer guard补测主agent见 **storage 4通过／2真实失败、board repo 12通过／2真实失败**：autocommit安装失败留下3个trigger；trusted_schema=OFF无法调用纯capability UDF；marker=1但缺trigger未补装；save未安装缺失guard。日志`resume-20261104/d2-guard-{storage,board}-red.log`；开始原子安装与实际trigger补装修复，不把保护夸大为防恶意DDL。
- 真实IndexedDB升级／阻塞CT首跑load时duplicate identifier、0 tests，是测试装配问题而非业务RED；修为component单独import后主agent **1通过／1真实失败**：v1→v2原库原pages保留通过，blocked reject后迟到success泄漏连接导致delete-blocked。日志`resume-20261104/d2-idb-browser-red{,-r2}.log`。开始最小opener清理，不新增第二DB。
- 原生修复首轮主agent **storage capability 6/6、board repo 14/14、旧备份兼容5/5、原board lifecycle5/5通过**，日志`resume-20261104/d2-{guard-storage,guard-board,backup-compat,board-lifecycle}-green-r1.log`，各exit0。独立审查仍在进行；production slot恢复及incoming sync仍未接gate，不把小套件通过当D完成。
- 保存复审新增5个deferred负例全部实际失败，最新 **15通过／8失败**（另3为packing/cache/ownership）；旧session未保存切换丢draft、cleanup await丢新edit且假saved、同revision跨doc load污染、remote refetch期间新edit被清、旧unmounted CAS删新session草稿。日志`resume-20261104/d2-save-review-red.log`，exit1。继续以独立document-session状态、所有await校验及有界草稿清理修复，不把初轮generation补丁标完成；真正跨窗口的IDB写入单调保护另需真实事务证据。
- 当前TS检查`resume-20261104/d2-save-typecheck.log` exit0，只对应运行时源码；后续保存修复／tests仍须复跑。
- 大画布复制新增真实迁移DB夹具：3个合法chunk、每chunk约6MB文本、总量超过16MiB且不超过64MiB。主agent **0通过／1真实失败**，copy返回`ink.limit_exceeded`读取批预算错误，日志`resume-20261104/d2-copy-batch-red.log`。改为逐chunk读写后仓库 **11/11通过**（`d2-copy-batch-green-r1.log`），保持原8MiB／16MiB／64MiB预算不提高；后续copy guard追加项另有RED。
- 独立session状态修复初跑24项中23项load失败，主agent读码定位为`source.kind`判别式写到顶层的重构笔误；修正后 **21通过／3既知失败**（packing/cache/ownership）。复审原5项在hook级闭合，跨window仍需IDB owner事务；storage-read错误测试为修复后补测，不冒称先见RED。日志`d2-save-review-green-r2.log`／`d2-save-review-green-r3.log`。复审亦要求去掉render阶段对已提交session的active原地修改，接owner／floor后重验。
- 真实IDB opener最小修复后 **2/2浏览器CT通过**（`d2-idb-browser-green-r1.log`）；后补单调写／删除水位两项 **2通过／2真实失败**（`d2-journal-sequence-red.log`）。正在同一store的readwrite事务内保留tombstone／sequence floor；忽略stale写但返回成功不能满足journal-before-CAS，因此继续补明确拒绝、相等序列内容冲突和owner fencing，不把序列比较一项当跨窗口完整通过。
- 完整backup较早 **49/49通过**（`d2-backup-full-r1.log`）；production实际slot末端`finalize_vfs_index_restore`缺chunk负例 **0通过／1失败**（`d2-slot-closure-red.log`），接入共享只读校验且不被Lance早退绕过后该项通过。随后真实board删除files整表但保留guard/history的负例被主agent完整套件见证 **51通过／1失败**（`d2-slot-backup-full-green-r2.log`），修为有guard或已知VFS迁移证据即拒损坏，空schema0对照继续允许；最新完整结果另记，不复用49项旧绿。
- guard复审追加三项主agent均见真实RED：capability floor被降（storage6通过／1失败）、同名空body触发器未修（board14通过／1失败）、copy／exactretry未补guard（copy11通过／1失败）。提取storage唯一probe后 **capability7/7、board15/15、copy12/12通过**，日志`d2-guard-{floor,body}-green-r2.log`／`d2-copy-guard-green-r2.log`；真实table／operation／body和不可降floor集中校验，backup已改共用probe，替换后仍须重验。保护仍为DML防旧端，不是DDL沙箱。
- production恢复／损坏闭包修复最新完整backup **52/52通过**（`d2-slot-backup-full-green-r3.log`）；之后共用guard probe替换尚待完整重验，不把52旧绿冒充之后源码。
- 草稿明确拒绝与owner追加真实浏览器 **2通过／4真实失败**（`d2-journal-owner-red.log`）：stale／等seq不同内容被静默成功、old owner可用高seq覆盖新owner。正在同一IDB store事务内接原子claim、owner比对、typed拒绝和tombstone floor，并同步hook；不是用JS Map假装跨窗口互斥。
- 同步首次board门禁首跑在canonical读取被`resources.hash`装配错误阻断，未到guard断言；修为真实source资源行后主agent **0通过／1真实失败**：成功apply后trigger=0而非9（`d2-incoming-guard-red-r2.log`）。正在closure验证后、canonical发布同事务安装guard，缺chunk隔离不得装，v1不得装。
- 原子IDB owner／sequence实现后主agent真实浏览器 **10/10通过**（`d2-journal-owner-green-r1.log`），含4项后补claim／discard顺序正例；这些后补项不冒称先见RED。hook接线后主agent **27通过／4失败**（`d2-hook-claim-gesture-red.log`）：原3项及新手势resolve前未持久化草稿真实RED，owner／floor／StrictMode／新owner阻旧CAS的回归通过；正接每gesture journal和planner/cache。
- 草稿损坏追加13CT首跑因Rust隔离`XDG_CACHE_HOME`导致找不到已有Chromium，未进入断言、不计RED，不安装或清缓存；只修运行环境后 **11通过／2真实失败**（`d2-journal-corrupt-red-r2.log`）：envelope内外ID／owner不一致claim误写其他key、非finite输入／存储被误当equal重试。正在最小拒绝损坏并保原记录；并发seq3/4最高序列正例通过。
- 分块纯规划器首次6/6通过（新module的业务动因为旧hook已见RED，不冒称pure先RED），主审发现每gesture仍分新chunk及world仅control校验；追加回归后 **6通过／3真实失败**（`d2-chunk-reuse-bounds-red.log`）。正在复用loaded余量chunk及共享精确pressure／arrow可见bounds，防257个手势再次撞256chunks。
- 原生全库当时主agent **storage361/361、VFS736/736、sync561/561通过**（`d2-{storage,vfs,sync}-full.log`）；分别对应运行时源码，不替代之后guard floor事务加固或最终F。sync包含首次board保护GREEN，普通GC近链在SQLite writer/refcount重算内受保护；远端target lease不是本地blob锁，跨进程新增删除路径仍需另核，不夸大为全进程安全证明。
- hook手势journal／planner／32MiB cache接通后主agent **42通过／1真实失败**（hook32项31通过、planner11/11，`d2-gesture-cache-pending-red.log`）：save在journal await后才捕获chunk版本，期间新编辑被旧CAS清dirty。record与versions已改为第一次await前的同一同步快照；随后先被新回归的`records`变量未声明装配问题挡住，修为`memory.records`后相关断言通过，没有弱化预算。原箭头负例使用粗culling误报，不计真实业务RED；已换成真实head越界，修复后正例／精确footprint当前通过。
- Ink全单测后续主agent **113通过／2真实失败**（`d2-frontend-ink-unit-r2.log`）：两个新视口负例确认迟到A覆盖新B、换区时旧clean缓存与新fetch同时驻留。正加latest请求序列及prefetch clean淘汰／分批实际bytes预算；32MiB为编码内容驻留预算，不宣称JS堆硬上限。
- 当前typecheck复跑通过（`d2-frontend-typecheck-r2.log`）；前一次失败为tombstone owner的TS窄化错误已修，不能冒称未失败。定向lint exit0。全Ink浏览器首轮被renderer harness mixed import装配阻断、0 tests；拆component独立import后 **90通过／1真实失败**（`d2-frontend-ink-browser-r2.log`），原13个IDB损坏／owner用例全部通过，新增cycle／70层草稿仍错误类型或被接受，正修有界遍历。套件命令匹配包含ink-editor／export／source，不将90项当90个board用例。
- 完整app主agent **1052/1052通过**（`d2-app-full.log`，199.08s）；ACL **4/4通过**（`d2-command-acl.log`）；最新capability **7/7通过**（`d2-storage-floor-final.log`）；迁移static exit0（`d2-migration-static-final.log`）。这些是当前D批次证据，不替代最终F／真机，也不授权APK／模型／提交。
- 保存／视口本批次收口：`d2-accepted-typecheck.log`、`d2-accepted-lint.log` exit0；13文件 **119/119单测通过**（`d2-accepted-unit.log`），全Ink相关浏览器 **91/91通过**（`d2-accepted-browser.log`）。有界视口scheduler为1 active＋1 latest pending，替换pending会settle；计数测试曾漏扣初始dirty-load基线，修夹具后通过，不把该错误当并发业务RED。latest取数期间编辑的假成功已见 **35通过／1失败**（`d2-load-edit-red.log`）后改为明确reject，保draft并允许手动retry，纳入119通过。32MiB是编码内容驻留预算，不是JS堆上限；整体D混合旧客户端真实证据／最终F仍未完成。
- E准备：新增board删除／undo／redo接口回归 **0通过／5真实失败**（`e-board-history-red.log`，缺方法）后实现，初轮history7＋原hook36 **43/43通过**；复审补未发布删空草稿残留／首次CAS期间删除漏提交／视口取回已删块，主agent **42通过／3真实失败**（`e-board-history-review-red.log`），修后 **45/45通过**（`e-board-history-review-green-r2.log`）。再补CAS失败分支 **9通过／1失败**（`e-board-history-failure-red.log`），保守改为带删除intent的unknown冲突草稿，已保存待复验，不能重放已擦的旧payload或假成功。
- 有限board冻结输入／请求准备首次 **18/18通过**（`e-board-frozen-first.log`），不是RED→GREEN或PNG成功。原生shared request selector负例 **21通过／1真实失败**（`e-board-dispatch-red.log`，仍要求paged inputs），board分支已接、signed crop由真实冻结输入发布；之后app编译被export测试`expect_err`要求Debug阻断，未进入业务，不为测试给生产derive Debug，已改match待复跑。
- 真实editorless board图像桥接先 **2通过／3真实失败**（`e-board-render-bridge-red.log`），共享board renderer有限裁剪接线后首轮 **7通过／2像素探针装配失败**：`Locator.evaluate`第一个参数为element，修传参后 **9/9通过**（`e-board-render-bridge-green-r2.log`）。复审又补duplicate-z／unknown字段和lined只横线像素负例，尚待主agent跑，9绿不代表这些新边界已完成。
- board全局z概览先 **0通过／3真实失败**（`e-board-overview-red.log`，typed scaffold），实现逐块8MiB扫描／max_z_index精确decimal string、IPC同read transaction及ACL后主agent **3通过／1失败**（`e-board-overview-green-r1.log`，missing physical blob仅返回Io而非typedNotFound），该边界已修待复验；相关原生命令 **21/21通过**（`e-board-commands-green-r1.log`）。不以loaded max或时间戳猜全局层级。
- 真实DSTU根入口CT先 **1通过／2真实失败**（`e-board-root-red.log`，board误入分页），独立board host／有限视口／camera／overview接线后首轮TDZ声明顺序错误已修；新根入口 **3/3通过**（`e-board-ui-green-r2.log`），覆盖负世界笔迹journal→CAS→重开、v1不升级、touch-off导航不改revision。AskAI／export宿主尚未接，按钮disabled；扩展擦除／选择粘贴仍待实测，不冒称E完整交付。
- board仓库AI操作／可信撤销4回归主agent **11通过／3真实失败**（`e-board-operations-red.log`，pages映射假设），schema2 whole-chunk apply/undo、signed render_crop和receipt z实现后 **14/14通过**（`e-board-operations-green-r1.log`）。app可信receipt的z持久化／审批链与六工具schema仍未接，不能由repo通过推导Chat工具完成。
- 删除历史CAS失败分支保守冲突修复后主agent **46/46通过**（`e-board-history-failure-green-r3.log`）；不确定server是否已提交时保留本地删除intent而非重放旧changed。真实PNG桥接9/9之后新增duplicate-z／unknown fields／lined横线像素负例待跑；创建gate保持false。
- 显式区域导出首轮被测试`expect_err`需Debug装配阻断；改match后主agent **0通过／4真实失败**（`e-board-export-red.log`，region request／grid／缺region typedreject），开始logicalworld tiles、one-frame PNG／≤500页row-major PDF完整链。不允许无region回退surface.bounds或暗中全幅缩略。
- 六工具前端严格schema新增3场景主agent **7通过／3真实失败**（`e-board-tool-schema-red.log`，mode／board_crop／export.board），生产schema正在接入；原预算不得自动提升。Rust工具get／create gate／append／operationstatus新增4项待主验，未外发模型。
- board宿主AskAI动作新增 **0通过／1真实失败**（`e-board-ask-actions-red.log`，disabled），finish→flush→post-CAS overview精确revision/crop真实PNG→image ContextRef已保存待主复验。扩展root eraser／vectorcopy/paste主agent **5/5 CT通过**（`e-board-ui-expanded-first.log`）；不是所有touch／硬件或Chat端到端已通过。Export未接保持disabled。
- Rust工具新增回归主agent **1通过／3真实失败**（`e-board-tool-executor-red.log`）；实现get／render／mode参数后工具套件 **24/24通过**（`e-board-native-current-tools.log`），其中board apply暂时typed `UNSUPPORTED`，不会跳过PREPARED。overview typedmissing修复后 **4/4通过**（`e-board-overview-green-r2.log`）；导出签名E0061编译阻断已收口，原生bridge **22/22**、完整ink_jobs **15/15通过**（`e-board-native-current-{bridge,export}.log`）。真正WebView emit与native PNG落盘端到端仍待验。
- schema功能通过后预算实测12637chars≈3160超过3000（`e-board-current-unit.log`，139通过／1失败），仅精简重复描述、不删校验／工具／参数、不提高cap后，严格schema＋权威token-budget **17/17通过**（`e-board-schema-budget-green-r1.log`）。
- 渲染复审补duplicate-z／unknown字段与lined横线纸，主agent **8通过／2真实失败**（`e-board-render-validation-red.log`）后修严格keys／global z／raw bytes计费与lined只横线；连同真实board区域PNG／PDF **12/12通过**（`e-board-render-validation-green-r3.log`）。追加冻结客户端模式边界 **0通过／3真实失败**（`e-board-frozen-client-red.log`）后独立board helper与旧paged响应guard **3/3通过**（`e-board-frozen-client-green-r1.log`）。
- Ruling：board `remove_object` 沿用v1精确对象ID＋一次性破坏审批，不额外要求render；update的render crop是新几何位置映射，不是旧对象的可编辑范围——避免擅自缩减已批准能力。若未来要求视觉可见区域授权，应另设显式范围契约，不能悄悄改变现有删除权限。
- repo操作复审追加AI批次必须复用chunk余量／undo z被后来人占用typed冲突，主agent **14通过／2真实失败**（`e-board-operations-review-red.log`）；修后这两项纳入 **16通过／2失败**（`e-board-preview-red.log`），剩2项是新增只读preview scaffold真实RED。board app apply曾有不安全的commit后才写回执提案，主agent明确否决，已移除并保持fail-closed；正接公开只读preview后复用原PREPARED→VFS→COMMITTED，禁止降级。
- artifact正原点crop对称校验追加 **6通过／1真实失败**（`e-board-artifact-positive-red.log`），正原点超过世界范围被接受；按canonical board身份而非crop符号统一revision／surface／world证明后 **7/7通过**（`e-board-artifact-positive-green-r1.log`），v1／legacy非负裁剪兼容保留。
- 公开只读board预览实装后repo操作套件 **18/18通过**（`e-board-preview-green-r2.log`）：PREPARED所需稳定object_changes／z／input_hash与真实commit一致且预览零写。app三项真实ChatDB故障／撤销z持久化测试已准备，board apply保持UNSUPPORTED直到主agent见RED并接回同一双库协议。
- UI导出与交互修复：跨来源剪贴板用当前视口中心、OS cancel结束已采样手势而pinch主动取消、camera单入口clamp、house dialog显式region／row-major grid≤500、finish→flush→postrevision独立产物打开。导出动作与冻结输入单测 **7/7通过**（`e-board-ui-actions-green-r2.log`）；root9CT先8通过／1 Portal作用域夹具定位失败，改为page dialog定位、不改production后，board UI＋真实PNG／PDF／取消合跑 **12/12通过**（`e-board-ui-export-green-r4.log`）。typecheck曾因冻结helper annotation revision unknown窄化错误exit2，该局部修已保存、后续统一复验，不抹失败。
- UI复审负例与导出入口主agent **5通过／4真实失败**（`e-board-ui-review-red.log`）：外部剪贴板不居中、OS cancel丢手势、缩放按钮绕camera clamp、缺有限导出dialog；导出动作单测 **1通过／3失败**（`e-board-export-actions-red.log`）。已授权按真实失败最小修复，未宣称整套E完成。

## 16. 第三次冻结（2026-11-04，本轮结束后准备压缩）

用户最新要求：“本轮结束后准备冻结文件，写交接文档，准备压缩”。已结束本轮已启动验收，所有业务源码／测试写入和后台测试停止；**当前不可交付，等待用户明确恢复**。第15节中的进行时文字仅历史，不能从旧closure计划恢复已结束任务。

### 16.1 最新实际结果与保留阻断

- board工具套件 **27/27通过**（`e-board-prepared-green-r1.log`），含真实ChatDB／VFS故障、PREPARED→commit→COMMITTED、commit后receipt失败恢复和z undo。独立可信撤销 **6/6通过**（`e-board-trusted-undo-green-r1.log`）。
- board导出安全 **18/18通过**（`e-board-export-security-green-r3.log`）：invalid/cancel消耗stage、不同region同op冲突、crop/chunk漂移零产物。drift负例初次被重复z夹具阻断，修独立z后通过，不把装配错算业务RED。
- 全局z overview **4/4通过**、原生命令 **21/21通过**（各较早日志），strict schema＋权威预算 **17/17通过**（`e-board-schema-budget-green-r1.log`）。
- board root UI9＋真实区域导出3 **12/12 CT通过**（`e-board-ui-export-green-r4.log`），模式菜单＋创建路由 **6/6通过**（`e-board-create-menu-green-r1.log`），创建两个flag仍false。
- 正确crate的统一create facade关闭测试 **1/1通过**（`e-board-create-gate-green-r2.log`）；此前误在app filter得到0 tests不计通过。
- operation repo新增undo容量负例 **18通过／1真实失败**（`e-board-undo-cap-red.log`）：恢复对象不复用chunk余量，256块时计划第257块。**未修**。
- 最后静态复审Important：第一次失败／取消的block留PREPARED，用新block重试成功后authority仍链接失败旧block，而undo要求SUCCESS，可能没有可用撤销入口。现27项测试同ctx重试未覆盖；**未补测／未修**，恢复先做真实跨block故障回归。
- 原生真实WebView E2E首轮E0432未编译（`e-native-render-e2e-first.log`）；测试导入已单点修为深路径，冻结前未复跑。隔离测试页面`build:ink-e2e`构建exit0，但不能当真实emit／PNG／落库通过。
- 真实旧源码重建探针 **6/6门禁通过**（`legacy-client-gate-r2.log`，exit0）；1442旧src-tauri文件与Git对象逐项一致，另4份同提交registry资源。不是旧APK／真实云／完整Tauri租约并发验证。

### 16.2 F静态门禁有失败

| 门禁 | 最新结果 |
| --- | --- |
| `f-typecheck.log` | tsc exit0 |
| `f-typecheck-native.log` | **tsgo exit1**，`background.ts:49` Uint8Array<ArrayBufferLike>不能作BlobPart |
| `f-lint.log` | exit0，4626 warnings／0 errors |
| `f-lint-ratchet.log` | **exit1**，Ink新增2 coarse触控／2裸事件监听／11 hooks依赖告警 |
| `f-frontend-layers.log` | **exit1**，resourceCreators跨feature deep import Ink api，须经index |
| license／i18n／crate layers／migration static | 各exit0；i18n仍180存量t()引用缺键；25 crates；136迁移 |

完整四片Vitest、最终全部Rust库／nextest／fmt／clippy／build／startup／Phase5及完整迁移fixture门禁未闭合。没有新APK／手机操作／应用模型调用／Git暂存或提交；旧历史模型额度不重新授权。

### 16.3 冻结保全

- 分支`feat/handwriting-annotation-chat`，HEAD`d48bec383fc478c8567a3f26fa0f424f46fa251f`，index=0。
- **136个非docs源码／配置／迁移／测试文件，5,685,790 bytes**。
- 权威清单：本地归档`resume-20261104/frozen-source-state-20261104-after-e.json`。
- 清单行SHA256：`28691ee4676592cbdf8288976a5142e7729ed497584a55f72b0826b0d6804f8a`。
- 保全包`frozen-source-files-20261104-after-e.tar.gz`，136项大小／SHA逐一核验；包SHA256`d75a04b66d27b886647b27a171193d36afa4d553abd699253ae3d9858f4538c5`。
- 本次更新前README／handoff／roadmap原文保存于同归档；旧88／58清单仍仅历史，不能用于当前现场。
- 所有实现已停止，已启动验收均结束；冻结后只做文档／hash／index／链接／进程核验，不再写业务或开新测试。

### 16.4 恢复顺序

以 [唯一交接](HANDOFF-IMPLEMENTATION.md) 为准：核136文件→undo容量已有RED→跨失败block重试undo回归→tsgo／ratchet／layers→原生Wry E2E→创建门禁复核→最终F。以上为第三次冻结时顺序，后续已获明确恢复，见第17节；不从本段重新执行已完成步骤。

## 17. 第三次冻结后明确恢复与最终验收（2026-11-04）

用户要求“继续完成任务”。136文件逐项SHA／集合／保全包、分支／HEAD和空index均匹配后继续；不恢复历史closure，不提交／安装APK或调用应用外部模型。

### 17.1 已闭环实现

- undo恢复对象复用whole-object first-fit，不创建无意义第257块；真实容量RED后operation repo19/19通过，保原z、后来人类对象与预算。
- PREPARED失败block换message／block／call精确重试：同Chat事务迁移唯一authority，源receipt精确CAS、目标绑定、全session同op唯一性；旧ERROR终态不改，不复制authority。主验跨block／promotion／回滚／stale／fresh竞争均通过，启用创建后工具33/33。
- 双TS的BlobPart推断、house event registry／稳定hook依赖、44px触控token、跨feature Ink index惰性出口修复后tsc／tsgo、lint／ratchet／layers均通过，不改基线。
- board轻量lazy entry与canonical模式路由闭环。草稿普通瞬时失败后允许同owner／新sequence继续持久化，成功仅offline；overview失败可显式重试。宿主收笔／粘贴／擦除／历史动作后1000ms合并canonical CAS，不盲重放错误；同远端epoch的本地save保已有z授权，不丢下一笔。
- 原生Wry E2E实际执行：修测试run_return避免跳过尾部断言，使用compile-time TAURI_CONFIG独立overlay核effective config与内嵌资产；真实请求→共享renderer→暂存PNG→checked artifact。board long_edge请求和render_id均纳有效尺寸，same crop 200/400两产物像素／hash／源不变／invalid-stale不增产物全部通过。
- 统一创建facade不再靠临时关闭常量，repo在发布首个board同savepoint核capability／future floor并安装9触发器；旧连接DML拒绝、future floor零写/不降级、幂等实测。原生命令23/23、菜单／创建路由7/7、工具33/33通过。
- immutable artifact只INSERT同步，UPDATE／DELETE永久拒绝。全量schema覆盖暴露精确分类遗漏后修exact操作声明，不改旧迁移或表分类；schema覆盖完整11/11通过。

### 17.2 本轮验收与正在收尾

| 门禁 | 主agent实际结果／边界 |
| --- | --- |
| 最终前端四片r5 | **12831 passed／4 skipped／5 todo**；1619文件通过／1skip，四片exit0且各自source_unchanged=true |
| 双TS／lint／ratchet／layers／license／i18n | 全exit0；4611存量warnings／0errors／0新增，180存量i18n引用缺键仍默认告警 |
| 完整Ink CT | **108/108通过**；含自动journal→canonical CAS，不冒称Android真机 |
| 原生Wry双尺寸 | r4 exit0，真实像素/hash/source不变、两产物及错误请求零额外产物 |
| 构建契约／迁移tooling | 151/151、14/14；迁移static/base d48 136项通过 |
| Rust归档八片首轮 | 8193pass／2fail；两个immutable artifact分类失败修后完整schema覆盖11/11绿；不把旧归档称最终新源码全绿 |
| 独立同步性能 | 10000条真实断言通过，15.263s，未放宽30s阈值 |
| 最终完整app／storage／sync／VFS | **1079／361／562／752全通过**、0失败／0ignored，验证期间源码不变；包含最后创建启用、分类与future-floor typed映射 |
| 旧d48实际源码 | 主agent核1442原blob一致并重建：7安全gate＋3解析／codec observations符合预期；非旧APK／真实provider／raw-delta完整restore证明 |
| 最后原生门禁 | 最终app1079／storage361／sync562／VFS752全绿；schema覆盖11／production迁移52（min50）／Phase5两case／workspace all-targets Clippy correctness／fmt／migration static全通过，每门禁source不变；私有fixture明确skip |

生产前端build与built graph startup通过。总JS gzip约10705.8KiB超过8560.6KiB当前warn-only阈值，保留告警、不提高基线；入口等关键chunk均在预算内。套件有交叉，数字不得简单相加。

### 17.3 设备、环境与权限边界

- 本轮没有Git暂存／提交／push、APK构建／安装、外部应用模型调用；旧三commit／模型11次／旧APK验收均不重做。
- 手机旧包尚未含导入修复；SAF自建文件／旧错条目原位修复与压力／掌触／延迟／内存需新包真机复验，不能由CT或Wry替代。
- Docker CLI存在但daemon权限不足，不提权／改组绕过；Windows需对应runner，私有代表性迁移fixture未擅自下载。各自单列未覆盖，不假通过。
- 旧端compatibility围栏不是恶意DDL沙箱；raw delta模块当前无生产caller，codec观察不冒完整restore；最大board在低端硬件的堆／延迟未实测。

