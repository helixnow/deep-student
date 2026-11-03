# DeepStudent 手写笔记、文件批注与 Chat 工具集成方案

- 日期：2026-11-02
- 状态：设计提案，待评审；本文不是已实现能力清单，也不授权开始功能实现。
- 本地调研基线：`6c73530d`。
- 参考项目：XNotes Android `3926304a0a2ca20b0ac259317b5e60f77d4668b1`，v0.9.7，MIT。
- 交付边界：本轮只新增方案文档，不安装依赖、不修改业务代码、不提交 Git。

> 归档说明：上方状态与交付边界保留上一轮设计历史原文。本轮用户已批准 `implementation-plan.md`，并于供应商切换后明确恢复实施；固定分页、Office 本地预览固化、AI 文本/形状和扁平 PDF 边界随计划获批。当前实现与测试状态只看 `progress.md` / `acceptance.md`，不将下方拟议能力当成已实现。

## 1. 目标与结论

新增一个类似享做笔记基础能力的轻量模块，支持两类操作：

1. 新建空白的分页画布，手写记录笔记。
2. 打开现有资料，在 PDF 或图片页面上手写、圈画和批注；其他文档先转为固定页面。

整套能力必须接入应用内 Chat：用户可把当前页或选区交给 AI 识别；AI 也能通过受控工具创建笔记、准备待批注文档、查看页面、添加批注、导出结果并提供打开入口。

**推荐架构：一个共享手写编辑核心 + 现有 VFS/DSTU + 非破坏性批注层 + 合成页图 + 现有 Chat/模型链路。**

不移植 XNotes 整套 Android 应用，不引入第二套文件系统、数据库服务、笔记本管理系统或通用插件平台。可接受为现有 VFS 增加必要的格式处理、版本检查和引用生命周期逻辑；“复用文件系统”不等于仅改前端。

## 2. 范围、默认值与非目标

### 2.1 首期交付范围

| 范围 | 具体能力 |
| --- | --- |
| 空白笔记 | 新建、增加空白页、改名、保存、重开；默认 A4 比例白纸，可选横线/方格背景 |
| 文件批注 | PDF/图片直接进入；其他格式经支持的转换器生成固定页图后进入 |
| 基本编辑 | 压感笔、荧光笔、整笔橡皮、颜色/笔宽、撤销/重做、缩放/平移 |
| AI 批注 | 文本框、矩形/椭圆圈画、箭头、区域高亮；不要求 AI 生成逼真的人类手写字形 |
| 保存 | 自动保存、版本冲突检测、未保存草稿恢复；保留可编辑笔迹 |
| 输出 | 当前页/选区 PNG，选定页面的扁平化 PDF；导出不覆盖原文件 |
| Chat | 当前页/选区引用、工具创建/读取/编辑/导出、可打开的结果卡片 |
| 模型识别 | AI 获得原页面与批注合成后的真实图像，而非仅原文文本、资源 ID 或笔迹坐标 |

### 2.2 默认设计决策

- 使用固定分页，不以无限画布为首期目标。
- 文档转换默认本地完成，优先沿用现有预览效果生成页图；不默认引入云转换或 LibreOffice。
- Office 预览效果不承诺与原生 Office 排版完全一致；转换后展示预览并冻结版面。该质量边界尚未经用户单独确认，应在评审时明确接受或调整。
- 用户看到“手写笔记/批注文档”，底层仍使用现有 `file` 资源类型的专用子格式，不先新增顶层 `handwriting` 类型。
- 原文件不被笔迹写入覆盖。导出生成独立文件，保持可编辑源与扁平输出分离。
- Chat 的识别默认只读；AI 写入批注必须有明确写入意图，破坏性操作需要额外确认。

### 2.3 不进入首期

录音同步、无限画布、多人实时协作、复杂套索与对象排版、手写字形合成、自动图形识别、完整 `.xnote/.xcanvas` 兼容、通用绘图插件平台，以及对任意文档格式的高保真万能转换。

首期不自动把所有笔迹送入 RAG 或生成向量索引。AI 当前对话识别与全库检索是不同功能，不能把原始笔迹 JSON 当作可检索正文。

## 3. 当前代码事实与缺口

以下为调研确认的现状，不代表后续设计已经存在。

| 现状 | 证据 | 对设计的影响 |
| --- | --- | --- |
| React 页面可按需加载 | `src/lazyComponents.tsx:119-149`；`src/app/hooks/useViewLayerContents.tsx:78-152` | 沿用既有页面和编辑器模式，不先搭模块平台 |
| Workbench 排除移动平台 | `src/app/hooks/useWorkbenchMode.ts:69-81` | Android 走经典壳，桌面 Workbench 只提供同一编辑器的宿主入口 |
| 没有可直接复用的通用手写白板 | `src/features/notes/NotesContext.tsx:16-34` 明示旧白板已移除 | MindMapCanvas 和 canvas-note 名称不能视为现成手写编辑器 |
| PDF 当前批注是文本高亮 | `src/features/pdf/components/EnhancedPdfViewer.tsx:120-135` | 需要新增 ink/形状/文本批注模型 |
| 高亮已有版本检查与刷新 | `EnhancedPdfViewer.tsx:1807-1848`；`src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs:754-851` | 可沿用 CAS/OCC 模式，不可直接复用其全部数据结构 |
| 高亮最多 500 项且元数据有 512 KiB 上限 | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:3711-3731`；`textbook_repo.rs:761-816` | 大量手写点不能塞入 highlights 或任意元数据 |
| 通用 file/image 内容不可直接更新 | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:1637-1642` | 需要只针对手写子格式的受控保存处理，不放开所有二进制文件编辑 |
| VFS 已有内容寻址 blob | `src-tauri/crates/dstu-vfs/src/vfs/repos/blob_repo.rs:1-8,90-125` | 复用 blob 存储；必须补齐新格式引用的生命周期 |
| Office 目前是前端预览 | `src/features/learning-hub/apps/views/DocxPreview.tsx:203-220`；`PptxPreview.tsx:313-334` | 尚无已核实的通用 Office→PDF/逐页 PNG 转换器 |
| 图片上下文可产生真正的视觉内容块 | `src/features/chat/context/definitions/image.ts:103-160` | UI 加入 Chat 可复用 image ContextRef，不重建模型调用 |
| 现有 PDF 页图工具返回 data URL | `src-tauri/src/chat_v2/tools/textbook_pdf_executor.rs:406-468` | 可以参考，但返回 JSON 字符串不等于模型已经看见图片 |
| 通用工具结果在核查路径中转成文本 tool message | `src-tauri/crates/dstu-agent/src/chat_v2/context.rs:638-744` | 必须补充工具视觉产物进入当前轮模型的传输能力 |

特别注意：`dstu.setMetadata` 不是所有资源都能任意写任意字段的持久化接口。当前 file/image 分支主要处理进度、书签、收藏和名称，不能直接添加 `ink` 字段就认为会落库。

## 4. 总体架构与职责

```text
资源库 / PDF 阅读器 / 手写模块 / Chat 工具
                   │
                   ▼
           InkDocumentService
       创建、读取、版本检查、提交、导出
          │                      │
          ▼                      ▼
  现有 DSTU / VFS / blobs    DocumentPrepareService
  可编辑源与资源生命周期      PDF/图片/Office固定页面
          │                      │
          └──────────┬───────────┘
                     ▼
            共享 InkRenderer
       页面背景 + 笔迹 + 高亮 + AI 批注
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
    编辑器显示/PNG/PDF      版本固定的视觉产物
                                │
                                ▼
                      Chat ContextRef / ToolArtifact
                                │
                                ▼
                      现有模型上下文编译链路
```

### 4.1 最小组件边界

- **InkEditor**：输入、工具栏、视口和撤销；不直接写数据库，不直接调用模型。
- **InkRenderer**：由文档状态确定性绘制页面或选区；编辑器、导出、AI 快照共用；不能依赖当前可见 DOM 截图。
- **InkDocumentService**：唯一的文档业务入口；UI 和 Chat executor 共用验证、版本检查、提交和事件。
- **DocumentPrepareService**：将输入资源准备为固定页面；负责支持矩阵、转换任务与冻结结果，不负责笔迹编辑。
- **InkToolExecutor**：工具参数、授权、取消和结构化结果；不另写一套文档存储实现。
- **视觉产物适配**：把受信任的 VFS 图片产物送进当前轮模型输入，处理能力、大小、重放和 Provider 差异。

以上是责任边界，不要求每个都新增抽象框架或独立包。优先放在既有 feature、VFS 和 Chat 目录下。

## 5. 用户交互与页面模型

### 5.1 新建空白手写笔记

1. 在资源库或手写模块点击“新建手写笔记”，或在 Chat 明确请求创建。
2. 在当前资源文件夹创建一个手写文档，含一张空白页。
3. 用户书写，收笔后生成编辑操作；后台保存，UI 明示保存状态。
4. 可增加空白页；已有页使用稳定 `page_id`，重排不改变页身份。
5. 点击“问 AI”选择当前页/选区及问题，生成带版本的合成图后加入 Chat。

### 5.2 对已有文件批注

1. 在资源菜单选择“手写批注”。
2. PDF 直接引用源 PDF 页；图片按其尺寸建立一页；其他格式先准备固定页图。
3. 为源资源创建或复用一个默认批注文档，原始文件不变。
4. 同一文件有多次入口时复用同一个默认批注层；显式“另存副本”才创建独立文档。
5. 批注可继续编辑；导出生成独立结果，保留来源回链。

### 5.3 坐标与页面身份

- 每页保存稳定 ID、逻辑宽高、背景描述和有序批注对象。
- 画布内部使用逻辑页面坐标；与屏幕像素、DPR、当前缩放分离。
- 对外工具使用归一化区域 `x/y/width/height`，每项在 0..1 且区域完整落在页内。
- 全部新工具页索引统一 `page_index: 0-based`，UI 显示第 N 页时显式转换；返回结果同时带 `page_id`。
- 模型看到的裁剪图必须带 `crop_rect`、实际像素宽高、页面到图片的变换。写工具要求明确 `coordinate_space=page|render_crop`，后者必须绑定 `render_id`，由服务端转换，禁止凭截图猜坐标。
- PDF 旋转、CropBox 和页面比例由统一转换处理；页面缩放、窗口变化不得改变批注落点。

## 6. 文件系统与存储设计

### 6.1 单一事实源：VFS 文件子格式

建议定义内部扩展名 `.dsink`，MIME `application/vnd.deepstudent.ink+json`，`schema_version=1`。这是普通 VFS `file` 资源的专用格式，不是 ZIP 虚拟文件系统，也不是照搬 XNotes 文件格式。

- 每个手写/批注文档都有独立且稳定的逻辑文件 ID；底层 manifest/blob 可随保存换新 hash。
- 新建空白文档包含唯一 `document_id`，避免内容寻址去重把两份空白笔记合并为同一可编辑文档。
- canonical manifest 保存文档身份、版本、来源、页面列表和页内容引用；小型标题等信息可镜像到资源元数据供列表展示，但不能形成两个可写事实源。
- 原 PDF/图片的资源元数据仅保存默认批注文档的定位信息，不保存笔迹点。该字段必须增加明确后端读写处理，并与创建/挂接在同一提交中完成，不能依赖目前的任意 metadata 写入。
- 通用 `dstu.update(file)` 保持禁用；只给合法 `.dsink` 资源增加格式限定的保存入口。模型不能借此写任意本地路径或覆盖任意文件。
- `.dsink` 的默认预览和上下文解析必须走专用分派：不把 manifest/原始笔迹 JSON 当普通文件正文发给模型，不走通用文件 OCR/索引。检索首期覆盖标题/标签，识别文本或导出图片作为独立派生产物按现有类型处理。

### 6.2 文档逻辑结构

```text
InkDocument
  schema_version, document_id, revision, title
  source: blank | { resource_id, source_hash, conversion_revision }
  pages[]:
    page_id, width, height
    background: blank | pdf_page | image
    background_ref, background_hash, source_page_index
    page_blob_hash
  last_operation: operation_id, input_hash, previous_revision, result_revision

InkPage（独立的内容寻址 blob）
  schema_version, page_id
  objects[]:
    id, kind, author(user|ai), created_at
    stroke: samples(x,y,pressure,elapsed_ms), style
    或 text / rect / ellipse / arrow / region_highlight
```

manifest、页内容和转换产物全部使用现有 VFS/blob 基础设施。按页保存，避免每一笔把整本笔记传过 IPC 或复制到 JSON 元数据。

### 6.3 必须补齐的生命周期

“JSON 中写了 blob hash”不会自动形成可靠引用。实现必须为该格式增加受控引用枚举与记账：

- 新页、更新页、删除页、换背景和删除文档都计算 blob/资源引用差异。
- 沿用现有 blob 引用计数与清理机制，避免活跃笔迹被 GC 删除或孤儿 blob 长期增长。
- 备份/恢复和同步携带 manifest 及其全部依赖闭包；不能只备份可见 PDF。
- 源文件被替换、源 hash 不一致时明确标记“来源已变化”，不得把旧批注自动覆盖到新排版。
- 删除源文件不静默删除手写成果；应按现有引用/回收站规则提示依赖。需要独立保存时固定背景副本。
- 关闭功能只隐藏新建入口，不删除源文件、批注或 Chat 快照，仍保留打开已有成果/导出能力。

首期不新增独立 DB。若引用登记或原子挂接无法安全复用现有字段，允许在当前 VFS 数据库中做最小 schema 迁移；必须同步补齐表分类、迁移和恢复测试，不以第二套存储绕过这些约束。

### 6.4 原子提交、并发和恢复

1. 用户输入形成当前页操作，收笔后在本地恢复日志记录；笔迹采样不逐点过 IPC。
2. 服务校验文档格式、页身份、操作预算与 `expected_revision`。
3. 准备新的页 blob 和 manifest，不覆盖旧 blob。
4. 在数据库事务内 CAS 替换 canonical manifest 指针，更新文件/hash/元数据及引用；成功才更新可见 revision 并发事件。
5. 文件系统暂存与数据库不可能天然组成一个事务：沿用现有 staging/清理方式处理失败残留，DB 不得指向未完成文件。
6. 保存失败保留草稿并显示重试入口；冲突保留本地修改供比较，不照搬高亮链路中可能回滚本地内容的行为。
7. 多设备同步暂按现有冲突机制保留冲突副本，不宣称有笔画级 CRDT 合并。

版本使用后端产生的不透明 revision，不以 UI 时间戳猜测。初版按文档级 CAS 串行提交，页面级缓存不意味着页面级并发写入。

### 6.5 幂等边界

- 创建、准备和写入工具均接受 `operation_id`；工具层以会话/调用身份绑定，调用方不可伪造其他会话身份。
- 同一次创建/准备使用确定性的逻辑 ID，并校验输入 hash，重复请求返回原成果而不是再建一份。
- 变更提交把 `last_operation` 与 revision 原子保存；紧邻重试可返回同一回执。
- 如果已经发生后续编辑，无法证明旧操作是否应重放时返回 `OPERATION_STATE_UNKNOWN`/冲突，要求读取当前状态；绝不盲重试。首期不承诺无限期 exactly-once。
- 取消发生在提交前则无文档变更；提交后取消返回 `committed` 和新 revision，不声称已回滚。导出与识别失败不触发重复写笔迹。

## 7. 文档转换策略

### 7.1 支持矩阵

| 输入 | 准备方式 | 首期边界 |
| --- | --- | --- |
| PDF | 引用现有 PDF 资源与页面渲染，不重复引入 PDF 引擎 | 页图未就绪时给出处理进度/失败，不用旧图冒充成功 |
| PNG/JPEG 等已支持图片 | 复用图片解码，固定尺寸与方向 | 超大图片限制像素和内存 |
| DOCX/PPTX 等已有预览格式 | 复用预览解析，新增分页与页图生成适配 | 当前只有预览，转换能力需实现并逐格式验收 |
| XLSX、旧二进制 Office、加密或其他格式 | 仅在相应适配通过验收后声明支持 | 不支持时提示用户先导出 PDF/图片，不默默截断内容 |

统一的是进入手写引擎后的页面接口，不是声称所有输入已能转换。

### 7.2 固定页面规则

- 转换结果绑定源 hash、转换器版本、字体/页面配置和输出尺寸，形成 `conversion_revision`。
- 字体与图片加载完成、动态图表稳定后再生成页图；不能只截当前屏幕可见部分。
- 转换后提供预览，用户确认版面再开始书写；Chat 发起时返回准备结果与质量警告，不把预览截图说成高保真 Office 转换。
- 冻结页图后窗口宽度变化不再触发重排。原文件变化则显式重新转换并提示旧批注映射风险。
- 首期不自动安装桌面转换程序，不外传文档进行云转换。若后续需要高保真引擎，单独评估依赖、平台、许可和用户授权。

## 8. 共享渲染、导出与性能

### 8.1 同一份状态渲染三类结果

编辑器、AI 页图、导出必须共用对象顺序、背景、颜色、透明度和几何规则。荧光笔叠色、橡皮结果、文字换行均不能各写一套不一致实现。

PNG 是扁平视觉结果，不作为可编辑笔迹源。PDF 导出首期允许逐页嵌入合成图的栅格 PDF，不承诺保留原 PDF 文本层、可编辑标准 PDF 批注或矢量笔迹；多页输出需验证清晰度和体积。优先核查现有 native PDF 能力是否能写入；若不足，只引入经评审的最小 PDF 输出能力，不顺带引入 Office 套件。

### 8.2 编辑器未打开时也能工作

Chat 工具不能要求用户先打开手写页面，否则不算完整工具化。

推荐新增应用级渲染任务处理器：Rust executor 提交绑定资源/版本的任务，活动主 WebView 中的共享 renderer 在离屏 Canvas 上加载并合成，再经受控桥提交 VFS 产物。它不依赖某个 Workbench 窗口，不以 DOM 截图作为结果。

现有 Rust→前端桥可参考，但目前核实的是编辑器写入 probe/apply_ops，不能冒称已有通用离屏合成服务。新桥必须有 request ID、会话绑定、版本验证、超时、取消、大小限制和重复响应去重；应用不可用时返回明确错误，不偷偷换用不同版本渲染。

### 8.3 性能和生命周期约束

- 动态加载手写模块，避免被根 barrel 静态导入破坏拆包。
- 使用 Pointer Events，支持时收集 coalesced events；无压感设备使用固定宽度降级。
- 高频采样和当前笔迹留在编辑器内部；React 不逐点更新整棵页面树。
- 当前笔迹与已完成笔迹分层；仅加载可见页和有限相邻页，限制 Canvas 像素预算。
- 保持文档逻辑坐标与缩放分离，重开/导出不能重新平滑成不同形状。
- 大图与导出复用现有 staged upload，不让多份整本 base64 同时驻留 WebView。
- 页面驱逐、切后台、禁用模块和应用退出均处理待保存操作；普通 unmount 清理不是唯一保存保障。

## 9. Chat 上下文：用户入口与 AI 视觉输入

### 9.1 UI → Chat

“问 AI”流程：完成当前笔并保存 → 固定 revision → 生成当前页/选区合成图 → 保存图片产物 → 创建 image ContextRef → 加入用户问题。

附件显示来源、页码和“含批注”标识；可回到手写页。用户可选择其他已存在的版本，但不能在不提示的情况下将含批注输入退回原 PDF 文本。

### 9.2 不可变视觉产物

每个视觉产物至少保存：`artifact_id`、图片资源 ID、document/page ID、revision、source/conversion hash、裁剪区域、像素尺寸、MIME 和内容 hash。

缓存键包含 `document_id + revision + page_id + source_hash + source_annotation_revision + conversion_revision + crop + render_profile`。笔迹、背景、既有 PDF 高亮或渲染版本变化后不得命中旧快照。

已有 PDF 文本高亮继续由其现有链路管理，不无提示地迁移或双写。共享 renderer 读取并合成该层，同时记录其 `source_annotation_revision`；新手写模块产生的荧光笔对象属于手写文档自身。合成服务固定并核验这些输入版本，完成前发现任何输入已变化则返回冲突或重新生成，不能将多版本拼接图标成一致快照。

AI 根据页图进行位置相关写入时，还必须传 `based_on_render_id`。服务确认该图对应的文档、来源和既有高亮版本仍有效；过时则要求重新看图，不盲目沿用旧位置。裁剪坐标通过同一个 render ID 恢复到页面坐标。

已经发出的 Chat 消息固定对应当时产物；之后改笔记不改变历史消息中的图片。默认“加入 Chat”固定快照而非动态引用，避免同一条消息重试时读到不同页面。

### 9.3 视觉模型与非视觉模型

优先沿用已有模型能力与上下文编译规则。当前模型支持视觉时发送真实图像块；若已有可用的辅助视觉/OCR 路线则显式走该路线并标明结果来源；否则返回 `VISION_MODEL_REQUIRED`，引导切换模型，不让文本模型仅凭坐标声称读懂手写。

识别结果是模型派生内容，不覆盖可编辑笔迹。纯文本转录可由用户保存为现有 Markdown 笔记，无需为此新增第二套笔记资源。

## 10. Chat 工具体系

### 10.1 注册与执行必须全链路接入

按现有 built-in 工具模式新增一组 `ink-tools` 技能：

1. 前端技能定义 `allowedTools`、`embeddedTools` 和参数 schema，按需暴露。
2. Rust executor 加入生产 roster，负责参数校验和调用共享文档服务。
3. Rust descriptor 登记敏感度、副作用、超时与能力门控；descriptor 不是技能 JSON Schema 的替代品。
4. 执行路径发出 start/end/error，保存 tool block，结果卡片能打开文档或产物。
5. 模块禁用、能力缺失或资源不可用时返回结构化错误；工具发现与后端执行都要守卫，不能只隐藏按钮。

工具名以下为设计拟定，落地时与仓库命名约定统一。

### 10.2 首期工具清单

| 工具 | 输入核心 | 返回/行为 | 权限 |
| --- | --- | --- | --- |
| `builtin-ink_prepare` | source_resource_id、operation_id | 为现有文件创建/复用默认批注文档；返回转换状态、文档 ID、页列表、质量警告 | 写入/本地转换 |
| `builtin-ink_create` | title、folder_id、page_size、ruling、operation_id | 创建至少一页的空白笔记，返回文档 ID、revision、打开定位 | 写入 |
| `builtin-ink_get` | document_id；可选 page_id 或 operation_id | 读 manifest、页面摘要/有限对象列表、revision；查询既有操作状态 | 只读 |
| `builtin-ink_render` | document_id、expected_revision、page_id、可选 crop | 生成含批注视觉产物，**注入当前轮真实图像**，返回 render_id、坐标映射和可打开产物 | 本地只读派生；送模受对话授权约束 |
| `builtin-ink_apply_ops` | document_id、expected_revision、operation_id、ops；定位批注带 based_on_render_id | 原子提交有界操作，返回前后 revision、对象 ID、回显信息 | 受控写入 |
| `builtin-ink_export` | document_id、expected_revision、page_ids、format、operation_id | 生成新的 PNG/扁平 PDF 文件，返回资源和页数，不覆盖原件 | 创建派生文件 |

打开笔记优先使用既有导航/资源打开动作及卡片链接，不为了打开再增加一套文件导航工具。查找笔记优先复用现有资源搜索，不新建手写搜索引擎。

### 10.3 `apply_ops` 的边界

首期支持：`append_blank_page`、`add_text`、`add_rect`、`add_ellipse`、`add_arrow`、`add_region_highlight`、`update_object`、`remove_object`。

- 不暴露整文档覆盖、任意 SVG/HTML/脚本和任意文件路径写入。
- 人类手写的高密度采样走编辑器内部保存接口，模型无须生成成千上万坐标点。
- 更新/删除用户已有对象必须明确授权；只说“识别/解释”不授权修改。
- 文本对象使用固定字体/样式白名单及普通字符串，不执行 HTML。
- 文档正文、手写识别文本和批注均是非可信资料内容，不是工具调用指令；其中出现的“忽略规则/上传文件/删除资料”等文字不能提供授权或改变会话权限。
- 批次大小、文本长度和几何数量由 schema 与后端共同限制，初版单次最多 100 个操作；超过时明确分批且每批重新读取 revision。
- 一批操作先完整验证再事务提交，默认全有或全无。异步渲染/导出失败不回滚已成功写入的笔迹。

### 10.4 工具结果中的图片必须真正进入下一次模型调用

现有页图工具返回 `image_url` 字段，但核查到的通用 tool message 组装是 JSON 文本。把 data URL 字符串塞进 tool output、在 UI 展示缩略图或返回 `artifact_id`，都不算模型视觉输入。

需要增加明确的受信任视觉产物通路：

- executor 返回普通结构化摘要，以及类型化的视觉产物引用；不把整段 base64 放进常规工具文本/日志。
- 本轮上下文组装器只解析本地受信任 executor 产生、绑定当前 tool_call/session 的产物引用，解析真实图片字节。
- 在下一次 LLM 请求前，通过现有 ContentBlock/上下文编译链路生成真实 image block。
- 不同 Provider 对 tool 消息视觉内容支持不同：由适配层使用合法的多模态 tool result 或与 tool_call 关联的跟随视觉消息，不假定所有 Provider 都允许 tool role 图片。
- 必须按 `artifact_id + revision` 去重并在 Chat 历史中保存足以重放的引用；重启、继续对话或重试时能够恢复同一图。
- 如果图片注入失败，工具不能用 `success=true` 暗示“已看见”；返回明确的视觉传输错误和可恢复方式。
- 对普通工具 JSON 中任意 `image_url` 字符串不自动取远程地址，防止 SSRF、外部追踪和不受控数据外传。

工具渲染的首期预算建议：每次最多 4 页，默认最长边 2048；总图片字节和 Provider 限制另设硬上限。较长文档按页/选区读取，不在单次工具输出中塞全本图片。

### 10.5 权限、写入安全与打开编辑器协调

- 将读取和写入登记为不同风险等级，但不能假定标为 Medium 就必然弹用户审批；必须接入实际授权执行路径。
- 用户明确请求“新建/标注/写在文件上”可授权该次边界内的写入；笼统讨论、识别、总结不授权写。
- 清空页面、删除用户笔迹、覆盖已有文字、替换背景等破坏性行为须在提交前给出对象/页范围并确认。首期不提供清空整本工具。
- 用户编辑器有未提交草稿时：精确定位编辑会话并协调 flush；不能安全合并时返回 `EDITOR_BUSY`，保留草稿。不得拿后台旧 revision 绕过编辑器直接覆盖。
- 所有写入最终进入同一 InkDocumentService。现有 ACR probe/apply_ops 是参考模式，不是可直接假定覆盖本模块的能力。
- AI 操作作为一组事务回显，标记 `author=ai`；可撤销其对象变更，不以回退整个文件版本覆盖之后的人类输入。

### 10.6 结果卡片与错误契约

卡片至少显示：目标文件、页码、动作、成功/失败/处理中、生成对象或文件数量，以及“打开页面/预览产物/查看变更”。取消与部分副作用必须如实显示。

通用返回：`status`、`document_id`、`revision`、`operation_id`、`affected_page_ids`、`artifacts`、`warnings`；有异步任务时返回任务 ID 与查询入口。

错误统一包含 `code/message/hint/retryable/current_revision`（最后一项可选）。核心错误包括：`INVALID_ARGUMENT`、`RESOURCE_NOT_FOUND`、`UNSUPPORTED_FORMAT`、`CONVERSION_FAILED`、`SOURCE_CHANGED`、`REVISION_CONFLICT`、`EDITOR_BUSY`、`PERMISSION_REQUIRED`、`RENDER_UNAVAILABLE`、`IMAGE_DELIVERY_FAILED`、`VISION_MODEL_REQUIRED`、`OPERATION_STATE_UNKNOWN`、`CANCELLED`、`LIMIT_EXCEEDED`。

## 11. 端到端 Chat 场景

### 场景 A：识别我的手写解题

用户在笔记中选择区域 → “问 AI：这步推导哪里错了” → 固定当前版本并生成合成图 → image ContextRef → 模型解释 → 卡片回到对应页。仅识别，不写入批注。

### 场景 B：从对话创建笔记

用户：“建一份线性代数手写笔记，先放三页空白纸。”

模型调用 `ink_create`，再按需 `apply_ops(append_blank_page)`；返回真实文档与页数。若需要写入标题，可添加普通文本框；不能只输出一个看似创建成功的链接。

### 场景 C：查看资料并标出错误

用户：“看这个文件第 3 页，把我圈出的推导错误标在旁边。”

`ink_prepare` → `ink_get` 取得 revision/page_id → `ink_render` 看见含用户圈画的页图 → 模型判断 → `apply_ops` 添加箭头和说明 → 编辑器实时回显 → 再次 render 验证位置。所有工具页索引转换为 0-based，界面仍显示“第 3 页”。

若转换、视觉模型或图片注入不可用，应停在明确错误处，不凭原文猜测批注。

### 场景 D：导出有批注的资料

用户：“把批注后的第 2 到 4 页导出 PDF。”

读取并固定 revision → `ink_export` → 新建导出资源 → Chat 返回可打开文件。原资料与可编辑手写文档不变，导出结果注明源版本。

## 12. 实施分期与依赖顺序

| 阶段 | 交付内容 | 出口验收 |
| --- | --- | --- |
| P0 风险验证 | Android 真机压感/触控；固定版本离屏合成；工具图片进入本轮视觉模型；一个 Office 格式页图验证 | 证明跨端输入、渲染和工具视觉链路可行，测量而不预报体积/延迟 |
| P1 数据与编辑 | VFS 子格式、按页保存/引用/恢复、PDF/图片批注、空白多页笔记、基本工具 | 保存重开、缩放旋转、冲突、退出与 GC/恢复均正确 |
| P2 Chat 闭环 | 六类工具、注册/授权/取消、UI→Chat、视觉产物传输、结果卡片、AI 批注回显 | 不打开编辑器也可创建/读图；AI 真正看图并受控写入 |
| P3 转换与导出 | 经验证的 Office 固定页图、PNG/PDF 导出、转换预览与错误提示 | 支持矩阵逐格式/平台通过；导出含全部批注且不覆盖原件 |

P2 是本需求完整交付的必选部分，不是可以删掉的“未来 AI 功能”。P1/P2 先构成 PDF/图片与空白笔记闭环；其他格式只有通过 P3 验收才可宣称支持。分期用于降低风险，不缩减最终目标。

## 13. 测试与验收标准

### 13.1 数据与输入

- 新建两份相同空白笔记，ID 独立；移动/改名后 Chat 回链仍有效。
- 压感/无压感、点画/快写、缩放/旋转/高 DPR、笔与手指切换均有测试。
- 收笔前后和保存重开后几何一致；坐标经裁剪与页面转换后不漂移。
- 无效 schema、未知版本、超限点数/坐标/文本/图片被拒绝，不执行任意脚本或路径。

### 13.2 保存、引用与恢复

- 两窗口与 UI/Chat 同时写入时 CAS 拒绝旧版本；未保存人类草稿不丢失。
- 成功提交后中断回执、重复 tool call、取消、崩溃恢复均不重复新增对象。
- 删除页、删文档、源文件入回收站、blob GC、备份/恢复、同步冲突均覆盖引用闭包。
- 功能关闭不删除数据，旧成果仍可预览或导出；不支持的格式版本明确只读/拒绝写入。

### 13.3 渲染、转换与导出

- 构造含彩色原文、红色圈画、荧光笔、文字和箭头的固定样本，验证编辑器/PNG/PDF 的合成一致性。
- Office 测试覆盖多页、图片、字体缺失、图表、表格和异常输入；转换失败不丢页、不只截屏幕第一屏。
- 大文档只加载可见页，导出/识别按预算串行或有限并行；检查 Android 内存峰值与恢复日志。

### 13.4 Chat 工具关键验收

1. 注册检查：技能可发现、参数 schema、Rust roster、descriptor、UI 卡片与失败事件一一对应。
2. **视觉输入检查**：在原 PDF 没有答案的位置手写一个标记，通过工具 render 后捕获测试 Provider 请求，确认有真实图片内容块，而不是仅带 base64 的 JSON 文本。
3. 在可用视觉模型上执行“读出新写标记”人工冒烟测试；模型输出准确率与传输正确性分开记录。
4. 工具执行时不打开编辑器，仍能得到合成页图；不可用时明确返回错误。
5. 修改笔迹后再识别得到新 revision；旧消息重放仍使用旧图。
6. 仅请求解释不产生写入；删除用户对象必须经过实际确认机制，不仅依靠提示词。
7. AI 添加箭头/文本后编辑器刷新，返回的页/对象链接可定位，可撤销该 AI 事务。
8. 文本模型无辅助视觉能力时明确要求切换模型，不编造“已识别手写”。
9. 超时/取消后无重复写入、无悬挂渲染任务；提交完成后取消如实显示 committed。

## 14. 代码落点建议与复用边界

以下是拟议落点，最终实现以仓库届时结构为准，不把新文件名视为现存事实。

| 层 | 现有入口或建议位置 | 变更方向 |
| --- | --- | --- |
| 手写 feature | 新增 `src/features/ink/` | 编辑器、模型、渲染和应用级渲染任务处理 |
| 页面/资源打开 | `src/lazyComponents.tsx`、`src/app/hooks/useViewLayerContents.tsx`、`src/dstu/editorRegistry.ts` | 懒加载、file 子格式分派；桌面与经典壳复用 |
| VFS | `src-tauri/crates/dstu-vfs/src/vfs/`、`src/dstu/` | 格式限定服务、OCC、引用枚举、事件和数据校验 |
| 文件准备 | `src/features/learning-hub/apps/views/`、现有 PDF 模块 | 提取可复用预览渲染，新增固定页图适配，不把 UI 组件当稳定转换 API |
| 技能/schema | 新增 `src/features/chat/skills/builtin-tools/ink-tools.ts`，沿既有技能入口注册 | 六类工具定义、示例、风险与能力说明 |
| Executor | 新增 `src-tauri/src/chat_v2/tools/ink_executor.rs`，接 `src-tauri/src/agent_wiring/roster.rs` | 共享服务、受控桥、事件、错误与回执 |
| 风险描述 | `src-tauri/crates/dstu-agent/src/chat_v2/tool_descriptors.rs` | 风险/副作用/超时/能力门控 |
| 本轮图像输入 | `src-tauri/crates/dstu-agent/src/chat_v2/context.rs`、对应 tool loop/Provider 适配 | 类型化视觉产物物质化与历史重放，避免普通 JSON 冒充视觉输入 |
| UI 上下文 | `src/features/chat/context/definitions/image.ts`、`src/features/chat/adapters/contextHelper.ts` | 复用 image ContentBlock，补来源和版本元数据 |
| 数据治理 | 现有 sync/backup/GC 路径 | 识别新格式引用闭包；有 schema 增量则补表分类和迁移 |

不改回旧 NotesProvider/旧 canvas-note 链路，不把手写笔记误接到已移除白板，也不把桌面专用 plugin manager 当 Android 宿主。

## 15. 依赖、许可与待评审事项

### 15.1 依赖与许可原则

- 浏览器 Canvas/Pointer Events、已有 React/Tauri、VFS/blob 与图片模型链路优先。
- 不因手写引入整套绘图框架、Office 套件、独立对象存储或外部转换服务。
- 新增依赖必须证明现有能力无法满足，并说明包体、移动端支持与许可；不能把“零新增文件系统依赖”偷换成“没有必要的保存/校验代码”。
- XNotes 的纯 Kotlin 笔迹算法可参考或移植；不默认能直接 import 到 TypeScript。若复制/改编源码需保留 MIT 版权与许可；第三方字体/native 组件不随意搬运。
- DeepStudent 声明 AGPL-3.0-or-later；第三方许可核查与声明按项目现有流程执行。

### 15.2 评审需要确认的产品边界

1. Office 首期按现有预览效果转换为固定页图，是否接受其不等同于原生 Office 高保真排版；不接受则需单独评估转换引擎。
2. 首期“空白画布”采用可增加页面的分页纸张，不包含无限画布。
3. AI 直接写入使用文本/形状批注，不把人类书写模拟作为目标；写入受用户意图与确认限制。
4. 首期 PDF 导出可为清晰的扁平栅格 PDF，不保证保留可选中文本或标准可编辑 PDF 批注。

这些是明确的评审选择，不是当前已完成或已获用户确认的能力。

## 附录：XNotes 参考证据与调研限制

固定上游提交下的参考：

- [StrokeEngine.kt](https://github.com/shardulvs/xnotes-android/blob/3926304a0a2ca20b0ac259317b5e60f77d4668b1/app/src/main/java/com/xnotes/core/stroke/StrokeEngine.kt#L10-L44)：纯算法、按弧长平滑、压力与速度控制。
- [CanvasCodec.kt](https://github.com/shardulvs/xnotes-android/blob/3926304a0a2ca20b0ac259317b5e60f77d4668b1/app/src/main/java/com/xnotes/format/CanvasCodec.kt#L63-L78)：ZIP/manifest 格式，可编辑矢量笔迹；本方案不照搬其格式。
- [app/build.gradle.kts](https://github.com/shardulvs/xnotes-android/blob/3926304a0a2ca20b0ac259317b5e60f77d4668b1/app/build.gradle.kts#L19-L43)：Android/NDK 平台边界，不能视为现成 Web SDK。

上游浅克隆因网络问题未完成，关键源码通过固定 SHA 的只读 GitHub API 核查；未运行上游或 DeepStudent，未测量书写延迟、内存、包体、转换保真度或模型识别率。所有新工具、手写子格式、离屏渲染桥及视觉产物传输均为拟议实现，需通过上述验收后才能宣称交付。
