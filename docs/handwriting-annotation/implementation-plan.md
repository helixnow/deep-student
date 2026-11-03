# 手写笔记、文件批注与 Chat 集成实施计划

> For agentic workers: use `subagent-driven-development` task-by-task. 子 agent 探索和修改代码；主 agent 审查并亲自运行测试。任务使用复选框追踪；未经主 agent 实际验证不得标记完成。

**Goal:** 空白分页手写笔记、现有资料的非破坏性批注、含批注图像的 Chat/AI 识别与受控编辑、转换及导出。

**Architecture:** Canvas/Pointer Events 共享编辑与确定性渲染核心；Rust 文档服务统一 VFS 格式、CAS、操作和引用生命周期；前端与 Chat 调用同一服务。模型输入使用本地可信的不可变图像产物，不把 JSON 图片链接当视觉输入。

**Tech Stack:** React/TypeScript、Tauri/Rust、现有 SQLite/VFS/blob、Canvas 2D、pdfjs、snapdom、pdfmake。

**Spec:** [design.md](design.md)。原调研文档为 `docs/superpowers/specs/2026-11-02-handwriting-annotation-chat-design.md`，本次批准将其归档至本目录，不删除原文件。

> **历史批准计划：** 下方复选框与Context保留批准时原文，不代表任务未执行或当前权限。Task1–10实现及回归已执行，后续按新增授权创建本地源码提交 `7fef25ec`；Phase-5已完整修复，当前视觉模型以自建夹具11/20次实测。收尾任务、最新Android／APK和精确门禁以 [closure-plan](closure-plan.md)、[closure-progress](closure-progress.md)、[closure-results](verification/closure-results.md) 为准；不push／merge／publish。真机体验仍需设备验证。

## Context

2026-11-02 用户要求新建分支并实施上一轮方案，要求每阶段运行已有测试并为覆盖不到的功能新增测试；子 agent 作为探索/修改执行者，主 agent 负责审查和测试；文档集中存放。完整计划已通过 ExitPlanMode 批准。

- 工作目录：`/home/xutao/deepstudent/deep-student`。
- 分支：`feat/handwriting-annotation-chat`。
- 起点：`6c73530d`，创建前工作区干净。
- 不自动提交、推送、合并、发布；不更改原规划目录的忽略规则。

## Global Constraints

- 复用 VFS/DSTU/blob，仍为 `file` 子格式；不新增文件系统、数据库服务、顶层 handwriting 类型或运行时依赖。
- `.dsink`、`application/vnd.deepstudent.ink+json`、`schema_version=1`；独立逻辑文档 ID 写入 manifest 字节，防止同内容空白笔记合并。
- 原件不覆盖；按页保存；canonical manifest 唯一可写事实源；引用清单仅由服务派生并原子更新。
- 服务端不透明 revision，CAS 基于旧 manifest 指针；`files.updated_at` 不作为唯一笔迹版本。
- 通用 `dstu_update(file/image)` 仍禁止。原始笔迹/manifest 不进入正文、OCR 或 RAG。
- 图像与历史消息固定版本；工具必须送入真实 image part。对任意工具 JSON URL 不发起网络请求。
- Chat 识别默认只读；写入接实际审批；破坏性操作需精确范围审批，不能由全局 bypass 解除。
- 子 agent 不再派生 agent、不自行运行阶段验收、不提交/推送；主 agent 运行红灯、绿灯和已有回归，拒绝无证据完成声明。
- 新行为先有失败测试，再实现；覆盖不到的实际像素、设备行为不能由 mock 冒充。
- 每个阶段记录命令、退出码、测试数、失败/阻断。已有失败单列，不删测试、不弱化断言。
- 所有本功能记录在 `docs/handwriting-annotation/`，不建立第二个隐藏记录目录；进度文件是恢复依据。
- Android 经典壳、桌面 Workbench 共用资源入口。前端使用项目 UI 组件、主题、完整中英文 i18n。
- 固定分页、AI 文本/形状、Office 本地预览固化、扁平栅格 PDF 是批准的实施边界；不包含无限画布、录音、协作或万能高保真转换。
- Android 真机/真实模型无环境或授权时如实标记未验证；允许继续平台无关工作，不宣称整体验收通过。

## 阶段门禁与记录

目录：`README.md`、`design.md`、本计划、`progress.md`、`reviews/`、`verification/`、`acceptance.md`。临时任务 brief/report 也放本目录下的 `tasks/`；保留记录，不由技能默认清理脚本删除。

循环：子 agent 写测试 → 主 agent 审查并验证红灯 → 同一子 agent 实现 → 主 agent 查完整差异和调用链 → 主 agent 运行新增/已有测试 → 子 agent 修复 → 主 agent 复测 → 记录完成。一项有依赖任务通过后再推进依赖它的任务。

## Task 0: 基线、记录与风险验证

Files: 本目录、`tests/fixtures/ink/`、现有测试配置（仅必要时）。

- [ ] 完整归档设计，建立 README/progress/acceptance 与阶段记录。
- [ ] `npm ci` 复用 package-lock；核对 Rust、Linux native 库、Playwright；不升级锁文件。
- [ ] 主 agent 运行前端完整测试（四片串行）、typecheck/分层与相关 Rust crate 基线，保存输出。
- [ ] 建立自建、无用户资料的 `.dsink`/笔迹/PDF/PNG/DOCX/PPTX 夹具。
- [ ] 对离屏页图、工具真实多模态请求、Office 完整页固化先作可运行验证，避免只截第一屏。
- [ ] Linux PDFium 缺失时核对既有下载脚本、来源与校验；无真机/模型授权标记阻断，不安装 Office/Docker/系统软件。

Commands: `npm test -- --shard=1/4` 至 `4/4`；`npm run typecheck`；`npm run check:frontend-layers`；`npm run check:crate-layers`；`cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-vfs --lib`。

## Task 1: 格式、验证与操作契约

Files: `src/features/ink/types.ts`、`src-tauri/crates/dstu-vfs/src/vfs/ink/{mod,types,validate,operations}.rs`（按现有模块惯例微调）、对应测试。

Produces: `InkDocument`（schema_version/document_id/revision/title/source/pages/last_operation）、`InkPage`（page_id/objects）、笔迹/文本/形状判别联合、创建/保存/操作请求、结构化回执和错误。

- [ ] 先写合法与非法格式测试：未知版本、重复 ID、NaN/无限坐标、页尺寸、对象/点数/字节预算、文本长度与样式白名单。
- [ ] 主 agent 执行测试并记录预期红灯。
- [ ] 实现 serde/TypeScript 一致契约、普通字符串文本、归一化几何操作；最多 100 操作且整批先验证。
- [ ] 位置相关工具写入要求 based_on_render_id，coordinate_space=page|render_crop；内部高密度笔迹不暴露为模型点数组工具。
- [ ] 主 agent 运行新测试、既有 VFS 基础回归、格式和类型检查。

Canonical limits 在实现任务 brief 明确并通过共享 fixture 校验，避免 TS/Rust 各自猜测。

## Task 2: 原子保存、复制、删除与同步引用闭包

Files: `vfs/repos/ink_repo.rs`、`vfs/ink/`、`vfs/repos/file_repo.rs`、`dstu/handler_utils/delete_helpers.rs`、`dstu-sync/src/data_governance/sync/mod.rs`、Tauri 命令/权限注册、`src/features/ink/api.ts`。

Consumes: Task 1 契约。Produces: 单一文档服务 create/get/prepare/save_page/apply_ops，以及不可变 revision 与操作回执；render/export 在后续任务扩展。

- [ ] 写实际迁移测试 DB 的测试：相同空白内容文档独立、按页保存重开、CAS 冲突、失败事务无指针切换、相同操作返回旧回执。
- [ ] 写复制/清除/同步重算后 GC、源删除仍可读、备份恢复闭包测试。
- [ ] 主 agent 运行红灯后实现受格式限定服务，复用 `VfsBlobRepo::*_with_conn`、`StagedBlob`、`with_savepoint` 与教材 OCC 事务模式。
- [ ] manifest 切换同事务更新 files/resources/hash/派生引用。引用清单覆盖 page/background/source 依赖，来源只记录默认文档稳定 ID，不镜像可变版本。
- [ ] 复制 `.dsink` 重新生成文档和页身份，不使用通用文件共享可写 manifest 的复制逻辑。
- [ ] 复制、purge、DSTU purge、同步 `recompute_blob_ref_counts` 引用口径相同；JSON 写 hash 本身不算引用登记。
- [ ] 紧邻重复 operation_id/input_hash 返回旧结果；后续编辑后的不确定旧操作返回 OPERATION_STATE_UNKNOWN；提交前后取消分别报告无变更/committed。
- [ ] 通用文件更新仍拒绝；来源变更返回 SOURCE_CHANGED。
- [ ] 主 agent 审查 SQL/事务/计数并执行 dstu-vfs、dstu-sync 引用与恢复回归。

Commands:
```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-vfs --lib
cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-sync --lib regression_recompute_counts_json_embedded_blob_refs
cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-sync --lib blob
```
若必须迁移，仅当前 VFS 内最小增量；同步补 `dstu-storage` migration registry、表分类、fixture upgrade gate。不能先放出无法被同步/GC 保护的可写 UI。

## Task 3: 共享几何、输入与确定性 renderer

Files: `src/features/ink/{geometry,input,renderer}.ts`、`__tests__/`、`tests/ct/ink/`。

- [ ] 先测逻辑坐标与屏幕/DPR/裁剪的往返、压感降级、单点/快速笔迹、pointer cancel、对象顺序/透明度。
- [ ] 主 agent 验证红灯后实现 Canvas 2D/Pointer Events/coalesced events、笔与荧光笔、整笔橡皮、形状和普通文本。
- [ ] 当前笔与完成笔分层，React 不逐点更新；保存后不重新平滑成不同形状；首期不复制 XNotes 算法。
- [ ] browser CT 检查实际图像像素/完整页，jsdom mock 仅测数据变换，不代替渲染验证。
- [ ] 主 agent 执行新测试和已有 regionCapture/stagedUpload 回归。

```bash
npx vitest run src/features/ink src/features/pdf/__tests__/regionCapture.test.ts src/utils/__tests__/stagedUpload.test.ts
npm run test-ct -- tests/ct/ink
```

## Task 4: 编辑器、保存恢复与生命周期

Files: `src/features/ink/InkEditor.tsx`、页视图、工具栏、保存/恢复 hook、中英文资源、组件测试。

Consumes: 共享 renderer 与 Rust 文档 API。

- [ ] 先测空白 A4/横线/方格、多页、撤销/重做、失败重试、冲突保留草稿、隐藏/驱逐/退出恢复。
- [ ] 主 agent 红灯后实现工具栏、颜色/笔宽、缩放/平移、改名、保存状态；仅加载可见页和有限相邻页，限制像素预算。
- [ ] 收笔后持久恢复日志再保存当前页；恢复日志不依赖组件存活；模块关闭不删除已有文档。
- [ ] 主 agent 审查无静默覆盖、未完成指针输入和卸载行为；运行 CT、unit、typecheck、i18n 和分层检查。

## Task 5: PDF/图片 prepare 与双壳资源接入

Files: `learning-hub/apps/views/{filePreviewResolver,FileContentView}.tsx|ts`、`learning-hub/types.ts`、`dstu/editors/FileViewerWrapper.tsx`、`sidebar/resourceCreators.ts`、现有桌面/移动菜单、`dstu/contextMenu.ts`、Workbench preview shell、通用 OCR/正文/索引分派。

- [ ] 写子格式分派优先于 JSON/text、重复 prepare、source hash 变化、PDF 旋转/CropBox、直接 DSTU 打开和双壳入口测试。
- [ ] 实现 `ink` 预览子类型，不新增 DstuNodeType 或独立 Workbench 编辑器。
- [ ] 空白新建调用共享服务；文件菜单添加手写批注；PDF 用现有页图能力，图片固定方向/尺寸。
- [ ] `.dsink` 不走文件 OCR/正文/RAG；已有 PDF 文本高亮单独读取合成并记录其 revision，不迁移/双写。
- [ ] 原页图未就绪报告状态，不用旧图冒充完成。
- [ ] 主 agent 运行既有 preview/context menu/创建/Workbench 测试及新增端到端资源路径。

## Task 6: 应用级渲染桥、快照与 UI→Chat

Files: `ink` 应用级任务处理器、Rust 受控桥、应用根注册、`useReferenceToChat` 适配、产物测试。

- [ ] 先测编辑器未打开、request/session/tool_call 绑定、重复/过期回执、超时取消、渲染中版本变化、旧图重放。
- [ ] 使用共享 renderer 离屏合成，不依赖 Workbench 窗口/当前 DOM 截图；受信任主 WebView 不可用返回 RENDER_UNAVAILABLE。
- [ ] render_id 绑定文档/page/revision/source hash/source_annotation_revision/conversion_revision/crop/render_profile。
- [ ] 合成前后核验全部版本；经 staged upload 保存不可变 VFS 图像。
- [ ] 问 AI 流程：完成当前笔→flush/CAS→render→image ContextRef；复用 `useReferenceToChat.ts`/`image.ts`，显示含批注/页码/来源/回链。
- [ ] 主 agent 验证真实 PNG、历史不漂移、取消无悬挂任务和现有图片引用回归。

## Task 7: 六类工具、实际授权与卡片

Files: `chat/skills/builtin-tools/ink-tools.ts`、`builtin-tools/index.ts`、app `chat_v2/tools/ink_executor.rs`、`agent_wiring/roster.rs`、agent `tool_descriptors.rs`、`tool_approval_policy`/精确授权范围、工具卡片和对应测试。

Tools: builtin-ink_prepare/create/get/render/apply_ops/export。

- [ ] 写六工具 schema/发现/roster/descriptor、实际审批拒绝、识别只读、破坏性精确审批、EDITOR_BUSY、重试/取消、结构化错误/卡片测试。
- [ ] 实现统一 Rust 服务调用；get 限制输出，apply_ops 最多100项；定位写入必须验证 based_on_render_id 与 crop 映射。
- [ ] 复用 sensitivity_level_for_call、ApprovalGateHook 和 approval manager；删除人类对象不允许全局 bypass 降级。
- [ ] 编辑器有草稿先精确协调 flush，不能协调返回 EDITOR_BUSY；禁止绕过草稿后台覆盖。
- [ ] author=ai 对象事务回显并可撤销，不回滚整文件覆盖后续人类编辑。
- [ ] 发 start/end/error、保存 block、结果卡片可打开；提交后取消明确 committed。
- [ ] 主 agent 执行技能现有回归、agent_wiring/phase5/toolloop 审批取消回归与新测试。

## Task 8: 工具图像真实入模与历史恢复

Files: agent `context_compiler/` 新产物模块、`tool_loop.rs`、`history.rs`/多变体恢复、llm 请求组装/Provider 测试；只在必要处改现有结构。

- [ ] 写离线捕获 Provider 请求测试：工具后真实 image part，完整并行工具轮后插入，budget/dedup，文本模型明确错误，重放图像一致。
- [ ] 复用 retrieval_images 本地 blob/预算/轮次插入模式，但新增 session/tool_call/render 绑定的可信契约与持久化引用；不依赖仅瞬态 retrieval 缓存实现历史恢复。
- [ ] live/history 共用解析，图片 bytes/base64 仅请求内存在；禁止任意 JSON URL 获取；不信任 MCP/资料伪造 ink 产物。
- [ ] ink/retrieval 共用全局图预算，默认长边2048，最多4图且受字节硬限。
- [ ] 图像注入失败 IMAGE_DELIVERY_FAILED，非视觉模型 VISION_MODEL_REQUIRED；普通成功摘要不能暗示模型已看图。
- [ ] 主 agent 检查 OpenAI/Responses/Anthropic 等已支持 Provider 的请求体、live/history/多变体一致与旧检索测试。

```bash
npx vitest run src/features/chat/skills/__tests__ src/features/ink
cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-agent --lib
cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-llm --lib
cargo test --manifest-path src-tauri/Cargo.toml --locked --test phase5_tool_execution_e2e
cargo test --manifest-path src-tauri/Cargo.toml --locked agent_wiring
```
主 agent 核对实际选择到的测试数，0 tests 不算回归通过。

## Task 9: Office 固定页图与 PNG/PDF 导出

Files: `ink/prepare/`、`ink/export.ts`，对 `DocxPreview`/`PptxPreview` 最小提取，Rust产物保存服务；转换/导出单元和 browser CT。

- [ ] 写完整 DOCX多页/表格/图片/缺字体，PPTX幻灯片/图表，异常/超限/取消，不只第一屏的测试。
- [ ] 主 agent 红灯后用已有 docx-preview/pptx-preview + snapdom 逐页固化，等待字体/图片/图表，生成固定 conversion_revision；提供质量预览/警告。
- [ ] 与 Task 6 同桥，在编辑器未打开时也工作；来源变化不自动重排旧批注。
- [ ] PNG 当前页/选区与编辑一致；pdfmake 动态加载逐页嵌图，页比例/顺序正确，产物进 VFS 不覆盖原件；串行/有限并行控制内存。
- [ ] 未验证 XLSX/旧Office/加密格式返回 UNSUPPORTED_FORMAT；不自动安装外部转换器。
- [ ] 主 agent 跑富预览、paperExport、stagedUpload/PDF 回归和真实浏览器转换；输出PDF检查页数/比例/含圈画。

## Task 10: 全分支回归、跨端与交付

- [ ] 主 agent 审全差异：引用计数、CAS、数据丢失、审批绕过、图像重放漂移、生产注册、双壳入口。
- [ ] 完整前端测试四片/typecheck/lint/分层/i18n/许可/构建、Rust相关crate/app集成及CI总体nextest排除规则回归。
- [ ] E2E：三页空白书写重开问AI；PDF/图圈画→Chat看图→箭头说明→回显/撤销；关闭编辑器仍可Chat操作；Office固化/选页导出。
- [ ] 同步重算/GC/备份恢复、UI与Chat并发/未保存草稿、超时取消/重复调用/重启、文本模型/拒绝权限/转换失败。
- [ ] Android真机压感/误触/延迟/内存和真实视觉模型识别分别验收；需要环境/外发授权时标记未验证，不自动发送用户资料。
- [ ] 补 acceptance 矩阵、实际通过数/失败/未执行限制；不自动提交发布。

```bash
npm test
npm run typecheck
npm run lint
npm run check:frontend-layers
npm run check:crate-layers
npm run check:i18n
npm run licenses:check
npm run check:lint-ratchet
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all --check
```

## 预审：共享接口与文件交叉

| Tasks | 共享边界 | 裁决/核查 |
| --- | --- | --- |
| 1→2→3/4 | 格式、对象、API | TS/Rust 共用 fixture；先契约/存储再UI，类型不得双写漂移 |
| 2↔5/6/9 | prepare、引用、产物 | 所有持久化经同一服务；新背景/产物必须有可重算引用 |
| 2↔7 | save_page/apply_ops | 相同revision/CAS/幂等；UI密集点不塞模型工具 |
| 3↔4/6/9 | renderer | 一份状态，一份渲染规则；离屏、编辑、导出不各写一套 |
| 4↔7 | 草稿、flush、AI撤销 | 后台不绕过脏编辑器；对象事务撤销不回滚后续人类操作 |
| 5↔7 | 资源打开与工具卡片 | 文档稳定ID统一，复用现有资源打开导航 |
| 6↔8 | render产物/ContextRef | 不可变图像+版本；UI和工具都进入实际image part |
| 7↔8 | tool结果/历史 | 普通工具输出不含base64；受信任引用按工具调用绑定并重放 |
| 8↔现有retrieval_images | 预算/插入/Provider | 不拆并行工具组；共享总预算，保持旧检索行为 |
| 9↔现有Office/纸张导出 | snapdom/pdfmake | 复用现有依赖，不大规模预览器重构 |

预审裁决：用户要求统一记录、主 agent 测试审查、无自动提交，优先于技能默认隐藏ledger/子agent验收/自动commit。没有可用真机或真实模型授权时可推进平台无关代码，但对应验收保持阻断。实施发现具体接口差异时在 progress.md 记 `Ruling: 决定 — 理由 — 错误代价`，不静默改变方案。
