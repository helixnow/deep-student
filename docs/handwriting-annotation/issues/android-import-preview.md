# Android 导入后不支持预览：调查记录

- 日期：2026-11-03。
- 状态：**新ARM64测试包已保留数据安装到真机，预览／手写业务尚未完成真机复验。** 用户2026-11-04随后明确要求模拟器与实机测试，官方mobile-slim ARM64 release／x86_64 debug构建均成功；新版ARM64实际安装字节已核。用户进一步要求“抓取实机测试bug”，已完成只读取证；设备全程锁屏，现有日志未提供可定位的业务故障栈。重复资源ID异常仍为未关联线索，见第7节。工作副本导入描述／原位修复链已有自动回归，不得扩大为自建SAF真机通过。最新主验和源码状态见 [唯一实施交接](../HANDOFF-IMPLEMENTATION.md)。
- 范围：用户授权读取手机日志；仅核对安装身份、应用专属日志和脱敏无障碍字段，不读取文档正文、个人聊天、应用数据库或密钥。

下文第1–4节及第6节保留调查时的旧包／旧源码事实和当时建议，不将“待复现／未实施”当成当前自动修复链仍未开始；当前实现与最新主验以唯一交接为准。

## 1. 用户反馈与主 agent 实际观察

用户反馈：真机已连接，PDF 等文件导入正常，但打开提示不支持预览。

| 项目 | 本轮事实 |
| --- | --- |
| 平台 | ARM64，Android16／API36 |
| 已安装应用 | `com.deepstudent.app`，versionName0.11.0／versionCode214586，minSdk24／targetSdk36 |
| 实际安装 APK SHA256 | `6ed3018626f39f99c2a5d2123ba170f843b4f273f276282a3c3cdc2e6e6254bf`，与上轮最终测试 APK 完全一致 |
| 应用状态 | 最初未运行；主 agent 启动既有 MainActivity，没有重装、强停、清数据或改配置 |
| 页面 | 启动后资源库 `learning-hub-app`／`split-left` 的无障碍树含“此文件类型不支持预览” |
| 失败项 MIME | `application/octet-stream` |
| 失败项显示名 | 无扩展名；非单纯数字／常见 opaque-ID 形式；没有记录其值 |
| 显示大小 | 362.5 KB；只证明界面有非零大小，**不证明原始内容完整或确为 PDF** |
| 应用日志 | 对当前应用 PID 的限定采样未见该提示或先前 `DOMException`／`InvalidStateError`／`FATAL EXCEPTION`／ANR 标记；有应用日志可读，但 release 包没有可用的逐步前端预览日志 |

手机序列号、个人文件名、路径、截图和原始日志没有保存到本记录。无障碍采样仅输出固定导航词、MIME／扩展名布尔值、技术容器身份和大小；不是对个人文件内容的分析。期间一次 UID 限定查询只有少量系统行，后续改用应用实际 PID，因此不以 UID 查询空结果证明“没有错误”。

## 2. 直接失败原因：已确认

提示词来自 `src/locales/zh-CN/learningHub.json` 的 `file.noPreview`，生产出口为：

- `src/features/learning-hub/apps/views/FileContentView.tsx:159–170`：从节点 metadata 取 MIME，缺失时默认 octet-stream，然后调用 `resolveFilePreviewMode`。
- `src/features/learning-hub/apps/views/filePreviewResolver.ts:35–94`：`.dsink` 特例后，依次使用有效 previewType、MIME 和扩展名推断；均不成立则 `none`。
- `FileContentView.tsx:915–941`：未进入格式渲染分支后显示 `file.noPreview`，并展示名称／MIME／大小。

真机失败项具有 **octet-stream + 无扩展名**，与该出口一致。故本次现象首先是**缺少可用类型信息后的前端分派失败**，而不是已进入 PDF renderer 后的 PDFium／Worker 报错。预览错误也不是先前已修的保存后 ImageBitmap 异常。

尚未读到真实 `previewType` 或 canonical DB 行；不能把“已确认分派失败”扩大成“已确认每个导入 PDF 都由同一路径造成”。

## 3. 导入端的高可信原因：代码确认，现场尚待复现

### 数据链

1. `src/features/learning-hub/sidebar/importActions.ts:83–99`：先以 `extractFileName(path)` 的扩展名将文件分成 document／image／other。
2. `src/utils/fileManager.ts:17–25`：仅解码 URI 最后一段；不能从 SAF 的不透明 document ID 得到 `DISPLAY_NAME` 或 MIME。该文件虽能识别 opaque ID，当前分流处没有解析真实 metadata。
3. 只有 document 组调用 `textbookDstuAdapter.addTextbooks`。`src-tauri/src/cmd/textbooks.rs` 使用现有 `resolve_file_info`，后者可按内容 magic bytes 识别 PDF／OOXML 等。
4. other／image 组走 `stagePathUpload`。`src/utils/stagedUpload.ts:122–124` 与 `src-tauri/crates/dstu-storage/src/staged_upload.rs:482–505` 只返回 `{uploadId,size}`，未返回解析后的文件名／MIME。
5. `importActions.ts:220–241` 再从原 URI 名称推 MIME，失败使用 octet-stream，进入 `attachmentDstuAdapter.createFromStagedUpload`。
6. `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:1352–1444` 普通附件分支沿用传入 MIME／名称，没有补充分辨类型。
7. `src-tauri/crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs:414–453` 仅凭 PDF MIME 或 `.pdf` 名称提升为 Textbook；其余依 files.type／名称派生节点与 previewType。

这意味着：**SAF 返回不透明 URI → 扩展名分流失败 → 绕过已有 native 类型识别 → octet-stream 落库 → 无法预览**，在现有源码中是一条可达链。

### 仍不确定的部分

- 未重放本次导入动作，尚不知道失败项来自哪个 provider／URI 形状。
- 未读取失败文件 bytes，不知道它是否确为 PDF、是否完整。
- 用户报告“PDF 等”不能替代逐格式验收；DOCX／PPTX／图片与未知二进制必须分别验证。
- 可能还有 `UnifiedAppPanel` 显式 type hint、旧资源 metadata 丢失或原有错误条目去重返回等因素；正常后缀夹具若也失败，应继续查这些，而不是继续强化 SAF 假设。

## 4. 调查时的建议设计（历史；当前实现见交接）

### 新导入：在分流之前修正元数据

优先复用 `unified_file_manager::{resolve_file_info,detect_extension_from_magic,open_read_stream}` 和既有流式暂存，不在 WebView 读整文件或 base64 往返。

- 增加受控 native 描述解析结果，供 `importPathsIntoLibrary` 在分类前得到 resolved name／MIME／extension／resource kind。
- Android 可用 provider 的 DISPLAY_NAME／MIME 时读取；octet-stream／无后缀时按有界内容头及现有 ZIP 子类型检测补充。provider 信息和扩展名都不是安全可信内容证据，解析器仍独立验证格式。
- PDF／OOXML 等进入原有 document 通道，图片进入 image 通道，未知二进制保留普通 file 并明确不支持；不能把所有 octet-stream 猜成 PDF。
- 后端普通附件入口补一致的有限格式识别，避免其他调用方再次写错类型；只共享必要检测 helper，不建设新的导入框架。
- 保持媒体流式导入、暂存所有权／取消清理、50MiB image／200MiB file 等现有预算，不重读大文件到 WebView。

### 已导入条目：必须同时闭环

只修新导入会留下当前手机已有的坏条目。增加按单一资源显式触发的“重新识别类型／重试预览”路径：

- 从本地已有 blob 有界识别，保留 file/resource ID、bytes、hash、文件夹、收藏和引用；不要求删除后重新导入。
- 只更新实际需要的 MIME／内部文件类别／派生 preview 信息；显示名不擅自覆盖用户改名，确认是无意义导入名时才补充可用名称。
- 经现有仓库业务 API／事务发出更新，纳入同步／派生索引一致性。不直接用 ADB SQL 改用户数据，不后台全库扫描。
- 无法可靠识别／blob 缺失／损坏时明确区别显示，不假成功、不覆写原 bytes。

## 5. RED→GREEN 与真机验收

| 层 | 必须证明 |
| --- | --- |
| 前端导入分流 | provider 返回 opaque URI，但 native 描述是 PDF／图片／DOCX 时进入正确通道；普通路径／带编码文件名仍正确；未知文件仍 unknown |
| native 描述／暂存 | `%PDF`、PNG/JPEG/WebP、OOXML ZIP、未知／截断／畸形容器的有界识别；拒绝／取消不泄漏临时文件，不把全部 ZIP 当 DOCX |
| 真实 VFS | MIME／type／previewType 与文件字节一致；create→get→list→open 不掉类型；去重遇旧错 metadata 不继续返回无法预览的旧状态 |
| 旧条目重识别 | ID／hash／原文件／目录／引用不变，重试幂等；失败无写入、同步镜像一致 |
| UI／CT | 导入后实际显示 PDF 页／图片／Office 内容，而不是仅断言 import success；未知格式仍显示诚实的 unsupported |
| 真机 | 同一份自建 PDF 分别走正常后缀与 Downloads/文档 provider opaque SAF；PDF 至少2页，另测 PNG、DOCX、PPTX；打开、翻页、进入批注、保存重开。旧错条目原位重识别后可开，不清数据 |

首次自动化失败必须由主 agent 观察；mock 描述结果测试不替代 native 内容检测或真实 SAF。验收不使用个人文档、不调用模型。修复代码、构建和新包安装需要在后续批准的实施阶段执行。

## 6. 本轮停止点

本节保留2026-11-03调查停止点：当时只完成定位记录与建议，没有修复代码或运行回归。后来源码实施／本地验收见唯一交接，2026-11-04新包和取证事实见下节，不以此历史段落覆盖当前状态。

## 7. 2026-11-04新包与实机bug抓取

用户先明确要求“进行安卓虚拟机测试，实机测试”，随后要求“抓取实机测试bug”。此阶段不提交Git、不调用模型、不读取个人数据库，也不清理手机或绕过锁屏。

### 实际包与可复现基线

- 官方 `mobile-slim` ARM64 release构建exit0，1075.39s；x86_64 debug构建exit0，1137.49s。两次 `source_unchanged=true`，仍为142文件rows SHA `eba6986aa0751df9c418ebe1b30aa492cfda33f1d318d2537d5812da4267bda9`。
- 受控 `SafPermissionPlugin.kt` 已同步到生成项目；新ARM64包含 `resolveFileInfo` 方法。未重建／清空原生生成目录。
- ARM64新APK为136,158,468 bytes，SHA256 `94c0c769d2eb44cc945590bacbb23d4fd1e5e397da4388d79cfb2fbe1da17174`；versionName0.11.0／versionCode214586，minSdk24／target36，沿用既有测试证书，签名／ARM64 ABI／ELF和ZIP16KiB／主库体积护栏通过。已 `install -r` 保留数据更新真机，重新读取安装APK核SHA相同。
- API36模拟器先用旧包经真实系统DocumentsUI导入自建2页PDF，主agent实际观察到 octet-stream＋unsupported，已保留脱敏RED。**新x86_64包尚未验签／安装／复验，旧条目原位修复仍待执行**。

### 抓取事实与边界

| 证据 | 实际结果 |
| --- | --- |
| 真机当前界面 | 设备锁屏，不能读取应用内错误页面；不保存锁屏截图或个人文字 |
| 应用专属保留日志 | UID限定928行；未见所筛选的panic、SQL错误、Ink typed error、未捕获异常、OOM或ANR特征。只说明该日志范围没有命中特征，不证明前端没有故障 |
| 重复异常线索 | `No package ID ff found for resource ID 0xffffffff.` 共6次，15:58:40.016—16:00:38.881；无对应栈。只证明系统资源查询异常，未证明调用方、用户操作或与Ink故障相关 |
| 历史进程退出 | 当前可见主进程退出原因是11-04 PACKAGE UPDATED与11-03 USER REQUESTED／FORCE STOP，没有可见CRASH／ANR退出记录；不是全历史无崩溃证明 |
| 实时窗口 | 16:13:29—16:16:29，180.24s，15次状态采样均锁屏，未捕获新错误事件或应用错误提示；**复现阻断，不是GREEN** |
| WebView | `com.google.android.webview` 138.0.7204.179，仅记录版本，未更改 |

release中WebView console经生成 `Logger.shouldLog()` 的 `BuildConfig.DEBUG` 门禁不输出logcat（`src-tauri/gen/android/.../generated/Logger.kt:85–86`）。前端错误另经 `report_frontend_log` 写DebugLogger私有日志，默认控制台转发关闭（`src-tauri/crates/dstu-platform/src/debug_logger.rs:410–438`）。因此日志无JS异常不能推导页面无异常，也不能凭系统资源ID消息直接修改业务代码。

现有安全的下一取证入口是 **设置 → 常规 → 诊断和反馈 → 分享ZIP**，保持“包含详细AI请求日志”关闭（默认false）。设置页实现在 `src/features/settings/components/GeneralTab.tsx:380–452`；默认诊断包收集应用日志，过滤凭据／路径与JSON用户内容，不包含数据库／用户文档（`src-tauri/src/diagnostics.rs:113–197,226–274`）。导出仍需解锁并确认实际页面；未触发分享或发送至任何外部服务，不保证脱敏器能覆盖任意自由文本。取得ZIP后仍应只提取错误技术字段，不全文输出。

**当前结论：已抓到异常线索，尚未确认真机业务bug根因。** 下一步需设备解锁并停留在故障页／复现操作，或由用户提供上述默认诊断包；不重启／强停／重装来掩盖现场。

证据集中于既有本地忽略归档 `resume-20261104/android-validation-20261104/`：`real-device-bugs/capture-1793779654385447053.json`、`resource-id-diagnostic.json`、`live-1793780189885614262.json`、包校验及安装身份JSON。只保留脱敏摘要与错误指纹，不保存原始个人日志、序列号或全设备bugreport。
