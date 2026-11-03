# 手写笔记 / 文件批注 / Chat 工具实施交接

> **历史暂停快照，不代表当前状态。** 用户随后已明确恢复并要求完整实施；源码已本地提交 `7fef25ec`，真实视觉模型以自建夹具11/20次实测。当前恢复入口为 [HANDOFF-CLOSURE](HANDOFF-CLOSURE.md)，最新收尾证据为 [closure-progress](closure-progress.md) 和 [closure-results](verification/closure-results.md)。下面的暂停、无功能代码、design不存在等只适用于旧交接时刻，不可据此暂停或重做已完成任务。

> 交接日期：2026-11-02（会话日期）。用途：供应商切换、上下文压缩后的准确恢复。
>
> **当前状态：用户要求暂停子 agent、切换供应商。仅完成方案、已批准实施计划、功能分支和部分环境/测试基线；没有功能代码或新增测试落盘。不得把此交接请求当作恢复开发的授权。**

## 1. 恢复时先读什么

1. 本文：实际状态、权限边界、测试证据和下一步。
2. [implementation-plan.md](implementation-plan.md)：本轮通过 ExitPlanMode 获批准的实施计划，Task 0–10；不要重新征求已经确定的实现范围、重新全面研究或重建分支。
3. [原设计文档](../superpowers/specs/2026-11-02-handwriting-annotation-chat-design.md)：完整产品方案、六工具、保存/渲染/授权/验收契约。
4. [tasks/task-1-brief.md](tasks/task-1-brief.md)：已写好的第一项格式契约任务说明（尚未执行成功，且其中少数实现细节需按第 9 节校正）。
5. 下述实际测试日志。看各测试自己的退出码/结果，不能只看外层脚本状态。

**注意：** `implementation-plan.md` 链接的 `design.md` 尚不存在；文档子 agent 在创建文件前被停止。方案目前仍在 `docs/superpowers/specs/`，该原目录被 `.gitignore:314` 忽略。

## 2. 用户需求与必须遵守的分工

用户先要求探索 XNotes Android：<https://github.com/shardulvs/xnotes-android>，后收敛为：

- 对已有文件批注、创建空白画布手写笔记，类似享做笔记基本功能。
- 文件统一进入 PDF 或固定图片页面模型；其他文档先转换。
- 复用 DeepStudent 现有文件系统，不引入复杂的独立存储依赖。
- 修改/批注后的最终页面必须能被应用 AI 模型识别，不能只识别原文。
- 整套机制接入 Chat，并提供相应工具。

本轮用户原文：

> 新建分支，实施计划。遵守：1.每一阶段代码修改完需跑已有测试，对已有测试无法覆盖的功能，新建测试。2.子agent用于探索代码和修改代码，充当手。主agent负责审查，测试，充当脑，对最终成品负责。3.记录文档在统一的文件夹

随后用户原文：

> 先停止子agent，我换个供应商

最新用户原文：

> 写一份交接文档，准备压缩上下文

执行约束：

- 子 agent 探索/修改代码；主 agent 决策、审查完整 diff/调用链、亲自运行测试并验收。不得让子 agent 的报告取代主 agent 审查和验证。
- 测试先行：子 agent 写测试与必要接口骨架 → 主 agent 验证预期红灯 → 允许实现 → 主 agent 运行新增/已有回归 → 修复复测 → 记录。
- 每阶段有关测试没通过/受阻，不能标记完成；无覆盖行为补测试，不删既有测试、不弱化断言。
- 子 agent 不再派生 agent、不自行扩大范围、不自动提交/推送。
- 文档/任务/审查/验证日志统一于 `docs/handwriting-annotation/`。用户偏好优先于技能默认隐藏 ledger 和分散目录。
- 不自动 commit、push、merge、publish，不安装 Office 套件/系统软件，不改 `.gitignore`、不 force-add 旧设计目录。
- 用户未要求 workflow，**不要自动启动动态 workflow**。
- 切换供应商后的继续需用户明确恢复；不自动重试已停止/失败的子 agent，不静默选模型/供应商。
- Android 真机、实际模型调用/外发/付费未获本轮执行授权，也没有完成验证。

## 3. 仓库、分支与真实改动

| 项目 | 实际状态 |
| --- | --- |
| 外层目录 | `/home/xutao/deepstudent`，不是 Git 根 |
| 仓库根 | `/home/xutao/deepstudent/deep-student` |
| 当前分支 | `feat/handwriting-annotation-chat`，已创建并切换 |
| HEAD / 起点 | `6c73530d87f3180c2ff555dd5729943a77086dc3` |
| 初始分支 | `main`；创建功能分支前工作区干净 |
| 受跟踪文件差异 | 交接核对时 `git diff --stat` 空、`git diff --check` 无输出 |
| 未跟踪文件 | 仅 `docs/handwriting-annotation/`（本交接也在其中） |
| 提交 / 推送 | 没有 |
| 依赖 | 已成功 `npm ci`；package.json / package-lock.json 未改动 |
| 自动生成文件 | 已执行原有 `npm run version:generate`，生成被忽略的 `src/version.ts` |
| Rust 缓存 | VFS/sync 基线编译已产生构建缓存，保留，不要重装/清理 |

交接核对时以下路径**不存在**，不能误以为已实现：

```text
src/features/ink/
src-tauri/crates/dstu-vfs/src/vfs/ink/
tests/fixtures/ink/
```

现有通用文件保存、工具视觉传输等仍是原实现。六个 ink 工具、`.dsink` 保存服务、共享 renderer、渲染桥、编辑器、Office 固定页转换均尚未写入。

## 4. 已落盘文档与未落盘交付

统一目录当前文件（本交接之外）：

```text
docs/handwriting-annotation/
  implementation-plan.md
  tasks/task-1-brief.md
  baseline-typecheck.log
  baseline-check-frontend-layers.log
  baseline-check-crate-layers.log
  baseline-check-i18n.log
  baseline-licenses-check.log
  baseline-rust-bootstrap.log
  verification/
    npm-ci.log
    version-generate.log
    baseline-typecheck-generated.log
    baseline-vitest-1.log
    baseline-vitest-2.log
    baseline-vitest-3.log
    baseline-vitest-4.log
    baseline-generated-version-rerun.log
    baseline-sync-blob-refs.log
```

`README.md`、`design.md`、`progress.md`、`acceptance.md`、`reviews/preflight.md`、`tasks/task-1-report.md` 均未创建。不要依赖未落盘的 agent 输出。

完整原方案：`docs/superpowers/specs/2026-11-02-handwriting-annotation-chat-design.md`，约 471 行。它的“设计提案/不授权实现/只新增文档”等元信息描述的是**上一轮历史状态**；本轮实施计划已获批准，但随后被用户暂停。归档时保留历史说明并附本轮批准/暂停记录，不能把历史文档改写成已实现清单。

可在恢复开发后将散落在统一目录根部的 baseline 日志整理进 `verification/` 并更新链接；当前原样保留证据，没有在交接中擅自移动/删除。

## 5. 环境与基线测试：已实际执行的结果

### 5.1 工具和依赖

- Linux / bash；Node `v22.23.4`，npm `10.9.9`。
- rustc `1.99.0 (b940084d7 2026-09-28)`，cargo `1.99.0 (5f94df478 2026-08-27)`。
- `npm ci` 成功，安装 1308 packages，应用既有 `@nvq/flowtoken@2.0.6` patch；没有新增依赖/升级锁文件。见 [日志](verification/npm-ci.log)。
- pkg-config 已核实 GTK3 `3.24.52`、WebKit2GTK4.1 `2.52.6`、libsoup3 `3.6.6`。
- Playwright 缓存目录已有 chromium-1223 / chromium_headless_shell-1223 / webkit-2287 / ffmpeg-1011；**本项目 CT/浏览器兼容性未执行**，不能把缓存存在当测试成功。
- 当时磁盘约可用 720 GiB、内存 30 GiB。不是性能/产品内存测量。
- `cargo-nextest` 未在已列出的 cargo bin 中出现；未安装。总 Rust workspace、app、agent/llm crate 测试未运行。
- 探索报告指出仓库缺 Linux PDFium；未专门加载/下载/验证。VFS 基线通过不代表完整 PDFium 渲染功能通过。

### 5.2 前端完整四分片基线

执行：在仓库根依次运行

```bash
npm test -- --shard=1/4 --maxWorkers=2 --minWorkers=1
npm test -- --shard=2/4 --maxWorkers=2 --minWorkers=1
npm test -- --shard=3/4 --maxWorkers=2 --minWorkers=1
npm test -- --shard=4/4 --maxWorkers=2 --minWorkers=1
```

| 批次 | 原始退出码 | 原始结果 | 证据 |
| --- | --- | --- | --- |
| 1/4 | 1 | 395 文件通过、3 套件加载失败；3224 tests passed | [baseline-vitest-1.log](verification/baseline-vitest-1.log) |
| 2/4 | 0 | 397 文件通过、1 文件 skipped；3070 passed / 4 skipped | [baseline-vitest-2.log](verification/baseline-vitest-2.log) |
| 3/4 | 0 | 398 文件通过；3018 passed / 5 todo | [baseline-vitest-3.log](verification/baseline-vitest-3.log) |
| 4/4 | 0 | 398 文件通过；3279 passed | [baseline-vitest-4.log](verification/baseline-vitest-4.log) |

第一片三套件失败原因相同：初始化时尚未生成 `src/version.ts`，无法解析 `@/version`（日志 443–484 行），不是 ink 改动导致：

- `tests/vitest/data-governance/DataGovernanceDashboard.error-states.test.tsx`
- `tests/vitest/data-governance/maintenance-mode.test.tsx`
- `tests/vitest/settings/OpenSourceAcknowledgementsSection.test.tsx`

查看原 `scripts/generate-version.mjs` 后执行项目既有 `npm run version:generate`，生成 `src/version.ts`，未修改脚本。随后重跑以上三套件：**3 文件 / 26 tests 全通过，退出码 0**，见 [复测日志](verification/baseline-generated-version-rerun.log)。

由四分片加失败套件复测合计：**12617 tests 通过、4 skipped、5 todo；1591 文件通过、1 文件 skipped**。这是分片+定向复测的合并证据，**没有在生成版本文件之后重新完整跑四片**，不可说“一次全套零失败”。没有修改任何既有测试。

重要脚本陷阱：当时 shell 的四片循环逐项打印退出码，却没有聚合失败；最终 `printf` 使整个 Bash 背景任务返回 0。任务通知“exit 0”**不能证明四片全绿**。未来脚本用 failure accumulator 或每条命令显式检查退出码；本次以各片日志与退出码为准。

### 5.3 类型、分层、许可与 i18n

| 检查 | 结果/边界 | 日志 |
| --- | --- | --- |
| 初次 `npm run typecheck` | exit 2，4 个 TS2307，均缺少生成版 `src/version.ts` | [原日志](baseline-typecheck.log) |
| `npm run version:generate` 后 typecheck | exit 0 | [生成](verification/version-generate.log)、[复测](verification/baseline-typecheck-generated.log) |
| `check:frontend-layers` | exit 0，“无新增违规”；仍有存量565条（208 upward-layer +357 cross-feature-deep）、7未解析 import；不能说零违规 | [日志](baseline-check-frontend-layers.log) |
| `check:crate-layers` | exit 0，25 workspace成员 | [日志](baseline-check-crate-layers.log) |
| `licenses:check` | exit 0，OK | [日志](baseline-licenses-check.log) |
| `check:i18n` 默认模式 | exit 0，但已有 zh-CN/en-US 各90个被引用键缺失（共180），默认只告警；未跑 strict，不能说无缺键 | [日志](baseline-check-i18n.log) |

日志另有 Browserslist 过期、已弃用依赖、既有 Rust warnings；没有为消除警告而升级依赖或改无关代码。

### 5.4 Rust 已执行基线

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-vfs --lib
```

**599 passed / 0 failed / 0 ignored，exit 0**。见 [baseline-rust-bootstrap.log](baseline-rust-bootstrap.log)，1578 行。首次编译成功；只证明既有 VFS 单测基线。

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-sync --lib regression_recompute_counts_json_embedded_blob_refs
```

**1 passed / 0 failed / 532 filtered out，exit 0**。见 [baseline-sync-blob-refs.log](verification/baseline-sync-blob-refs.log)，417 行。不是整个 sync crate 通过，也没有验证尚未实现的 ink 引用。

### 5.5 明确未执行

没有新增测试红/绿验证、没有 CT、没有构建/lint/strict i18n/完整 sync/agent/llm/app/workspace 回归、没有迁移测试、没有 Android 真机、没有上游 XNotes 运行、没有模型调用、没有真实 Office 转换/批注/PDF 输出测试。

## 6. 子 agent 与后台任务：全部保持停止

| 子 agent / 内部ID | 任务与终态 | 是否有新交付 |
| --- | --- | --- |
| `agent_8f4dbb4e-0483-42a1-88e6-0b809e3832d5` | 首轮存储探索完成；后来恢复作同步原子性追查，最终 Provider server error / failed | 首轮结论见第7节；追加追查无结果 |
| `agent_ed35897a-803c-4d63-9f63-885ccef3299f` | Chat只读探索 completed | 无文件，结论见第7节 |
| `agent_7765a025-f00b-4ddb-83cf-bf6227cc64b9` | 前端/测试只读探索 completed | 无文件，结论见第7节 |
| `agent_c4013a4f-73e1-4ab2-8217-db3d90a8057a` | 集中记录初始化，TaskStop成功，killed | 未写README/design/progress等 |
| `agent_389249a3-83cf-4466-bec2-c92ee70fc988` | 契约测试写入；两轮均Provider server error；最后收到 failed 终态 | 无代码/夹具/报告 |

曾出现 TaskStop 返回 `not running (status: running)` 与 TaskOutput running 的状态矛盾。用户要求停止后没有再派发或恢复；之后两项均收到明确 failed 通知。不要因旧 running 快照再去恢复它们。

`npm ci`、VFS基线、四片Vitest、基础检查、版本生成/typecheck、三套件复测、sync引用基线的 Bash 任务均已完成。交接时进程核查没有发现正在运行的 Vitest/cargo test 任务。

压缩后不要读取 agent `.output` 文件（可能为巨大完整会话），也不要循环轮询恢复。优先使用此交接和仓库文件；用户明确恢复后才新派限定子任务。

## 7. 已研究确认的关键代码与结论（无需重复全面探索）

### 7.1 存储与数据安全

- 实际 VFS crate：`src-tauri/crates/dstu-vfs/`。`src-tauri/src/dstu/handlers.rs` 是曾猜错的旧路径，真实为 `crates/dstu-vfs/src/dstu/handlers.rs`。
- `dstu_update` 的 file/image 分支（约1637行）明确拒绝二进制编辑。首次上传 JSON 不等于可持续编辑；需专用 `.dsink` 命令/服务，不能放开通用更新。
- `dstu_set_metadata` file/image分支（约3922行）只处理有限字段。不能直接加 `{ink:...}` 假设会持久化。
- `vfs/repos/blob_repo.rs`：`store_blob_with_conn`（约105）、`stage_stream`、`store_staged_blob_with_conn`、increment/decrement_ref、post-commit cleanup；内容寻址，JSON写hash不会自动引用。
- `vfs/upload_saga.rs`：`with_savepoint`（43），`UploadSaga` record/commit/abort；注意blob计数属于当前事务还是跨连接已提交，不能事务回滚后又盲目补偿双减。
- 教材OCC参考 `vfs/repos/textbook_repo.rs::replace_highlights_if_version`（约755–852）：Immediate事务+版本校验+CAS。但高亮500项/元数据512KiB，不能塞密集笔迹。
- `vfs/repos/file_repo.rs::create_file_with_conn`（69）：按sha256去重，创建resources/files；manifest必须包含独立document_id。`copy_file_with_conn`（310）现共享blob，不能直接复制相同可写文档身份。
- `file_repo` purge、`dstu/handler_utils/delete_helpers.rs`、sync `recompute_blob_ref_counts`（`dstu-sync/src/data_governance/sync/mod.rs:7386+`）都手工枚举引用。必须同时接入ink页/背景依赖；否则sync重算把引用清零，启动GC删活跃笔迹并传播删除（源码有历史数据丢失事故注释）。
- 原blob与compressed hash相等时只记一次；本地保存/复制/purge/sync重算口径必须一致。
- sync `classification.rs`：resources元数据主要row LWW，files为FieldMerge且sha256业务唯一键。**文件blob指针、hash、派生依赖清单在同步冲突后的完整一致性尚未核实**，见第9节。
- backup assets递归复制vfs_blobs、blob sync扫描目录，但这不自动证明新格式引用生命周期和恢复闭包正确。
- 不首建新表；若不能安全复用，允许当前VFS内最小schema迁移，补 `dstu-storage/src/migration/vfs.rs`、表分类、迁移/恢复fixture测试。

### 7.2 前端打开、输入与文件转换

- Workbench只桌面：`src/app/hooks/useWorkbenchMode.ts:81`，`workbenchMode && !isMobilePlatform()`；移动端经典壳不能漏接。
- 两壳共享实际文件分派：`learning-hub/apps/views/filePreviewResolver.ts::resolveFilePreviewMode` → `FileContentView.tsx`；`.dsink`专用MIME/扩展名要优先于JSON/text匹配。
- `src/dstu/editorRegistry.ts`按DstuNodeType分派，`FileViewerWrapper.tsx`仅通用查看；直接DSTU路径也要支持子格式。
- 新建入口：`learning-hub/sidebar/resourceCreators.ts`，SidebarMobileToolbar/SidebarFinderToolbar/ContextMenu；Workbench FilesAppWindow复用LearningHubSidebar。
- 不新增顶层DstuNodeType，增加文件预览子类型；通用创建factory目前排除file，需专用ink创建服务。
- 仓库无通用压感手写核心；旧 `canvas-note` 是智能文本笔记，不是手写；MindMapCanvas不应挪用。
- `src/utils/stagedUpload.ts`：8MiB阈值/4MiB块、stageBlobUpload/stagePathUpload；用其控制大图/导出IPC内存。
- 既有PDF页图：Rust `vfs/handlers.rs::read_pdf_page_image_bytes`（约2943）；前端react-pdf/pdfjs。既有regionCapture依赖可见DOM，不能充当离屏确定性renderer。
- **已有依赖 snapdom 2.0.2 和 pdfmake 0.3.13**；使用参考 `src/components/practice/paperExport.ts`（pdfmake约343）和mindmap exporters。无需新PDF/截图库。
- DOCX用docx-preview、PPTX用pptx-preview。当前只有DOM预览，不是已实现逐页转换器；XLSX是工作表，不是可靠纸张分页。Office要等待字体/图表/图片，逐完整页固化，不能只截第一屏。
- 新UI遵守 `docs/frontend/README.md`，优先于旧CODE_STYLE；`CustomScrollArea`已deprecated，不因旧壳示例继续扩散；用现有按钮、主题token和i18n。

### 7.3 Chat工具、审批与真正的视觉输入

- 技能 `src/features/chat/skills/builtin-tools/ink-tools.ts` 尚未创建。接`builtin-tools/index.ts`；embeddedTools是真正注入schema，allowedTools仅兼容元数据。
- Rust生产 roster `src-tauri/src/agent_wiring/roster.rs`；同步更新 EXPECTED_ROSTER/descriptor tests，不能只写前端提示词。
- `dstu-agent/src/chat_v2/tool_descriptors.rs`使用bare name（ink_get，不带builtin-）；定义风险/副作用/超时/能力。
- `ToolExecutor` 在agent `tools/executor.rs:798+`，存在 `sensitivity_level_for_call`（846）和 `manages_cancellation`（875），可参考实际审批/取消行为。
- `ApprovalGateHook` fail-closed，复用现有approval manager；Medium标签本身不等于安全确认。破坏性ink操作需精确作用域，防全局/分组bypass降低。
- 现有PDF工具返回image_url dataURL；通用`context.rs::tool_results_to_messages_impl`转JSON字符串，`multimodal_content=None`，并不自动入视觉。
- **可复用已有 `context_compiler/retrieval_images.rs`**：受信任检索工具本地blob解析、4图/字节预算、完整工具轮末尾插入瞬态user多模态消息（真实ImageUrl part），不必另造tool-role图像通道。
- 但retrieval图片只当前工具环瞬态，**不能原样当ink历史重放已完成**。ink产物要绑定session/tool_call/render/revision，持久化引用、live/history/多变体一致，和检索共享预算。
- `history.rs::build_tool_round_messages`（926+）与live消息对齐；Provider Anthropic/Responses对tool role当前提取text，不能仅在tool JSON放图片字段。
- UI到Chat复用 `useReferenceToChat.ts`、`context/definitions/image.ts` 和 `contextHelper.ts`；必须传新合成图片，不可仍引用原PDF。
- Rust→前端桥参考 `src-tauri/src/chat_v2/tools/canvas_executor.rs` ACR probe/apply_ops；它不是现成离屏ink渲染服务，不能取消后回落后台造成双写。

## 8. 已批准实施路线与实际进度

### 阶段 / Task 对照

| 计划任务 | 内容 | 实际进度 |
| --- | --- | --- |
| 0 | 集中记录、环境/测试基线、夹具、风险验证 | 部分完成：依赖+上述基线；记录不齐、夹具/渲染/Office风险验证未开始 |
| 1 | TS/Rust格式与验证契约 | brief已写；子agent无代码交付，未红灯验证 |
| 2 | 专用文档服务、CAS、引用闭包、复制删除同步 | 未开始 |
| 3 | 共享几何、Pointer输入、renderer | 未开始 |
| 4 | 编辑器、多页、工具栏、恢复/生命周期 | 未开始 |
| 5 | PDF/图片prepare、双壳与DSTU资源接入 | 未开始 |
| 6 | 应用级离屏桥、不可变快照、UI→Chat | 未开始 |
| 7 | 六工具、审批、草稿协调、卡片 | 未开始 |
| 8 | 工具图像真实入模、历史/多变体恢复 | 未开始 |
| 9 | DOCX/PPTX固定页、PNG/扁平PDF导出 | 未开始 |
| 10 | 全分支回归、设备/模型验收 | 未开始 |

关键设计已通过本次计划审批：固定分页（可追加页）、共享Canvas核心、VFS file子格式、按页blob+canonical manifest、非破坏性原件、AI普通文本/形状批注、本地Office预览固化、扁平栅格PDF。不要重新描述为尚未做出的选择；质量/性能仍须实测。

六工具均为必交付而非后续可选：

```text
builtin-ink_prepare
builtin-ink_create
builtin-ink_get
builtin-ink_render
builtin-ink_apply_ops
builtin-ink_export
```

Chat apply_ops首期：append_blank_page/add_text/add_rect/add_ellipse/add_arrow/add_region_highlight/update_object/remove_object；最多100项、先验证后原子提交；位置写入绑定based_on_render_id；识别不授权修改。

## 9. 当前未决技术点与已作裁决

### 9.1 Task1 brief已拟定但未实现的契约

- TS/Rust snake_case、schema1，manifest/pages/object类型。
- manifest最大1MiB；单页JSON8MiB；1–500页；尺寸1–16384；每页10000对象/100000点；文本10000字符；ID128字符；标题256字符；有界颜色/笔宽/字体、压力0..1等。
- `parse_manifest`/`validate_manifest`/`parse_page`/`validate_page` 接口、共享JSON fixture。
- 所有值在brief，压缩后直接读brief，避免再拼一份不一致字段。

**重要校正：** 原brief要求写“返回Err的最小编译stub”。若所有合法/非法路径都Err，多数拒绝类测试会立刻通过，只有合法测试红灯，不能声称负向验证被红灯证明。真正执行时将parse/validate分步TDD：先使合法解析成立并保留宽松validate，新增拒绝行为测试逐组红→绿；或用test-first缺功能路径+后续mutation证明。主agent必须逐项确认失败原因，不能把缺模块编译错误或恒Err测试当充分验证。

### 9.2 存储布局尚需一次窄范围核查

已批准：revision独立于收藏/书签updated_at，CAS基于旧manifest指针；来源回指只存稳定document ID；依赖清单是manifest的服务派生索引，与指针同事务更新。

尚未决定依赖清单放`resources.metadata_json`还是`files.preview_json.ink.blob_refs`等位置。选择前必须核查实际files FieldMerge与资源row LWW：同步后blob_hash/sha256/依赖清单不能来自不同版本；冲突败方必须保留笔迹而非静默丢弃。之前给存储agent的追加追查失败，无结果。恢复后只针对该路径探索，不需重读整个仓库。

### 9.3 其他裁决

- 现有snapdom/pdfmake满足拟议输出，不新增运行时依赖；首期不复制XNotes笔迹算法。
- 原设计允许来源背景引用；计划细化为批注文档持有固定背景字节/明确引用，防删源损坏成果。
- 模型图片采用既有合法的跟随多模态消息机制，测试Provider请求，而非假设tool role可带图。
- 已批准统一记录/主agent验收/不自动commit，覆盖技能的默认隐藏ledger/自动提交/子agent独立测试。
- 文档只读研究/交接由主agent编写不违反“业务代码由子agent修改”；恢复实施不应改成主agent直接写业务功能。

## 10. 明确恢复后推荐动作（当前不执行）

1. 用户明确恢复并完成供应商选择后，先`git status --short --branch`核对当前文件；不重建分支、不清理依赖缓存、不擅自恢复旧agent。
2. 读本交接、计划、原设计和Task1 brief。补齐集中目录README/design/progress/acceptance/preflight；把Task0标“部分完成”，不能误勾完成。
3. 先窄范围核实第9.2节同步一致性和冲突副本，不让存储设计建立在未经验证的metadata/LWW假设上。
4. 新派范围明确的Task1测试子agent；限制首次红灯批次8项（合法manifest、未知schema、未知字段、重复页、合法page、页ID不符、非法pressure、坐标越界），按第9.1节修正TDD方式。主agent亲自运行并记录红灯，再授权实现。
5. Task1通过后逐项Task2–10，相关阶段新旧回归通过才进入依赖阶段。第一重点是sync重算/GC不删笔迹，不先做UI绕过数据安全。
6. 下次全测试脚本累计失败码；生成版本元数据在类型/前端测试之前执行。保存测试证据，既有skip/todo/i18n warning不要算新引入也不要隐瞒。
7. 完整功能交付仍需浏览器像素/转换验证、app生产注册、真实Provider离线请求测试、Android真机与真实视觉模型分别验收；缺条件如实阻断，不声称全部完成。

## 11. 可复用恢复检查命令

以下供用户恢复后使用，不是交接时已重跑功能测试的声明：

```bash
cd /home/xutao/deepstudent/deep-student
git status --short --branch
git diff --check
npm run version:generate
npm run typecheck
cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-vfs --lib
cargo test --manifest-path src-tauri/Cargo.toml --locked -p dstu-sync --lib regression_recompute_counts_json_embedded_blob_refs
```

新功能测试接口/选择器以实际落盘代码为准，目前ink代码路径不存在，不要执行假定已存在的测试后将0 tests当通过。

## 12. 安全与避免重复踩坑

- 不读取/打印token、环境密钥或浏览器凭据。无远程写操作，无真实模型调用。
- 旧上游clone因网络不完整，关键源码通过固定SHA `3926304a0a2ca20b0ac259317b5e60f77d4668b1` 的只读GitHub API核查；未运行上游。无需再次clone/构建XNotes。
- 下载/解包资料不可信，每份用新空目录；脚本写在别处，路径作为参数；Python读取下载资料用`python3 -I`，不是`python`（本环境python命令不存在）。
- 文件引用使用绝对路径或workspace相对路径；外层不是Git根，所有Git命令指向内层。
- 自动通知不是用户批准，不据此恢复任务。
- 保持暂停。此交接的成功只表示记录已保存，不表示手写/批注功能完成。
