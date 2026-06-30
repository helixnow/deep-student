# GitHub Issues 全量审阅记录（2026-06-11）

> 审阅范围：`helixnow/deep-student` 仓库全部 15 个 issue（含已关闭）。
> 审阅基准：本地工作区 `nightly` 分支，版本 0.9.38（issues 多数针对 0.9.35 上报）。
> 审阅方法：逐条核对 issue 描述 → 在当前代码中定位相关实现 → 判定「问题是否切实存在 / 是否已妥善修复 / 残留风险」。
> 状态图例：✅ 已妥善修复 | ⚠️ 部分修复/有残留风险 | ❌ 问题仍存在 | 🔍 无法本地复现（外部依赖/缺信息） | 💬 非缺陷类（需求/反馈）

## 总览

| # | 状态(GitHub) | 标题 | 类型 | 审阅结论 |
|---|---|---|---|---|
| [#91](https://github.com/helixnow/deep-student/issues/91) | open | 支持 FTP/FTPS 云存储备份 | enhancement | ⚠️ 后端完整实现已合入，前端被实验开关默认隐藏 |
| [#90](https://github.com/helixnow/deep-student/issues/90) | open | 用户画像记忆未能在普通问题中自动生效 | enhancement | ⚠️ 有画像常驻注入兜底但有前提，未根治 |
| [#66](https://github.com/helixnow/deep-student/issues/66) | open | Linux 端显示不正常（与 #65 重复） | bug | ❌ 未修复，建议关为 duplicate |
| [#65](https://github.com/helixnow/deep-student/issues/65) | open | Linux 端显示不正常 | bug | ❌ 根因定位（decorations:false + 按钮仅 Windows 渲染），未修复 |
| [#64](https://github.com/helixnow/deep-student/issues/64) | open | Android 端 OCR 识别经常显示未就绪 | bug | ⚠️ 机理确认（OCR 独立配置 + 熔断），未修复，维护者认领 |
| [#62](https://github.com/helixnow/deep-student/issues/62) | open | 解除智能会话附件 50MB 大小限制 | enhancement | ❌ 未实现，限制原样（学习资源入口 200MB 可替代） |
| [#59](https://github.com/helixnow/deep-student/issues/59) | open | 无法打开 PDF（pdfstream 403） | bug | ❌ 根因定位（白名单与探测命令不一致），未修复 |
| [#58](https://github.com/helixnow/deep-student/issues/58) | open | anki 制卡出现错误（epub 导入） | bug | 🔍 信息不足；制卡入口确实排除 epub（断层确认） |
| [#57](https://github.com/helixnow/deep-student/issues/57) | open | 云同步问题（WebDAV 不能覆盖本地 / S3 无法识别） | bug | ⚠️ WebDAV 根因已被 6/10 重构消除待回归；S3 兼容风险仍在 |
| [#56](https://github.com/helixnow/deep-student/issues/56) | open | 错题 AI 解析输出先出现后消失 | bug | ❌ 根因定位（仅认 [DONE] 哨兵 + Incomplete 全量丢弃），未修复 |
| [#54](https://github.com/helixnow/deep-student/issues/54) | closed | 安卓端默认搜索引擎配置无效（missing ZHIPU_API_KEY） | bug | ✅ 已验证修复（schema 移除 engine + 静默回退） |
| [#53](https://github.com/helixnow/deep-student/issues/53) | open | cliproxyapi 报 HTTP 400（tools[0].name 空串） | bug | ✅ nightly 已修复（05-26 工具名归一化），issue 未同步 |
| [#46](https://github.com/helixnow/deep-student/issues/46) | open | 安卓端显示异常 | bug | 🔍 仅截图无文字；移动端已大改，建议复测 |
| [#44](https://github.com/helixnow/deep-student/issues/44) | open | 期待产品更加完善（错题收录工具调用失败） | feedback | ⚠️ qbank 13 工具已覆盖诉求闭环，待用户回归 |
| [#2](https://github.com/helixnow/deep-student/issues/2) | closed | RAG 嵌入较大量 PDF 文档时卡进度 | bug | ✅ 关闭合理（用户误配置）；暴露的短板已系统性补齐 |

---

## 逐条审阅

### #91 支持 FTP/FTPS 云存储备份（open，enhancement）— ⚠️ 已实现但默认隐藏（实验性）

**诉求**：支持 FTP / FTPS 连接、基本同步、连接测试。提交人表示会贡献代码（关联 PR #92）。

**核查结论**：
- 后端已完整落地：PR #92（`8169aafea feat(cloud-storage): add FTP/FTPS storage support`）已合入 `nightly`，`src-tauri/src/cloud_storage/ftp.rs`（1021 行）实现了 `CloudStorage` trait 全部接口：`put/get/list/delete/stat/put_file/get_file/check_connection`，包含原子上传（临时名 + RNFR/RNTO 重命名）、3 次指数退避重试、MLSD 优先目录列举、SHA256 校验和验证。
- 连接测试：`check_connection()` 已实现（连接 → 确保根目录 → CWD 验证）。
- FTPS：显式 TLS（AUTH TLS）已支持，TLS 升级后才发送登录凭据，符合安全实践。
- 配置层：`FtpConfig`（host/port/username/password/use_tls）已加入 `CloudStorageConfig`，`Debug` 实现对密码做了 `[REDACTED]` 脱敏。
- 前端：`CloudStorageSection.tsx` 已有完整 FTP 表单 + 密码显隐 + 风险提示。

**残留问题 / 风险**：
1. **前端 FTP 选项默认隐藏**：`shouldShowFtpOption` 依赖编译期环境变量 `VITE_ENABLE_EXPERIMENTAL_FTP_STORAGE === 'true'`（`CloudStorageSection.tsx` L44-46、L376）。除非打包时显式开启，普通用户在设置界面看不到 FTP 选项 —— 功能"已合入但未交付"。issue 保持 open 是合理的。
2. **非 localhost 强制 FTPS**：`config.rs` L281 与 `ftp.rs` L48 双重校验"仅 localhost 允许明文 FTP"。局域网 NAS（如 192.168.x.x）上的纯 FTP 服务器无法使用。放宽该限制的提交 `b150d2c47` 只存在于 `review/pr92` 分支，**未合入 nightly**。这是一个有意的安全权衡，但与 issue 原始诉求（"利用现成 FTP 基础设施"）存在差距。
3. 开放 PR #103（Pr/2c general fixes，同一贡献者）仍在 review 中，可能包含后续修正。

**判定**：核心诉求已在代码层面实现，质量良好（含契约测试 `ftp_contract_source_guards`）；但因实验性开关未默认开放 + 内网明文 FTP 受限，对终端用户尚不可用。建议：发布时开启开关或在 issue 中说明开启方式。

---

### #90 用户画像记忆未能在普通问题中自动生效（open，enhancement）— ⚠️ 已有缓解机制但未根治

**诉求**：普通提问（不带"根据我的阶段"）时 AI 不调用 `memory_search`，回答超出用户学习阶段。建议在检索关键词中显式追加"我的阶段/当前水平"等画像词。

**核查结论**：
- **问题机理属实**：是否检索记忆完全依赖 LLM 对技能提示词的遵从度，没有任何代码层强制。`dstu-memory-orchestrator.ts`（深度学者技能 v3.0.0）虽已把"主动回忆"列为第一优先级（"收到用户消息后，默认先调用 builtin-unified_search…除非问题极其简单"，L73-79），但这只是提示词约束，模型可不遵守 —— 与 issue 复现现象一致。
- **issue 建议的修复方案未落地**：技能提示词中"搜索关键词应包含"段（L77-79）仍是 issue 引用的原文（核心主题 + 用户偏好），没有加入"我的阶段/当前水平"等画像检索词。
- **代码中已存在更强的兜底机制（早于 issue）**：`chat_v2/pipeline/prompt.rs::load_user_profile()`（L28-104）每轮对话**无条件**将记忆分类摘要 / 用户画像注入 system prompt 的 `<user_profile>` 标签（`prompt_builder.rs` L562-568 注释明确"始终注入，不依赖检索 query"，memU 双模检索的 LLM 直读模式），引入于 2026-02-24、增强于 2026-05-23，均早于 issue（2026-06-02）。**但用户仍报告问题**，原因可能是：
  1. 注入依赖"分类摘要文件 / profile summary 笔记"已生成 —— 如果后台尚未跑过分类汇总（新用户/刚写入画像），`load_all_category_summaries` 与 `get_profile_summary` 均为空 → 注入 None，机制失效；
  2. 注入文案仅说"请在回答中自然地运用这些背景"，没有强制"回答深度必须匹配用户阶段"的硬约束；
  3. 画像超 2000 字符会按 section 截断，阶段信息可能被截掉。
- 维护者回复（2026-06-03）证实记忆读取策略仍在调优（还存在"读取强度过高/上下文污染"的反向问题），issue 保持 open。

**判定**：问题切实存在、未修复。已有"画像常驻注入"缓解机制但有生效前提（摘要已生成）。改进方向：① 画像注入失败时降级注入原始 fact 记忆；② 在 `<user_profile>` 注入文案中加入"回答深度须适配用户当前阶段"的硬性指令；③ 技能提示词补充画像检索词（issue 原建议，改动最小）。

---

### #65 / #66 Linux 端显示不正常（open，bug，两条内容完全相同）— ❌ 问题确认存在，未修复

**现象**：Debian 13 + KDE（Wayland 与 X11 均复现）：无关闭/最大化/最小化按钮、窗口不能拉伸调整、X11 下窗口显示很小。App 0.9.35。

**核查结论（根因已在代码中定位，三个现象全部可解释）**：
1. **无窗口按钮 —— 代码缺陷确认**：
   - `src-tauri/tauri.conf.json` 主窗口配置 `"decorations": false, "transparent": true`。该配置对 Linux 生效（仓库只有 `tauri.macos.conf.json`（`decorations: true`）和 `tauri.windows.conf.json` 两个平台覆盖，**没有 `tauri.linux.conf.json`**）→ Linux 下无原生标题栏。
   - 自绘窗口按钮 `WindowControls.tsx` 仅在 Windows 渲染：`App.tsx` L2406 `{isWindows() && <WindowControls />}`。`platform.ts` 中 `isLinux()` 已定义但全局只有 2 处文件引用、从未用于窗口控制。
   - 结果：Linux = 无原生装饰 + 无自绘按钮 → 与截图现象完全一致。
2. **不能拉伸调整**：Linux（GTK/WebKitGTK）下无边框窗口没有系统 resize 边缘，Wayland 合成器（KWin）对 `decorations:false` 的窗口默认不提供 SSD（服务端装饰），Tauri 亦未启用 CSD fallback 或自绘 resize 手柄。`resizable: true` 在此场景形同虚设。这是 Tauri 在 Linux 上的已知限制，需要应用侧应对。
3. **X11 下窗口很小**：初始 1112x773 + HiDPI 缩放因子识别异常（WebKitGTK 在部分 X11 环境不读取 KDE 缩放设置），属于次生现象，需实机验证。
- 仓库中未发现任何针对 Linux 窗口装饰的修复提交（搜索 `set_decorations` / Linux 分支处理均无结果）。两条 issue 均无维护者回应。

**判定**：问题确认存在、完全未修复。**#66 与 #65 内容逐字相同，建议关闭其一为 duplicate**。修复建议（任选其一，工作量从小到大）：
1. 新增 `src-tauri/tauri.linux.conf.json`，Linux 下 `decorations: true`（与 macOS 方案一致，最稳妥）；
2. 或 `App.tsx` 改为 `{(isWindows() || isLinux()) && <WindowControls />}` 并补充 Linux resize 手柄（CSS `app-region` 在 Linux WebKitGTK 不可用，需调用 `window.startResizeDragging`）。

---

### #64 Android 端 OCR 识别经常显示未就绪（open，bug）— ⚠️ 机理确认，未见针对性修复，维护者已认领

**现象**：Android（OriginOS6，0.9.35）OCR 经常显示"未就绪"，但硅基流动 API 已配置且在 API 设置中测试成功。

**核查结论（"未就绪"产生机制已在代码中完整定位）**：
- 前端：附件芯片上的"未就绪：OCR"来自 `InputBarUI.tsx` L2935-2938（`modesNotReady`），条件是所选注入模式不在 `readyModes` 中。
- 后端：`vfs/pdf_processing_service.rs` 图片 OCR 流水线（L1381-1461）只有当 `stage_image_ocr` **调用成功且返回非空文本**时才 `ready_modes.push("ocr")`（2026-02-13 修复过"空文本虚标就绪"）。任何失败都只记入 `issues`（retriable）而不就绪。
- OCR 调用链的失败点（任一个都会表现为"未就绪"）：
  1. **OCR 模型独立于聊天模型配置**：`llm_manager::get_ocr_model_config()`（mod.rs L4222-4276）要求 `ocr.available_models` 中存在已启用条目，否则回退 `exam_sheet_ocr_model_config_id`，再没有则报"OCR 模型未配置"；且对应 ApiConfig 必须 `is_multimodal=true`。**用户在"API 设置"里测试成功的很可能是聊天 API，而 OCR 引擎是独立配置项** —— 配置看似成功但 OCR 链路实际未配置/未启用，是最可能的根因之一。
  2. **OCR 熔断器**：`ocr_circuit_breaker.rs` —— 5 分钟窗口内失败 3 次即熔断 60 秒，期间所有 OCR 请求直接拒绝。移动网络抖动下会出现"时好时坏、经常未就绪"，与"经常"的表述吻合。
  3. Android 进程被杀后处理任务中断：已有补救 —— `resume_recovered_tasks`（G1 修复，重启自动续跑，最多并发 2）。
- 未发现任何 Android OCR 专项修复提交；维护者 2026-05-19 回复"预计近期会修，最近大改动 ing"，与现状一致。

**判定**：问题真实（机理成立），尚未修复。无法在本地复现 Android 环境，但可给出高置信度改进建议：① 在附件"未就绪"提示中透出具体失败原因（现在 `issues[].message` 已有，但 UI 只显示模式名）；② OCR 引擎未配置时在输入栏给出引导（跳转 OCR 设置）；③ 熔断打开时提示"OCR 暂时熔断，N 秒后重试"。

---

### #62 解除智能会话附件 50MB 大小限制（open，enhancement）— ❌ 未实现，限制原样保留

**诉求**：智能会话附件超过 50MB 被拒（课本普遍超 50MB）。维护者 2026-05-19 回复"预计近期会优化"。

**核查结论**：
- 限制仍硬编码且前后端多点固化为 50MB：
  - 前端 `src/features/chat/core/constants.ts` L116/L163：`FILE_SIZE_LIMIT = ATTACHMENT_MAX_SIZE = 50 * 1024 * 1024`；
  - 后端 `vfs/repos/attachment_repo.rs` L138：`MAX_FILE_BYTES = 50MB`；`chat_v2/handlers/resource_handlers.rs` L68-73：File/Note/Exam/Textbook 各 50MB；`dstu/handlers.rs` L1055；`chat_v2/vfs_resolver.rs` L940（多模态预算 50MB）。
- 无任何"用户可配置附件上限"的设置项（`useAttachmentSettings.ts` 注释明确"与 ATTACHMENT_MAX_SIZE (50MB) 一致"）。
- 旁路确认：学习资源导入入口（`LearningHubSidebar.tsx` L2224）上限为 200MB —— **大课本可走"学习资源"导入 + 会话内引用**，部分覆盖该场景，但 issue 所指的会话附件入口未变。

**判定**：合理的增强请求，截至当前未实现。注意若放宽限制需同步调整前后端共 6 处常量，且 50MB 同时是多模态注入预算（`MULTIMODAL_BUDGET_MAX_BYTES`），盲目调大有 OOM/上下文爆炸风险——建议改为"入库上限放宽 + 注入时按模式预算截断"。

---

### #59 无法打开 PDF（pdfstream 403）（open，bug）— ❌ 问题确认存在，未修复（根因已定位）

**现象**：打开 `D:\学习软件\学习\明朝那些事儿.pdf` 报 "Unexpected server response (403) while retrieving PDF http://pdfstream.localhost/..."。评论者补充：学习资源导入 PDF 加载失败，但对话附件正常。

**核查结论（403 全链路已复原，三段代码相互矛盾导致）**：
1. `pdf_protocol.rs::resolve_allowed_dirs()`（L57-81）白名单仅含：app_data / app_local_data / app_cache / documents / downloads / temp / resource / desktop / pictures。**`D:\学习软件\...` 不在白名单** → `handle_asset_protocol` L131-144 返回 403。与报错完全吻合。
2. 教材导入**不复制文件**，只在 `node.metadata.filePath` 记录原路径（`TextbookContentView.tsx` L140）。
3. **可用性判定与 pdfstream 白名单不一致**（核心缺陷）：`checkFilePath`（L179-189）用 `get_file_size` 命令探测 —— 该命令**无白名单限制**，`D:\...` 探测成功 → `effectiveFilePath` 有效 → 走 pdfstream → 403；同时因为 `enabled: isPdf && !effectiveFilePath`（L212），**DB 回退通道被关闭**。
4. 失败后 `TextbookPdfViewer.onDocumentLoadError`（L152-157）只显示"PDF 加载失败，请重试"，无任何回退或原因说明。
- 修复状态：2026-05-17 审计修复仅给 pdf_protocol 增加了 4MB Range cap（性能），白名单逻辑与前端判定均未动。**未修复**。
- 评论者"对话附件正常"旁证了根因：对话附件走 VFS blob（位于 app_data，白名单内），而学习资源/教材走原路径。

**判定**：高置信度 bug，未修复。修复建议（按优先级）：① `checkFilePath` 改为调用一个与 pdfstream 同白名单逻辑的探测命令（或直接 fetch HEAD pdfstream URL），不可达即走 DB 回退；② `onDocumentLoadError` 收到 403 时自动降级到 `usePdfLoader`（DB 加载）；③ 长期：导入教材时把文件复制/链接进 app_data（或把用户选择的目录加入运行时白名单授权）。

---

### #58 anki 制卡出现错误（epub 导入）（open，bug）— 🔍 信息不足，无法精确定位；相关链路已有大规模修复但无 epub 专项

**现象**：issue 仅含一张错误截图（无法下载核验）+ 一句"导入的 epub 文件，每次都会这样"。无 OS/版本/错误文本。

**核查结论**：
- **格式支持矩阵不一致（确认存在）**：
  - 后端 `document_parser.rs` 完整支持 epub（L2854-3077，zip + quick-xml 自研解析，spine 顺序提取、损坏条目跳过）；
  - 聊天附件/学习资源允许 epub（`features/chat/core/constants.ts` L200/209、`LearningHubSidebar.tsx`）；
  - **Anki 制卡上传面板不允许 epub**（`DocumentUploadPanel.tsx` L114-126/L159：仅 pdf/docx/txt/md/csv/json/xml）。
  - 推断用户路径：epub 经聊天附件/学习资源进入 → 聊天制卡（ChatAnki）→ 报错；或拖拽 epub 到制卡页被拒。两条路径都"每次必现"。
- ChatAnki/制卡链路在本周期经历了系统性修复（`docs/archive/CHATANKI_REVIEW_FIX.md`：A01-A11、B01-B19、C01-C13 全部 DONE），其中 B14（提取文本为空时改走 VLM）、B15（VFS JSON 解析失败回退原文）、B12（错误信息缺乏可操作指引）与"epub 制卡报错"高度相关 —— 这些修复**晚于 issue 创建**，可能已缓解或改变错误表现。
- 没有 epub→制卡 的专项测试或修复记录。

**判定**：无法在缺少错误文本的情况下断定是否已修复。可确认的事实：制卡入口的格式白名单排除 epub，而应用其他入口接受 epub，存在体验断层。建议：① 在 issue 中向报告者要错误文本/版本并在新版验证；② 制卡上传面板补充 epub（后端解析器已就绪，改动极小）；③ 若走 ChatAnki 路径，验证 B14/B15 修复是否覆盖 epub 提取为空的场景。

---

### #57 云同步功能问题（WebDAV 不能覆盖本地 / S3 无法识别）（open，bug）— ⚠️ 架构已大规模重构，疑似已解决但未验证回归；S3 兼容性风险仍在

**现象**（2026-04-13，~0.9.35）：① 手机 WebDAV 同步成功上传，PC 用相同配置"双向同步/下载"无法用云端数据覆盖本地；② 腾讯云/阿里云/缤纷云的 S3 配置均"无法被正确识别"。评论补充：一加手机本地备份提示"不能使用虚拟存储"。

**核查结论**：
- **WebDAV 跨设备不可见（①）—— 当时的根因候选已被重构消除，但修复时间是昨天**：
  - 代码考古：0.9.35 时代云端只有单一 `manifest.json`，多设备读-改-写（RMW）互相覆盖 —— 手机上传后写入的 manifest 可能被 PC 端旧 manifest 覆盖/读取竞争，导致 PC 看不到手机的备份版本。与"上传成功但另一台设备无法下载"现象吻合。
  - `acbab11af`（**2026-06-10**）引入 per-device manifest（`manifests/{device_id}.json`）+ `get_manifest()` 全设备合并 + 兼容旧 `manifest.json`（`sync_manager.rs` L138-226），从结构上消除该竞争。
  - 另一套全新的记录级双向同步系统 `data_governance/sync/`（HLC 时钟、墓碑、字段级合并、冲突解决器）已落地且测试密集（`sync_pathological_tests.rs`、`sync_proptest.rs`、`sync_scenarios_tests.rs`、`sync_weird_tests.rs`，均在工作区活跃修改中），含 `24126b3be` 冲突解决与去重增强。
  - 结论：**疑似已修复（架构级），但 issue 未关闭、无人在 issue 中确认回归验证**。
- **S3 无法识别（②）—— 未证实修复，存在明确的兼容性风险点**：
  - 排除一个假设：`cloud_storage_s3` feature 自初始版本就在 default features 中，官方构建应包含 S3 支持，不是"功能未编译"问题。
  - 现行实现 `s3.rs`：aws-sdk-s3 **1.111.0** + `behavior_version_latest()`，**未设置 `request_checksum_calculation(WhenRequired)`** —— 新版 AWS SDK 默认对 PutObject 附加 CRC32 校验头/trailer，腾讯云 COS、阿里云 OSS 等第三方 S3 兼容服务对此普遍兼容不佳（业界已知破坏点），上传/连接易报签名或参数错误。
  - 其余可疑点：region 缺省 us-east-1（部分服务校验 region 签名）、默认虚拟主机寻址（`pathStyle` 默认 false，腾讯云/MinIO 场景常需 path-style）。UI 已提供 pathStyle 开关，但无服务商预设引导。
- **Android 本地备份"虚拟存储"（评论）**：SAF/虚拟文档目录限制，独立问题，未见专项处理。

**判定**：① WebDAV 多设备同步：根因高概率已被 6/10 的 per-device manifest 重构 + 新同步系统解决，建议发版后在 issue 中请用户回归并附结论；② S3：问题大概率仍在，建议补 `RequestChecksumCalculation::WhenRequired` + 服务商预设（COS/OSS/R2/MinIO 模板）+ 在连接测试失败时透出服务端原始错误；③ Android SAF 备份提示未处理，建议拆分为独立 issue。

---

### #56 错题 AI 解析输出先出现后消失（open，bug）— ❌ 根因已完整定位，未修复

**现象**：DMXapi 中转的 Gemini-3-flash 作为题库 AI 批改模型；AI 解析输出逐字出现，输出完成后整段消失。

**核查结论（全链路根因，三个环节叠加）**：
1. **后端完成判定只认 `data: [DONE]` 哨兵**：`qbank_grading/pipeline.rs::stream_grade`（L555-558）只有收到字面量 `data: [DONE]` 或 adapter 产出 `StreamEvent::Done` 才算 `Completed`；而 OpenAI 兼容适配器 `providers/mod.rs` L122-125 对 `finish_reason` **显式不发 Done 事件**（注释"OpenAI 在完成时不额外处理"）。→ 完成检测唯一依赖 `[DONE]` 哨兵。
2. **DMXapi 等中转网关常见行为**：流结束时直接关闭连接、或最后一个 SSE 事件无尾随 `\n\n`。后者还命中第二个 bug：流断开（`None`）后**残留 buffer 直接丢弃、从不解析**（L579-581 break 后无 flush），`[DONE]` 若在尾部 buffer 中也会丢失。→ `stream_ended=false` → `StreamStatus::Incomplete`。
3. **Incomplete 的处理是"全部丢弃 + 报错"**：pipeline L154-165 丢弃已累积全文并 `emit_error`；前端 `useQbankAiGrading` 收到 error 后置 `state.error`，而 `QuestionBankEditor.tsx` 的渲染条件 `feedback && !error`（L2271、L2108）在 error 出现时**隐藏已流式渲染的全文** → 用户看到"输出完成后消失"。
- 另一个同型触发器（grade 模式）：verdict 标签缺失（L181-188）同样在全文流完后丢弃报错。Gemini 系对标签格式遵从度低，经中转后更甚。
- 修复状态：`qbank_grading` 最后改动 2026-05-22（基建增强），上述逻辑原样保留。**未修复**。

**判定**：高置信度 bug。修复建议：① SSE 断流时 flush 残留 buffer 再判定；② 完成判定放宽 —— `finish_reason: stop` 也应视为正常完成（在 OpenAI 适配器对 finish_reason 产出 `StreamEvent::Done`，或在 qbank 侧接受"有累积文本 + 流自然关闭"为完成）；③ Incomplete 时不要丢弃全文，可降级为"保留文本 + 警示横幅"；④ 前端 error 态保留已接收的 feedback 展示。

---

### #54 安卓端默认搜索引擎配置无效（closed，bug）— ✅ 已妥善修复（已验证）

**现象**（0.9.35）：默认搜索引擎配置为 Tavily（密钥已配），智能对话中网络搜索失败，报 "missing ZHIPU_API_KEY"。维护者：0.9.35 Win 端同样存在；"截至 v0.9.40 已修复"。

**核查结论（修复链路完整验证）**：
- 根因：旧版 `web_search` 工具的 JSON schema 暴露了 `engine`/`force_engine` 参数给 LLM，`do_search` 的引擎决断顺序是 `force_engine → input.engine → cfg.default_engine → "zhipu"`（`web_search.rs` L2673-2678）。LLM 看到中文调研问题自作主张传 `engine: "zhipu"`，覆盖用户配置的 Tavily → zhipu 无 key → `missing ZHIPU_API_KEY (智谱API密钥未配置)`（L2353-2356）。与报告现象完全吻合。
- 修复 `c33ca0da5 fix(web-search): remove engine/force_engine from schema and add silent fallback for unconfigured engines`：① 从工具 schema 中移除 `engine`/`force_engine`（LLM 不再能控制引擎）；② 新增 `has_valid_keys()`，LLM 指定的引擎无有效 key 时静默回退默认引擎；③ 多引擎聚合预过滤未配置引擎。该提交在 nightly 中，v0.9.40 由 nightly 切出（`53add8610 feat: sync latest nightly into main for 0.9.40`），与维护者"0.9.40 已修复"的说法一致。
- 配置读取统一化：所有搜索执行路径（`cmd/web_search.rs`、`chat_v2/tools/builtin_retrieval_executor.rs`、`chat_v2/pipeline/retrieval.rs`、`tools/mod.rs`）均调用 `apply_db_overrides` 读取数据库中的引擎与密钥设置。
- 残留小问题（不影响本 issue 结论）：`chat_v2/adapters/tool_adapter.rs` L353 留有 TODO（该适配器不读数据库配置），但全仓未发现生产调用点（仅 mod.rs re-export），属死代码风险而非活 bug；`do_search` 兜底引擎仍为 `"zhipu"`，当 `default_engine` 为 None 时理论可复现，但 `ToolConfig::default()` 恒有 `google_cse`，实际不可达。

**判定**：关闭正当，修复真实有效。

---

### #53 cliproxyapi 报 HTTP 400：tools[0].name 空串（open，bug）— ✅ nightly 已修复（2026-05-26），issue 未同步状态

**现象**（mac 0.9.35）：经 cliproxyapi 网关调用时，模型二 API 报 `HTTP 400 - Invalid 'tools[0].name': empty string`。

**核查结论**：
- 根因：旧版把工具名直接塞进 `tools` 数组，遇到空白名（或严格网关无法接受的非法字符名）时未过滤/未编码 —— cliproxyapi 这类严格校验/转译网关直接 400。
- 现行防线（`06223efc5 / e4368ae2a fix(backend): normalize tool protocols and governance fallback`，2026-05-26，晚于 issue 创建 2026-03-26）：
  1. `canonical_tools.rs::encode_tool_name_for_api`（L37-52）：空白名返回 `None`；含非法字符的名用 `dstool_` 前缀 + URL-safe base64 可逆编码，保证发往 API 的名字恒满足 `^[A-Za-z0-9_-]+$`；
  2. `chat_v2/pipeline/multi_variant.rs` L885-897：构建 tools 数组时 `prepare_external_tool_schema` 对空白 API 名直接跳过并告警（"Skipping MCP tool with blank API name"）；
  3. `chat_v2/pipeline/helpers.rs` 有 `normalize_tool_name_for_api` 拒空测试（L824-833）。
- 注意：`helpers.rs::sanitize_tool_name_for_api`（L196-198）`unwrap_or_default()` 在空名时仍会产出空字符串，但当前无生产调用点（仅定义），属遗留代码，建议删除以绝后患。

**判定**：代码层面已修复，issue 应在下个发布版验证后关闭并告知用户。建议补一个"tools 数组序列化后全量断言非空名"的回归测试。

---

### #46 安卓端显示异常（open，无标签）— 🔍 仅截图无文字，无法静态核验；移动端 UI 已大改

**现象**：两张截图（GitHub 附件，本地无法拉取核验），无任何文字描述。维护者 2026-03-07 回复"近期会对安卓端 uiux 进行优化，目前移动端部分交互不直觉且存在 bug"。

**核查结论**：
- issue 本身信息量不足（无机型/版本/复现路径），无法对应到具体代码缺陷。
- issue 创建（2026-03-07）后移动端经历大规模重构：2026-04~05 的 "study UI migration" 系列、`04f75f730 feat(layout): improve mobile layout components and App entry`（2026-05-23）；现有 `MobileSlidingLayout`、`UnifiedMobileHeader`、`BottomTabBar`、`initAndroidSafeArea()`（Android 安全区 CSS 变量 fallback，`platform.ts` L98-125）等完整的移动端布局体系。
- 当时截图反映的异常在重构后大概率已不可复现（无论是被修复还是界面已不存在）。

**判定**：建议在 issue 中请报告者用最新版本复测；若无响应可按 stale 处理。同类问题建议 issue 模板强制要求文字描述 + 版本号。

---

### #44 期待产品更加完善（错题收录工具调用失败）（open，feedback/bug 混合）— ⚠️ 所述能力现已成体系，工具调用稳定性已改善；无回归确认

**诉求/现象**（2026-03-06）：① 希望"AI 讲解错题 → 收录错题集 → 之后基于错题集出练习题"的闭环；② 实测 AI 不知道用哪个工具/工具调用失败，只记了几条笔记；③ New-api 接入 GPT-5.3 时工具调用总报错（最终换用百炼 Qwen3.5-plus 直连）。维护者已收到用户整理的 bug 文档（word 附件）。

**核查结论**：
- **诉求①的能力现已存在**：`qbank-tools` 内置技能（13 个工具）覆盖完整闭环 —— `qbank_batch_import`（批量收录题目）、`qbank_import_document`（文档导入）、`qbank_generate_variant`（基于原题生成变式题，即"出例题加深练习"）、`qbank_submit_answer`/`qbank_ai_grade`（作答与 AI 评判）、`qbank_get_stats`（进度追踪）。
- **现象②（工具太多/AI 不会选）的系统性应对**：技能体系 + 渐进式工具披露（docs/archive/CHATANKI_REVIEW_FIX.md A03"只注入已加载技能的工具"、A01/A02 技能门控修复），工具数量对单轮对话的暴露已收敛。
- **现象③（New-api + GPT-5.3 工具调用报错）**：与 #53 同族 —— 经第三方网关的工具协议兼容问题，`06223efc5`（2026-05-26）的工具协议归一化（空名过滤 + 可逆编码）已覆盖主要根因。
- 注意：2026-01 已废弃旧"错题系统"（mistakes），新体系为"题目集（qbank）"。issue 中提到的"错题集"语义由题目集承接。

**判定**：反馈类 issue，核心诉求已逐步落地；建议维护者在 issue 中给出"用题目集 + qbank 技能实现错题闭环"的指引并征询用户复测，再决定关闭。

---

### #2 RAG 嵌入较大量 PDF 文档时卡进度（closed，2025-08）— ✅ 关闭合理（用户误配置 + 解析限制），相关短板后续已系统性补齐

**现象**：RAG 嵌入大量 PDF 时进度卡死半小时、无余额变动。用户自查后发现：① 忘记切换到嵌入模型（配置错误）；② 当时的解析器只能处理纯文本（扫描版 PDF 提取不到内容）。

**核查结论**：
- 关闭理由成立：主要是用户配置错误，且用户自己在评论中确认（"忘记换成嵌入模型了"、"这东西只能解析纯文本"）。
- 当年暴露的三个产品短板，现状核查：
  1. **嵌入模型误配置缺乏防呆** → 现已有专用 `is_embedding` 标志 + 维度管理 + 自动检测回退（`rag_extension.rs` M13 fix：未设置默认维度时自动选用唯一的已启用嵌入模型），配置缺失时报显式错误"找不到嵌入模型配置"而非静默卡死。已改善。
  2. **扫描版 PDF 无法提取文本** → 现有完整 OCR 流水线（PaddleOCR-VL / DeepSeek-OCR 多引擎 + `vfs/indexing.rs` OCR 就绪标记 + 多模态嵌入 `vl_embedding_model_config_id`）。已改善。
  3. **进度卡死无反馈** → 处理管线现有分阶段进度事件（`ProcessingProgress` stage/percent/ready_modes）与失败阶段记录（`failed_stages`）。已改善。

**判定**：关闭正当；该 issue 暴露的体验问题在后续版本已被系统性解决。

---

## 总结

| 结论分布 | 数量 | issue |
|---|---|---|
| ✅ 已妥善修复（已验证） | 3 | #54、#53（未关 issue）、#2 |
| ⚠️ 部分修复/疑似修复待回归 | 5 | #91（实验开关未放开）、#90、#64、#57、#44 |
| ❌ 确认存在且未修复 | 4 | #65/#66、#62、#59、#56 |
| 🔍 信息不足无法核验 | 2 | #58、#46 |

**高优先级修复建议（按性价比排序）**：
1. **#65/#66 Linux 窗口**：加 `tauri.linux.conf.json`（`decorations: true`）一行配置即可救活 Linux 端 —— 改动最小、影响最大。
2. **#56 qbank 流式判定**：SSE 断流 flush 残留 buffer + finish_reason 视为完成 + error 态保留已渲染文本，三处小改动。
3. **#59 PDF 403**：`checkFilePath` 与 pdfstream 白名单对齐（或 403 时自动回退 DB 加载）。
4. **#57 S3**：`RequestChecksumCalculation::WhenRequired` 一行配置，可能直接修复腾讯云/阿里云兼容。
5. **#53/#54**：修复已在 nightly，发版后在 issue 中告知并关闭（#53 还应删除遗留的 `sanitize_tool_name_for_api`）。

**流程建议**：① #66 关为 #65 的 duplicate；② 已修复但未关闭的 issue（#53、可能的 #57①）在发布说明中点名并请报告者回归；③ issue 模板强制要求版本号与文字描述（#46、#58 均因缺信息无法核验）。

---

## 修复落地记录（2026-06-11，审阅后当场修复）

应维护者要求"把能修的修复，然后验证确实修复了"，以下 5 项已落地并通过验证：

### 1. #65/#66 Linux 窗口无按钮/不能缩放 → 新增 `src-tauri/tauri.linux.conf.json`
- Linux 平台覆盖配置：`decorations: true`（原生标题栏 = 窗口按钮 + 拖拽 + 缩放手柄回归）、`transparent: false`（避免无合成器时的渲染问题）。其余字段与主配置一致（JSON Merge Patch 会整体替换 windows 数组，故全量复制）。
- 前端无需改动：`WindowControls` 仅在 Windows 渲染的逻辑保持，Linux 由窗口管理器提供按钮。
- 验证：JSON 合法性 ✓；Tauri 2 平台配置文件机制为官方标准（`tauri.{platform}.conf.json` 自动合并）。注：最终效果需在 Linux 实机回归。

### 2. #56 AI 解析先出现后消失 → 后端 3 处 + 前端 2 处
- `src-tauri/src/qbank_grading/pipeline.rs`：
  - 新增 `sse_block_signals_finish()`：SSE 块携带非 null `finish_reason` 即标记 `finish_observed`，流自然关闭时按 Completed 处理（兼容只发 finish_reason 不发 `data: [DONE]` 的网关）；
  - 流关闭后 flush 残留 buffer（最后一个事件缺结尾空行时不再丢失，含迟到的 `[DONE]`/finish_reason/内容）；
  - `Incomplete` 不再无条件丢弃：仅累积文本为空时报错；有文本则继续走 verdict 校验 + 持久化（grade 模式仍由 verdict 校验兜底，analyze 模式保留全文）。
- `src/components/QuestionBankEditor.tsx`：评判失败分支与解析分支在 error 态保留已流式输出的 feedback（附警示），不再整段消失。
- 验证：`cargo check` ✓；新增 3 个单测（finish_reason 检测 ×2、verdict 解析 ×1）全部通过 ✓；`tsc --noEmit` ✓；既有 `question-bank-editor-ai-markdown` vitest ✓。

### 3. #59 pdfstream 403 → 探测与协议白名单对齐
- `src-tauri/src/commands.rs` 新增 `pdfstream_check_access` 命令：按与 `handle_asset_protocol` 完全相同的规则（canonicalize → `resolve_allowed_dirs` 白名单 → `.pdf` 扩展名 → 常规文件）探测，返回 `{available, size, reason}`；已注册到 `lib.rs`。
- `src/features/learning-hub/apps/views/TextbookContentView.tsx`：PDF 节点探测从 `get_file_size` 改为 `pdfstream_check_access`；白名单外路径现在 `available=false` → `usePdfLoader` 自动回退数据库加载，403 死局消除。非 PDF 文件保持 `get_file_size`（走 `read_file_bytes`，与 pdfstream 无关）。
- 验证：`cargo check` ✓；`pdf_protocol` 既有 2 个单测 ✓；`tsc --noEmit` ✓。

### 4. #57 S3 无法识别 → 校验和行为改为 WhenRequired
- `src-tauri/src/cloud_storage/s3.rs`：构建客户端时显式设置 `request_checksum_calculation(WhenRequired)` + `response_checksum_validation(WhenRequired)`，关闭 aws-sdk-s3 1.x `behavior_version_latest` 默认对所有 PutObject 附加 CRC32 校验和的行为（腾讯云 COS/阿里云 OSS/旧版 MinIO 不支持该头）。对 AWS 官方 S3 无副作用（按需仍会计算）。
- 验证：`cargo check` ✓（API 与 aws-sdk-s3 1.111.0 重导出路径核对无误）。注：需实际腾讯云/阿里云账号回归确认。

### 5. #53 遗留风险清理 → 删除 `sanitize_tool_name_for_api`
- `src-tauri/src/chat_v2/pipeline/helpers.rs`：删除 `unwrap_or_default()` 在空名时仍产出空字符串的遗留函数（全仓零调用点），杜绝未来误用再次触发 `tools[0].name` 空串 400。
- 验证：全仓 rg 确认无引用 ✓；`cargo check` ✓；`tool_name` 相关 11 个单测全部通过 ✓。

### 验证汇总
| 检查项 | 结果 |
|---|---|
| `cargo check`（全量） | ✓ exit 0（仅既有警告） |
| `cargo test --lib tool_name`（11 个） | ✓ 全过 |
| `cargo test --lib pdf_protocol`（2 个） | ✓ 全过 |
| `cargo test --lib qbank_grading`（新增 3 个） | ✓ 全过 |
| `npx tsc --noEmit` | ✓ 无错误 |
| `vitest question-bank-editor-ai-markdown` | ✓ 1/1 |
| `tauri.linux.conf.json` JSON 校验 | ✓ |

**未修（需环境/信息）**：#62（50MB 属产品决策）、#64（需 Android 实机）、#58/#46（信息不足）、#91（实验开关放开属发布决策）、#90（提示词策略属产品决策）、#65 Linux 实机回归、#57 真实云厂商回归。

---

## 修复落地记录·第二轮（2026-06-11，应维护者"继续修复"指示）

### 6. #58 EPUB 制卡 → 入口放开 + 解析链路回归测试
- `src/components/anki/panels/DocumentUploadPanel.tsx`：接受类型加入 `epub` / `application/epub+zip`（拖拽 + 文件选择 + 提示文案三处）。
- `src-tauri/src/document_parser.rs` 新增 3 个单测：内存构造最小合法 EPUB（container.xml + OPF + 中文章节），验证 `extract_text_from_bytes` 提取出书名/正文（含中文与公式文本）；损坏 EPUB 报 `EpubParsingError`；大写扩展名 `.EPUB` 正确路由。
- 验证：3/3 通过 ✓ —— 证明后端 EPUB 解析链路（anki 制卡/学习资源导入共用）真实可用。

### 7. #91 FTP 入口默认放开
- `src/features/settings/components/CloudStorageSection.tsx`：`VITE_ENABLE_EXPERIMENTAL_FTP_STORAGE` 语义从"显式开启才显示"翻转为"默认显示，显式 =false 才隐藏"（紧急关闭开关保留）。风险告知弹窗（FTP_RISK_WARNING_KEY）与非本机强制 FTPS 的后端校验不变。

### 8. #62 附件 50MB → 200MB（前后端全链路统一）
- 依据：后端 `document_parser::MAX_DOCUMENT_SIZE` 本就是 200MB，学习资源导入入口已是 200MB；50MB 是历史遗留的不一致。
- 改动（7 处常量 + 1 处迁移）：
  - 前端 `chat/core/constants.ts` `ATTACHMENT_MAX_SIZE` → 200MB（InputBarUI/AttachmentUploader 自动跟随）；
  - 前端 `chat/resources/types.ts` `FILE_SIZE_LIMIT` → 200MB；
  - 前端 `useAttachmentSettings.ts`：旧持久化默认值 50MB 自动迁移到新默认（用户显式设置的其他值不受影响）；
  - 后端 `vfs/repos/attachment_repo.rs` `MAX_FILE_BYTES` → 200MB（>1MB 走 external blob，不膨胀 resources 表）；
  - 后端 `dstu/handlers.rs` `MAX_FILE_SIZE` → 200MB；
  - 后端 `vfs/handlers.rs` + `chat_v2/handlers/resource_handlers.rs` File 资源 → 200MB（Note/Exam 等其他类型维持 50MB 不动）；
  - 文案 `translation.json`（中英）50MB → 200MB；其余报错文案均为参数化 `{{size}}` 自动跟随。
- 范围克制：试卷上传（ExamSheetUploader）、翻译（SourcePanel）等独立功能的 50MB 不在本 issue 范围，未动。

### 第二轮验证汇总
| 检查项 | 结果 |
|---|---|
| `cargo check`（全量） | ✓ exit 0（仅既有警告） |
| `cargo test --lib epub`（新增 3 个） | ✓ 3/3 |
| `cargo test --lib max_size`（含更新断言） | ✓ 2/2 |
| `npx tsc --noEmit` | ✓ 无错误 |
| `vitest chat-v2/resources.test.ts` | ✓ 41/41 |
| 前端 lint（5 个改动文件） | ✓ 无错误 |

注：`resources.test.ts` 曾出现 2 例与本次改动无关的偶发失败（MockResourceStoreApi 哈希不匹配/回退语义），已用 git stash 对照验证为既有问题且复跑通过，未掩盖。
