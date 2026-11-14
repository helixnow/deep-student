# L18-media-docs 行为规格（`host/plugins/media/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 74 个 · 发出事件 6 种 · 契约：`contracts/ipc/L18-media-docs.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [ ] Option → null 还是缺省（`skip_serializing_if`）：
- [ ] u64/i64 超过 2^53 的表示：
- [ ] 字段顺序（serde_json preserve_order）：
- [ ] f32 精度：
- [ ] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：
- [ ] 取消：CancellationToken / drop → AbortSignal，取消点一致：
- [ ] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：
- [ ] 时间与 ID：生成方式、格式、时区：
- [ ] 不对含 HashMap 的结构做序列化后比对：

## 命令 `add_ocr_engine`

<!-- BEGIN GENERATED:cmd:add_ocr_engine -->
- Rust：`src-tauri/src/cmd/ocr.rs:447` · async
- 前端：app（2 处，例 `src/features/chat/readiness/autoAssignModel.ts:255`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：configId: string, model: string, name: string, engineType?: string | null
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:add_ocr_engine -->

- [x] 输入：configId/model/name 必填，engineType 可选；省略时按模型名推断（`src-tauri/src/cmd/ocr.rs:448-476`）。
- [x] 输出：追加后固定返回 true（:523）。
- [x] 错误：Validation「系统 OCR 引擎由系统自动管理，无需手动添加」/「该模型已在 OCR 引擎列表中」/「模型 … 已被服务商停服…」；读取/解析/序列化/保存失败为 Database AppError（:456-521）。
- [x] 事件：无（:448-523）。
- [x] DB 读写：读 `ocr.available_models`（缺失按 `[]`），priority=max+1、enabled=true、isFree 由内置引擎表推断后整体回写（:495-520）。
- [x] 取消/并发：无取消点；等待 `llm_manager.get_api_configs()` 判断停服模型，读取失败按“不拦截”处理（:479-493）。
- [x] 时间/ID：不生成；系统引擎 config_id 为常量 `__system_ocr__`（`dstu-llm/src/llm_manager/ocr_models.rs:6`）。

## 命令 `cancel_pdf_ocr_session`

<!-- BEGIN GENERATED:cmd:cancel_pdf_ocr_session -->
- Rust：`src-tauri/src/commands.rs:787` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：sessionId: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:cancel_pdf_ocr_session -->

- [x] 输入：sessionId（src/commands.rs:789）。
- [x] 输出：cancellations 表中有该会话时移除并 send(true) → true，否则 false（:792–798）。
- [x] 错误：无 Err 分支（异步 Mutex 串行访问，:792）。
- [x] 事件：无（:786–799）。
- [x] DB 读写：无，仅进程内 map（:700–702,792）。
- [x] 取消/并发：命令本身是取消信号；锁只覆盖 remove，send 在锁外（:792–794）。
- [x] 时间/ID：无（:786–799）。


## 命令 `compress_image`

<!-- BEGIN GENERATED:cmd:compress_image -->
- Rust：`src-tauri/crates/dstu-media/src/cmd/media.rs:54` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：sourcePath?: string | null, bytesBase64?: string | null, maxEdge?: integer(u32) | null, quality?: integer(u8) | null, outputMode?: string | null
  - 结果：CompressImageResult · 错误：string
<!-- END GENERATED:cmd:compress_image -->

未注册（L18-B03）。实现与 kernel 测试已写好并保存在检查点 `8a3f71537`
（`src/compress-image.ts`、`tests/compress-image.test.ts`，已于下一提交撤出）：
F7 `nativeImage.encode` 的 JPEG/PNG 编码器 `require('jpeg-js')`/`require('pngjs')`
在 main root 依赖中不存在（`host/platform/native/NEEDS.md:127,222`，未批准候选），
作业 `20261104133057-f20899` 3 个 JPEG 用例报 `JPEG 编码失败: Cannot find module 'jpeg-js'`，
3 个不经编码的用例通过。依赖获批安装后恢复该提交即可，不以失败命令注册。

- [ ] 输入/输出/错误：已按 :69-147 实现（sourcePath 优先、maxEdge `.max(1)`、quality clamp 10..=95、五个错误字符串、tmpdir 文件名），待恢复后重验。
- [x] 事件 / DB 读写：无。
- [ ] 取消/并发：Rust spawn_blocking；TS `resizeRgba` 同步在 Host 线程，归 R1-MD-05。
- [ ] 像素等价：D5 PSNR 未签；16 位源图舍入差异待 F7 复核。

## 命令 `convert_heic_to_jpeg`

<!-- BEGIN GENERATED:cmd:convert_heic_to_jpeg -->
- Rust：`src-tauri/src/heic_decoder.rs:78` · async
- 前端：app（1 处，例 `src/utils/heicConversion.ts:192`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：（无）
  - 结果：Response · 错误：AppError · 注入：app-handle, request
<!-- END GENERATED:cmd:convert_heic_to_jpeg -->

- [x] 输入：无具名参数；载荷必须是 raw IPC body（`src-tauri/src/heic_decoder.rs:53-77`）。Host 从 `CallContext.payload` 读取原始 `Uint8Array`/`ArrayBuffer`，JSON 对象按 Rust 同一句报错；空体与非 raw 先于平台判断拒绝。
- [x] 输出：Rust Android 分支返回 `tauri::ipc::Response` 原始 JPEG（质量 90、≤16MP，`heic_decoder.rs:100-133`）；桌面/非 Android 不产生输出，只返回拒绝（`:130-140`）。Host 只实现桌面分支，Android 成功路径不在 Electron 目标平台内，不用 libheif 冒充。
- [x] 错误：非 raw → `Validation: HEIC_INVALID_INPUT: expected raw binary request body`；空体 → `HEIC_INVALID_INPUT: empty image body`；超过 50 MiB → `HEIC_INVALID_INPUT: image exceeds 50 MB`；完成上述校验后桌面返回 `Validation: HEIC_UNSUPPORTED_PLATFORM: native HEIC conversion is only available on Android`（`heic_decoder.rs:53-77,130-140`）。Host 由 F7 `nativeHeic.convertToJpeg` 逐字产出；缺失提供者时返回 Configuration 而不是成功。
- [x] 事件：无（Rust 命令不发事件）。
- [x] DB 读写：无。
- [x] 取消/并发：无取消点；Host 桌面分支无临时文件/插件调用。Android 临时文件仅存在于 Rust 分支，不在 Host 实现。
- [x] 时间/ID：桌面 Host 不生成 ID；Rust Android 仅生成临时文件名 UUID（`heic_decoder.rs:105`）。

## 命令 `get_available_ocr_models`

<!-- BEGIN GENERATED:cmd:get_available_ocr_models -->
- Rust：`src-tauri/src/cmd/ocr.rs:154` · async
- 前端：app（6 处，例 `src/features/chat/readiness/autoAssignModel.ts:189`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：（无）
  - 结果：AvailableOcrModelResponse[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_available_ocr_models -->

- [x] 输入：无（`src-tauri/src/cmd/ocr.rs:155`）。
- [x] 输出：迁移/清理后的模型列表按 priority 升序，合并内置引擎 description/supportsGrounding；系统 OCR 缺失时按 max(priority)+1 注入（:229-252、:292-325）；设置从未存在时只在支持平台返回并持久化 priority 0 的系统项（:302-335）。
- [x] 错误：读取/解析失败 Database「读取 OCR 模型配置失败: …」/「解析 OCR 模型配置失败: …」（:161-168）；迁移/注入后的回写失败被忽略（:266-269）。
- [x] 事件：无。
- [x] DB 读写：读 `ocr.available_models`；Paddle 1.5 / GLM-4.1V 迁移、孤儿与停服清理、系统注入后 best-effort 回写（:170-269）。
- [x] 取消/并发：无取消点；等待 `get_api_configs()`，读取失败时跳过孤儿/停服清理但仍执行迁移与注入（:174-228）。
- [x] 时间/ID：不生成；系统 config_id 为常量 `__system_ocr__`。

## 命令 `get_image_as_base64`

<!-- BEGIN GENERATED:cmd:get_image_as_base64 -->
- Rust：`src-tauri/src/commands.rs:8493` · async
- 前端：app（3 处，例 `src/components/crepe/features/imageUpload.ts:20`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：relativePath: string
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_image_as_base64 -->

- [x] 输入：`relativePath` 支持 app 相对路径、绝对路径与 `file://` / `tauri://localhost/` / `asset://localhost/`；按 `urlencoding::decode` 百分号解码，解码失败退回原文。
- [x] 输出：`data:<mime>;base64,<payload>`；MIME 按路径后缀（png/gif/webp/bmp/heic/heif，其余 jpeg），大小写不敏感。
- [x] 错误：越出 app data 目录 → `Validation: 拒绝访问：超出应用数据目录`；文件不存在 → `NotFound: 图片文件不存在: …`；目录解析/读取失败 → `FileSystem: 解析app_data_dir失败: …` / `读取图片文件失败: …`。
- [x] 作用域依赖：插件 `inject` 声明 `settings` 与 `paths`，`get_image_as_base64` 与 exam-sheet 图片目录都读真实 `ctx.paths`；Host 级测试用 `{relativePath:""}` 证明返回业务 `FileSystem` 错误而不是 Cordis `HandlerPanic`。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：无（与 Rust 相同的同步读取语义）。
- [x] 时间/ID：无。

## 命令 `get_ocr_engine_type`

<!-- BEGIN GENERATED:cmd:get_ocr_engine_type -->
- Rust：`src-tauri/src/cmd/ocr.rs:56` · async
- 前端：app（1 处，例 `src/features/settings/components/ModelsTab.tsx:214`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：（无）
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_ocr_engine_type -->

- [x] 输入：无（src/cmd/ocr.rs:57）。
- [x] 输出：原样返回设置值（含任意旧值）；缺失返回 paddle_ocr_vl（:60–66）。
- [x] 错误：Database AppError，读取 OCR 引擎配置失败: + 原 DB 错误；details:null（:63）。
- [x] 事件：无（:57–67）。
- [x] DB 读写：只读 ocr.engine_type，委托 F4 settings.get（:61–64）。
- [x] 取消/并发：没有取消点；单次同步读取（:61）。
- [x] 时间/ID：不生成（:57–67）。

## 命令 `get_ocr_engines`

<!-- BEGIN GENERATED:cmd:get_ocr_engines -->
- Rust：`src-tauri/src/cmd/ocr.rs:38` · async
- 前端：app（1 处，例 `src/features/settings/components/OcrEngineCard.tsx:87`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：（无）
  - 结果：OcrEngineInfoResponse[] · 错误：AppError
<!-- END GENERATED:cmd:get_ocr_engines -->

- [x] 输入：无（`src-tauri/src/cmd/ocr.rs:39`）。
- [x] 输出：按 `engine_info_list` 顺序返回 6 个字段；系统 OCR 仅在编译目标 macOS/Windows/iOS 时追加（`dstu-llm/src/ocr_adapters/factory.rs:58-123`、`system_ocr/mod.rs:72-74`）；TS 以 `ctx.app.platform` 的 darwin/win32 判定。
- [x] 错误：无（纯静态映射，:40-52）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：无取消点；单次同步映射。
- [x] 时间/ID：不生成。

## 命令 `get_ocr_prompt_template`

<!-- BEGIN GENERATED:cmd:get_ocr_prompt_template -->
- Rust：`src-tauri/src/cmd/ocr.rs:137` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：engineType: string, mode: string
  - 结果：string · 错误：AppError
<!-- END GENERATED:cmd:get_ocr_prompt_template -->

- [x] 输入：engineType/mode 均经各自 `from_str`，不 trim；未知分别回退 paddle_ocr_vl / grounding（`src-tauri/src/cmd/ocr.rs:138-145`）。
- [x] 输出：对应适配器 `build_prompt`：DeepSeek grounding/table 等（`deepseek.rs:55-63`）、Paddle 任务前缀（`paddle.rs:72-90`）、GLM/通用 VLM 含 LaTeX 约束（`mod.rs:172-201`、`:259-286`）、System 空串（`system_ocr/mod.rs:87-90`）。
- [x] 错误：无（未知输入按回退值返回，:141-149）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：无取消点；单次同步映射。
- [x] 时间/ID：不生成。

## 命令 `get_ocr_thinking_enabled`

<!-- BEGIN GENERATED:cmd:get_ocr_thinking_enabled -->
- Rust：`src-tauri/src/cmd/ocr.rs:70` · async
- 前端：app（1 处，例 `src/features/settings/components/OcrEngineCard.tsx:96`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：（无）
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_ocr_thinking_enabled -->

- [x] 输入：无（`src-tauri/src/cmd/ocr.rs:71`）。
- [x] 输出：读 `ocr.enable_thinking` 后 `to_lowercase() == "true"` 才为 true；缺失/读取失败均为 false（`dstu-llm/src/llm_manager/mod.rs:7625-7631`）。
- [x] 错误：无；DB 读取错误被吞掉并返回 false（mod.rs:7627-7630）。
- [x] 事件：无。
- [x] DB 读写：只读 `ocr.enable_thinking`（经 F4 settings）。
- [x] 取消/并发：无取消点；单次同步读取。
- [x] 时间/ID：不生成。

## 命令 `get_pdf_ocr_temp_dir`

<!-- BEGIN GENERATED:cmd:get_pdf_ocr_temp_dir -->
- Rust：`src-tauri/src/commands.rs:875` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：（无）
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_pdf_ocr_temp_dir -->

- [x] 输入：无（src/commands.rs:876）。
- [x] 输出：可写应用数据目录下 pdf_ocr_temp 的绝对路径字符串；目录已创建（:877–887）。
- [x] 错误：FileSystem AppError，创建临时目录失败: + IO 错误，details:null（:883–885）。
- [x] 事件：无（:874–888）。
- [x] DB 读写：无（:874–888）。
- [x] 取消/并发：create_dir_all 幂等，无取消点（:883）。
- [x] 时间/ID：路径不含时间戳（:877–880）。


## 命令 `get_recent_document_tasks`

<!-- BEGIN GENERATED:cmd:get_recent_document_tasks -->
- Rust：`src-tauri/src/commands.rs:7062` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：limit?: integer(u32) | null
  - 结果：DocumentTask[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_recent_document_tasks -->

- [x] 输入：`limit?`，缺省 20；直接作为 SQL `LIMIT`（不做负数/上限钳制）。
- [x] 输出：`DocumentTask[]`，`status` 为 `Pending/Processing/Streaming/Paused/Completed/Failed/Truncated/Cancelled`；未知存储值回落 `Pending`。
- [x] 错误：主库读取失败 → `Database: 获取最近文档任务失败: …`。
- [x] 事件：无。
- [x] DB 读写：只读主库（`mistakes`）`document_tasks`，过滤 `deleted_at IS NULL`，按 `updated_at DESC` 排序。
- [x] 取消/并发：无。
- [x] 时间/ID：`created_at`/`updated_at` 原样返回数据库文本。

## 命令 `handout_cancel`

<!-- BEGIN GENERATED:cmd:handout_cancel -->
- Rust：`src-tauri/src/cmd/handout.rs:129` · async
- 前端：app（1 处，例 `src/features/media-handout/api.ts:54`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：requestId: string
  - 结果：null · 错误：AppError
<!-- END GENERATED:cmd:handout_cancel -->

- [x] 输入：requestId（src/cmd/handout.rs:130）。
- [x] 输出：null；取（必要时创建）共享 token 并 cancel（:131–132）。
- [x] 错误：无 Err 分支；Mutex 毒化被恢复（:131,34）。
- [x] 事件：无（:129–133）。
- [x] DB 读写：无，进程内 registry（:26–29,131）。
- [x] 取消/并发：取消信号与在途调用共享同一 token；额外调用幂等（:197–206 测试）。
- [x] 时间/ID：键为前端运行 ID，不生成（:31–38）。


## 命令 `handout_llm_complete`

<!-- BEGIN GENERATED:cmd:handout_llm_complete -->
- Rust：`src-tauri/src/cmd/handout.rs:74` · async
- 前端：app（1 处，例 `src/features/media-handout/api.ts:33`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：prompt: string, jsonMode?: boolean | null, requestId?: string | null
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:handout_llm_complete -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `handout_release`

<!-- BEGIN GENERATED:cmd:handout_release -->
- Rust：`src-tauri/src/cmd/handout.rs:135` · async
- 前端：app（1 处，例 `src/features/media-handout/api.ts:58`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：requestId: string
  - 结果：null · 错误：AppError
<!-- END GENERATED:cmd:handout_release -->

- [x] 输入：requestId（src/cmd/handout.rs:136）。
- [x] 输出：null；从 registry 移除该 ID（:137–141）。
- [x] 错误：无 Err 分支；重复释放幂等（:205–206 测试）。
- [x] 事件：无（:135–142）。
- [x] DB 读写：无，进程内 registry（:26–29,137）。
- [x] 取消/并发：释放使后续 token_for 得到全新未取消 token（:203–204 测试）。
- [x] 时间/ID：键为前端运行 ID，不生成（:31–38）。


## 命令 `handout_vlm_caption`

<!-- BEGIN GENERATED:cmd:handout_vlm_caption -->
- Rust：`src-tauri/src/cmd/handout.rs:96` · async
- 前端：app（1 处，例 `src/features/media-handout/api.ts:45`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：prompt: string, imageBase64: string, mime?: string | null, requestId?: string | null
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:handout_vlm_caption -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `infer_ocr_engine_from_model`

<!-- BEGIN GENERATED:cmd:infer_ocr_engine_from_model -->
- Rust：`src-tauri/src/cmd/ocr.rs:106` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：model: string
  - 结果：string · 错误：AppError
<!-- END GENERATED:cmd:infer_ocr_engine_from_model -->

- [x] 输入：model 字符串，大小写不敏感匹配（`src-tauri/src/cmd/ocr.rs:107-109`）。
- [x] 输出：按顺序匹配 `system` → GLM 视觉正则 → deepseek+ocr → paddleocr-vl-1 → paddle/paddleocr → generic_vlm（`dstu-llm/src/ocr_adapters/factory.rs:146-164`）。
- [x] 错误：无；未知模型回退 generic_vlm（factory.rs:163）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：无取消点；单次同步计算。
- [x] 时间/ID：不生成。

## 命令 `init_pdf_ocr_session`

<!-- BEGIN GENERATED:cmd:init_pdf_ocr_session -->
- Rust：`src-tauri/src/commands.rs:727` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：pdfName?: string | null, pdfBase64: string, totalPages: integer(usize)
  - 结果：string · 错误：AppError · 注入：state, app-handle
<!-- END GENERATED:cmd:init_pdf_ocr_session -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

### WP-138：页任务 JoinSet 与 Started 发送失败（窄行为清单）

语义源实际位于 `src-tauri/crates/dstu-vision/src/pdf_ocr_service.rs`（brief 的 dstu-media 为目录笔误）。
生产入口：`index.ts:286-315` → `PdfOcrService.startSession/processPdf/startBackendSession` → 本域两个 worker → `ocrTask`。

| Rust 分支 | TS 对应行为 |
|---|---|
| :888-897 upload Started emit Err | 记录 WARN `[PDF-OCR] Emit error: {e}`，随后仍取配置；后续 emit 的 `let _ =` 保持忽略 |
| :1020-1078 / :669-760 OCR `Err(AppError)` | 原 `ocrTask` 的 Retrying/退避或 PageFailed；保持失败页计数，不能当作 task panic |
| :986 / :617 spawn，permit 随任务释放 | 页任务独立运行，异常捕获为完成结果；释放并发槽，保留结果直到 drain，避免提前 reject/丢失已结束任务 |
| :1094-1097 上传达到 total_pages | 静默逐任务 drain（原 Rust 不检查结果）；包括 panic 在内都不阻断其它页及 Completed |
| :1111-1117 / :798-804 最终 drain | 按任务完成次序消费结果；未取消的 task 异常记 ERROR `[PdfOcrService] OCR task panicked: {诊断}` 后继续等待其它任务 |
| :1107-1110 / :794-797 cancel | 中止尚未完成的任务；已完成 panic 仍按最终 drain 记录，取消本身不记 panic，不等待外部未返回的 OCR；晚到结果不增加页面事件 |
| :1140-1157 / :839-858 | 所有非取消任务 drain 后才发 Completed，再记原 finished INFO；panic 不记入 failed_pages，success_count 来自已保存结果 |
| :880 receiver 的 Drop（WP-105） | startSession 的 finally 关闭接收端；正常/配置失败/外层 worker 异常仍唤醒 blocked upload 并报原 OCR session closed |

此文件没有 Rust 单测（TESTMAP 无对应行），新增生产路径分支测试，不修改旧 243 行映射。
日志保留级别/前缀/原异常消息；JS 异常没有 Tokio JoinError 的 task id/Debug 结构，不伪造该运行时字段。
本包不改变 IPC 字段、页缓存及文件归属、并发上限 4、重试次数/退避或现有测试时限。

## 命令 `media_bilibili_auth_status`

<!-- BEGIN GENERATED:cmd:media_bilibili_auth_status -->
- Rust：`src-tauri/crates/dstu-media/src/media/bilibili_auth.rs:461` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/bilibiliAccount.ts:55`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：（无）
  - 结果：BiliAccountStatus · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:media_bilibili_auth_status -->

- [x] 输入：无（`dstu-media/src/media/bilibili_auth.rs:462`）。
- [x] 输出：无会话 → logged_out(false)；nav 成功时刷新资料并返回 verified=true；nav 失败保留本地资料并返回 verified=false；-101 删除会话并返回 expired=true（:462-486）。
- [x] 错误：命令本身不返回错误；安全存储读取失败按无会话处理（:122-127），网络失败走离线分支（:480-485）。
- [x] 事件：无。
- [x] DB 读写：安全存储键 `internal.oauth.bilibili.session`；仅在资料变化时回写，过期时删除（:122-143、:467-479）。
- [x] 取消/并发：无取消点；等待 `/x/web-interface/nav` 后单次更新会话（:467-485）。
- [x] 时间/ID：刷新会话保留原 `savedAt`（:469-470）。

## 命令 `media_bilibili_bridge_approve`

<!-- BEGIN GENERATED:cmd:media_bilibili_bridge_approve -->
- Rust：`src-tauri/crates/dstu-media/src/media/bilibili_transport/bridge_server.rs:523` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：connectionId: string
  - 结果：null · 错误：string
<!-- END GENERATED:cmd:media_bilibili_bridge_approve -->

- [x] 输入：connectionId（`dstu-media/src/media/bilibili_transport/bridge_server.rs:523-527`）。
- [x] 输出：固定 null（批准后 hub 状态转 probing，`bridge.rs:147-153`）。
- [x] 错误：连接不存在/不匹配时返回 `BiliError` JSON 字符串 `bilibili-bridge-auth`「配对请求已失效」（`bridge.rs:148-150`、`bridge_server.rs:524-526`）。
- [x] 事件：无（仅更新进程内状态）。
- [x] DB 读写：无。
- [x] 取消/并发：无取消点；同步修改 hub 的 Mutex 状态（`bridge.rs:147-153`）。
- [x] 时间/ID：不生成；connectionId 来自 authenticate（`bridge.rs:85-103`）。

## 命令 `media_bilibili_bridge_disconnect`

<!-- BEGIN GENERATED:cmd:media_bilibili_bridge_disconnect -->
- Rust：`src-tauri/crates/dstu-media/src/media/bilibili_transport/bridge_server.rs:529` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：（无）
  - 结果：null · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:media_bilibili_bridge_disconnect -->

- [x] 输入：无（`dstu-media/src/media/bilibili_transport/bridge_server.rs:529-533`）。
- [x] 输出：固定 null（`bridge_server.rs:530-533`）。
- [x] 错误：无；revoke 不失败（`bridge.rs:199-204`）。Android 前台服务切换失败会返回字符串错误，但宿主无该服务，桌面端为 no-op（`bilibili_lifecycle.rs:20-42`）。
- [x] 事件：无；已连接时向桥发送 `{"type":"revoked"}`（`bridge.rs:202`）。
- [x] DB 读写：无。
- [x] 取消/并发：无取消点；同步清空 pairing/resume/connection 并递增 generation（`bridge.rs:181-204`）。
- [x] 时间/ID：不生成；generation 每次断开 +1（`bridge.rs:192`）。

## 命令 `media_bilibili_bridge_pair`

<!-- BEGIN GENERATED:cmd:media_bilibili_bridge_pair -->
- Rust：`src-tauri/crates/dstu-media/src/media/bilibili_transport/bridge_server.rs:509` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：（无）
  - 结果：PairingView · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:media_bilibili_bridge_pair -->

- [x] 输入：无（`dstu-media/src/media/bilibili_transport/bridge_server.rs:509-514`）。
- [x] 输出：`PairingView { url, scriptUrl }`；`url` 为 `http://127.0.0.1:{port}/deepstudent-bili-bridge/v1/#{64hex}`，`scriptUrl` 指向同端口的 `deepstudent-bili-bridge.user.js`（:515-520）。
- [x] 错误：端口绑定失败 → `BiliError` JSON `bilibili-bridge-server`「无法启动本地浏览器桥」；Android 前台服务启动失败 → 字符串「无法启动浏览器桥前台服务，请保持应用在前台」，桌面端无该步骤（`bilibili_lifecycle.rs:20-42`）。
- [x] 事件：无外部事件；hub 状态置为 `pairing` 并清空上次 resume token（`bridge.rs:120-137`）。
- [x] DB 读写：无，全部为进程内状态与本地 HTTP 服务。
- [x] 取消/并发：服务器只启动一次（已启动时直接复用端口）；重复配对会清空 resume token、断开旧连接并生成新 challenge；配对 120 秒过期（`bridge_server.rs:25-48`、`bridge.rs:120-132`）。
- [x] 时间/ID：challenge = 两个 UUIDv4 的 32 位十六进制拼接（64 位），无需持久化。

## 命令 `media_bilibili_cancel`

<!-- BEGIN GENERATED:cmd:media_bilibili_cancel -->
- Rust：`src-tauri/crates/dstu-media/src/media/bilibili_transport/session.rs:440` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/bilibiliLinkApi.ts:230`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：taskId: string
  - 结果：null
<!-- END GENERATED:cmd:media_bilibili_cancel -->

- [x] 输入：`taskId`（任意字符串）。
- [x] 输出：`null`。
- [x] 错误：不返回错误（契约 `error: never`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：从任务表取出并 `cancel()` 对应令牌；未知 id 是幂等 no-op。同 id 重新注册时旧令牌先取消。
- [x] 时间/ID：任务 id 原样使用，不做 trim/校验。

## 命令 `media_bilibili_create`

<!-- BEGIN GENERATED:cmd:media_bilibili_create -->
- Rust：`src-tauri/crates/dstu-media/src/media/bilibili.rs:1212` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/bilibiliLinkApi.ts:204`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：input: string, page?: integer(u32) | null, lan?: string | null, taskId?: string | null
  - 结果：BiliCreateResult · 错误：string · 注入：app-handle, window, state, state
<!-- END GENERATED:cmd:media_bilibili_create -->

- [x] 输入：`input`（链接/分享文案/BV/av/短链）、可选 `page`、首选字幕 `lan`、可选 `taskId`（`dstu-media/src/media/bilibili.rs:1212-1226`）。
- [x] 输出：`BiliCreateResult{fileId,name,created,segments,lan,lanDoc,ai}`；已有同视频同分 P 且已有转写段时提前返回 `created=false`、`lan` 原样回传、`lanDoc=''`、`ai=false`（:1236-1253）；新建条目时 `created=true`（:1288-1300）。
- [x] 错误：复用 `media_bilibili_probe` 的链接/查询/字幕错误；字幕先 `parse_subtitle` 校验再建条目，失败不留下空条目（:1259-1264）；传输错误为完整 `BiliError` JSON（:46-48）。
- [x] 事件：新建附件成功时发 `dstu:change:{node.path}` 与 `dstu:change`（`DstuWatchEvent::created`，:1279-1288）。
- [x] DB 读写：`upload_media_stream_finalized` 原子写入 `.bilibili` 文件 + 描述内容 + 导入字幕段 + `files.extracted_text` + 时长；复用条目只替换空白字幕（:963-1050）；随后刷新检索并启动媒体 pipeline（:1271-1272）。
- [x] 取消/并发：`taskId` 注册取消令牌、任务截止 60 秒；`CREATE_LOCK` 串行化同进程创建，排队也受同一截止时间限制（`session.rs:265-289`、`bilibili.rs:63、1227-1231`）。
- [x] 时间/ID：不生成业务 ID；文件 ID 由 VFS 附件上传生成。

## 命令 `media_bilibili_import_subtitle`

<!-- BEGIN GENERATED:cmd:media_bilibili_import_subtitle -->
- Rust：`src-tauri/crates/dstu-media/src/media/bilibili.rs:1311` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/bilibiliLinkApi.ts:217`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：resourceId: string, input: string, page?: integer(u32) | null, lan?: string | null, taskId?: string | null
  - 结果：TranscriptView · 错误：string · 注入：app-handle, state, state
<!-- END GENERATED:cmd:media_bilibili_import_subtitle -->

- [x] 输入：`resourceId`（文件或 `res_*`）、`input`、可选 `page`/`lan`/`taskId`（`dstu-media/src/media/bilibili.rs:1311-1325`）。
- [x] 输出：替换字幕段后的 `TranscriptView`（含 segments、progress、status）。
- [x] 错误：非链接条目可把任意 B 站视频字幕导入该媒体；链接条目只允许重新获取自身 `bvid`+`page`，否则 `bilibili-invalid-link`「链接条目只能重新获取它自己的字幕；要导入别的视频，请用「B 站链接」新建条目」；其余复用 probe 错误（:1326-1344）。
- [x] 事件：无本命令自有事件；索引/管线进度由 L12 发出。
- [x] DB 读写：先取消正在运行的 ASR，再替换为 `source='import'` 段、重写 `files.extracted_text`、时长未知时用最后一条字幕兜底；随后刷新检索并启动 pipeline（`commands.rs:445-480`）。
- [x] 取消/并发：`taskId` 注册取消令牌、截止 60 秒；`cancelMedia` 在写入前停止 ASR（`session.rs:265-289`、`commands.rs:452-458`）。
- [x] 时间/ID：不生成 ID；时长仅在未知时由字幕结束时间写入。

## 命令 `media_bilibili_link_get`

<!-- BEGIN GENERATED:cmd:media_bilibili_link_get -->
- Rust：`src-tauri/crates/dstu-media/src/media/bilibili.rs:1353` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/bilibiliLinkApi.ts:228`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：resourceId: string
  - 结果：BiliLinkDescriptor · 错误：string · 注入：state
<!-- END GENERATED:cmd:media_bilibili_link_get -->

- [x] 输入：`resourceId`，可传文件 `id` 或 `res_*` 资源 id（`load_media_file` 反查）。
- [x] 输出：校验后的 `BiliLinkDescriptor`；`cover` 归一为 https、`url` 按 `bvid`/`page` 重建。
- [x] 错误：非链接条目 → `InvalidInput: 不是 B 站链接条目: <fileName>`；内容缺失 → `NotFound: 媒体文件内容缺失: <id>`；描述 >64 KiB 或 JSON/字段非法 → `InvalidInput: 不是有效的 B 站链接条目`。
- [x] 事件：无。
- [x] DB 读写：只读 `files` 行与链接条目内容（blob / 行内 resource 数据）。
- [x] 取消/并发：无（同步读取）。
- [x] 时间/ID：不写入时间戳；`url` 不信任存储值，按页面号重建。

## 命令 `media_bilibili_login_qr_poll`

<!-- BEGIN GENERATED:cmd:media_bilibili_login_qr_poll -->
- Rust：`src-tauri/crates/dstu-media/src/media/bilibili_auth.rs:500` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/bilibiliAccount.ts:61`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：qrcodeKey: string
  - 结果：BiliLoginPoll · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:media_bilibili_login_qr_poll -->

- [x] 输入：`qrcodeKey` 必须是 32 位小写十六进制（`is_valid_qrcode_key`），否则直接报错。
- [x] 输出：`{state, status}`；`state` 为 `waiting`/`scanned`/`expired`/`success`，只有成功且拿到 Cookie 时 `status` 为账号信息，否则 `null`。
- [x] 错误：key 无效 → `登录二维码无效，请刷新后重新扫码`；poll 请求失败/未知状态码按 Rust 文案透传；secure store 写入失败 → `保存 B 站登录状态失败`。
- [x] 事件：无。
- [x] DB 读写：成功时把会话 JSON 写入 secure store `internal.oauth.bilibili.session`。
- [x] 取消/并发：无。
- [x] 时间/ID：`savedAt` 为本次保存的 Unix 毫秒；nav 查询失败仍保存 Cookie 会话（`verified:true`）。

## 命令 `media_bilibili_login_qr_start`

<!-- BEGIN GENERATED:cmd:media_bilibili_login_qr_start -->
- Rust：`src-tauri/crates/dstu-media/src/media/bilibili_auth.rs:488` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/bilibiliAccount.ts:58`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：（无）
  - 结果：BiliLoginQr · 错误：string
<!-- END GENERATED:cmd:media_bilibili_login_qr_start -->

- [x] 输入：无。
- [x] 输出：`{qrcodeKey, qrPng, expiresInSecs}`；`qrPng` 为 `data:image/png;base64,<payload>`，`expiresInSecs` 固定 180。
- [x] 错误：passport 请求失败/非 2xx 透传 `B 站请求失败…`；响应非 JSON 或缺少 `code` → `B 站账号响应格式无效`；接口 `code != 0`、`data` 为空或 key 非 16–64 位字母数字 → `获取登录二维码失败（<code>：<message>）`；PNG 渲染失败 → `生成二维码失败: …`。
- [x] 事件：无。
- [x] DB 读写：无（登录态由 poll 成功后的 secure store 写入）。
- [x] 取消/并发：无。
- [x] 时间/ID：`qrcodeKey` 原样返回；有效期常量 180 秒，由前端计时。

## 命令 `media_bilibili_logout`

<!-- BEGIN GENERATED:cmd:media_bilibili_logout -->
- Rust：`src-tauri/crates/dstu-media/src/media/bilibili_auth.rs:529` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/bilibiliAccount.ts:65`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：（无）
  - 结果：null · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:media_bilibili_logout -->

- [x] 输入：无（`dstu-media/src/media/bilibili_auth.rs:530`）。
- [x] 输出：固定 null（:537）。
- [x] 错误：无；服务端退出与本地删除失败都被忽略（:531-536）。
- [x] 事件：无。
- [x] DB 读写：删除安全存储键 `internal.oauth.bilibili.session`（:536、:138-143）。
- [x] 取消/并发：无取消点；存在会话时尽力 POST `/login/exit/v2`（`bili_jct` 缺失则跳过）（:413-435、:531-535）。
- [x] 时间/ID：不生成。

## 命令 `media_bilibili_probe`

<!-- BEGIN GENERATED:cmd:media_bilibili_probe -->
- Rust：`src-tauri/crates/dstu-media/src/media/bilibili.rs:1172` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/bilibiliLinkApi.ts:198`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：input: string, page?: integer(u32) | null, taskId?: string | null
  - 结果：BiliProbeView · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:media_bilibili_probe -->

- [x] 输入：`input`、可选 `page`、可选 `taskId`（`dstu-media/src/media/bilibili.rs:1172-1184`）。
- [x] 输出：`BiliProbeView{bvid,title,owner,cover,durationMs,pages,page,tracks,defaultLan,url,existingId,subtitleState,subtitleError,route}`；`tracks` 不暴露签名 URL；`subtitleError` 只保留 message；`existingId` 为同视频同分 P 的未删除链接条目（:1185-1210）。
- [x] 错误：链接解析/查询/字幕轨错误按 `MediaError` JSON；超时/网络/桥离线在 auto 模式会换一个出口重试一次，账号不一致则拒绝换路（:1124-1170、`session.rs:291-327`）。
- [x] 事件：无。
- [x] DB 读写：只读查询 `mime_type='video/x-bilibili'` 的未删除文件并解析描述（`bilibili.rs:971-990`）。
- [x] 取消/并发：`taskId` 注册取消令牌、截止 60 秒；视频信息按出口/账号代次缓存 10 分钟（:58-59、`session.rs:265-289`）。
- [x] 时间/ID：不生成 ID；缓存 TTL 600 秒，封面按需读取且失败返回 null（:794-806）。

## 命令 `media_bilibili_stream_quality`

<!-- BEGIN GENERATED:cmd:media_bilibili_stream_quality -->
- Rust：`src-tauri/crates/dstu-media/src/media/bilibili_stream.rs:512` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/bilibiliAccount.ts:198`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：fileId: string, qn?: integer(u32) | null, epoch?: integer(u32) | null, attempt?: integer(u32) | null
  - 结果：StreamQualityView · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:media_bilibili_stream_quality -->

- [x] 输入：`fileId`（`file_*`/`att_*`，可带 `/` 前缀或百分号编码）、可选 `qn`/`epoch`/`attempt`（`dstu-media/src/media/bilibili_stream.rs:512-530`）。
- [x] 输出：`StreamQualityView{requested,current,options,streamUrl}`；`requested` 不在 MP4 白名单时回退 `DEFAULT_QN`，`current` 为 B 站实际清晰度，`options` 高→低（:163-166、:496-511）。`streamUrl` 返回 F2 自定义协议地址：macOS/Linux `bilistream://localhost/{fileId}?qn=…&e=…&a=…`，Windows `http://bilistream.localhost/{fileId}?…`；Host 侧 `src/bilibili-protocol.ts` 注册 `bilistream` 处理 Range（:530-545）。
- [x] 错误：无效条目路径 → 纯字符串「无效的 B 站链接条目」；其余错误返回 `MediaError` 的 Display 文案（非 JSON），并记录 `[media::bilibili_stream] quality file=… qn=… attempt=… code=…` 警告（:518-535）。
- [x] 事件：无。
- [x] DB 读写：只读链接条目描述；签名地址与播放会话保存在进程内缓存（:87-104、:457-494）。
- [x] 取消/并发：按 `(条目, qn, 账号代次, attempt)` 复用同一 `BiliAttempt` 播放会话，最多 256 个；会话失效或超过 50 分钟 TTL 报「播放出口或账号已变化，请重新开始播放」（:106-140）。
- [x] 时间/ID：缓存键含 qn/epoch/attempt；签名地址 TTL 由 `deadline` 决定，最长 50 分钟。

## 命令 `media_bilibili_transport_configure`

<!-- BEGIN GENERATED:cmd:media_bilibili_transport_configure -->
- Rust：`src-tauri/crates/dstu-media/src/media/bilibili_transport/bridge_server.rs:494` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：config: TransportSettings__De
  - 结果：null · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:media_bilibili_transport_configure -->

- [x] 输入：`TransportSettings{mode, proxyUrl?, proxyInAuto}`（`dstu-media/src/media/bilibili_transport/bridge_server.rs:495-498`）。
- [x] 输出：固定 null（:499-500）。
- [x] 错误：代理 URL 无效/含凭据 → string JSON `bilibili-proxy-config`；proxy 模式缺代理 →「请先配置可信代理地址」；保存失败 → `bilibili-settings`「保存 B 站出口设置失败」（`session.rs:67-82`、`native.rs:31-49`）。
- [x] 事件：无。
- [x] DB 读写：写设置键 `media.bilibili.transport.v1`（mode/proxyUrl/proxyInAuto 的 camelCase JSON），成功后更新进程内缓存并递增 generation（`session.rs:67-82`）。
- [x] 取消/并发：无取消点；同步校验 + 单次保存。
- [x] 时间/ID：不生成。

## 命令 `media_bilibili_transport_status`

<!-- BEGIN GENERATED:cmd:media_bilibili_transport_status -->
- Rust：`src-tauri/crates/dstu-media/src/media/bilibili_transport/bridge_server.rs:485` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/bilibiliTransport.ts:39`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：（无）
  - 结果：TransportView · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:media_bilibili_transport_status -->

- [x] 输入：无（`dstu-media/src/media/bilibili_transport/bridge_server.rs:486`）。
- [x] 输出：`settings`（缓存的出口设置）+ `bridge`（HUB 状态）+ `diagnostics`（最近 32 条请求诊断，按时间顺序）（:486-492、`session.rs:36-38`）。
- [x] 错误：无；设置读取/解析失败回退默认值（`session.rs:55-65`）。
- [x] 事件：无。
- [x] DB 读写：只读设置键 `media.bilibili.transport.v1`（首次读取后缓存，`session.rs:19、55-65`）。
- [x] 取消/并发：无取消点；返回单次快照。
- [x] 时间/ID：诊断里的 requestId/elapsedMs 来自实际请求；本命令不生成新 ID。

## 命令 `media_chapters`

<!-- BEGIN GENERATED:cmd:media_chapters -->
- Rust：`src-tauri/src/media/ledger.rs:19` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/mediaChapters.ts:47`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：resourceId: string
  - 结果：MediaChapter[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:media_chapters -->

- [x] 输入：`resourceId` 先 trim；空串直接返回 `[]`。
- [x] 输出：相关笔记按更新时间倒序，取第一份能解析出章节的讲义；`title` 去掉 `[媒体@…]`，`seconds` 为该小节后第一个本课锚点，按秒升序、同秒去重。
- [x] 错误：VFS 连接/查询失败映射为 `MediaError::Database` JSON；`notes` 服务未提供时 `Configuration: Notes service not configured`。
- [x] 事件：无。
- [x] DB 读写：只读 `notes.props._origin` 与 `notes` 正文（经 `notes` 服务的仓储读取）；不写。
- [x] 取消/并发：无。
- [x] 时间/ID：`mm:ss`/`hh:mm:ss` 各段 1-3 位且秒/分 < 60，超出 u32 视为无效。

## 命令 `media_checkpoints`

<!-- BEGIN GENERATED:cmd:media_checkpoints -->
- Rust：`src-tauri/src/media/ledger.rs:11` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/mediaCheckpoints.ts:93`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：resourceId: string
  - 结果：MediaCheckpoint[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:media_checkpoints -->

- [x] 输入：`resourceId` 去首尾空白后为空直接返回空数组；VFS 数据库缺失时也返回空数组（`src-tauri/src/media/ledger.rs:12-26,244-260`）。
- [x] 输出：`MediaCheckpoint[]`，只含解析里带 `[媒体@<id>:mm:ss]` 且所属题目集未删除的题目，按 `(seconds, questionId)` 升序（:216-242）。
- [x] 错误：数据库查询失败转为字符串错误；畸形/缺失解析不匹配锚点，直接跳过（:223-240）。
- [x] 事件：无（:243-260）。
- [x] DB 读写：只读 VFS `questions` JOIN `exam_sheets`；`attempt_count>0` 才给出 `isCorrect`（:222-240）。
- [x] 取消/并发：无取消点；`spawn_blocking` 内按单连接读取（:253-259）。
- [x] 时间/ID：不生成；只解析解析文本里的时刻锚点（`study_loop::media_source::media_citation_seconds_for`）。

## 命令 `media_library_list`

<!-- BEGIN GENERATED:cmd:media_library_list -->
- Rust：`src-tauri/crates/dstu-media/src/media/library.rs:410` · async
- 前端：app（1 处，例 `src/features/media-studio/api.ts:219`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：limit?: integer(u32) | null
  - 结果：MediaLibraryItem[] · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:media_library_list -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `media_progress_get`

<!-- BEGIN GENERATED:cmd:media_progress_get -->
- Rust：`src-tauri/crates/dstu-media/src/media/commands.rs:533` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:305`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：resourceId: string
  - 结果：MediaProgressRow | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:media_progress_get -->

- [x] 输入：`resourceId`，按 `files.id` 或 `files.resource_id` 反查，忽略 `deleted_at` 非空的行。
- [x] 输出：`MediaProgressRow | null`（`resourceId,lastPositionMs,durationMs,watchedMs,finished,updatedAt`）。
- [x] 错误：文件不存在 `MediaError::NotFound`；非音视频 `MediaError::InvalidInput`；数据库错误 `MediaError::Database`。
- [x] 事件：无。
- [x] DB 读写：只读 `files` 与 `media_progress`（后者经 `vfsRepo.mediaTranscripts`）。
- [x] 取消/并发：无。
- [x] 时间/ID：`updatedAt` 原样返回毫秒时间戳。

## 命令 `media_progress_set`

<!-- BEGIN GENERATED:cmd:media_progress_set -->
- Rust：`src-tauri/crates/dstu-media/src/media/commands.rs:544` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:309`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：resourceId: string, positionMs?: integer(i64) | null, durationMs?: integer(i64) | null, watchedDeltaMs?: integer(i64) | null, finished?: boolean | null
  - 结果：MediaProgressRow · 错误：string · 注入：state
<!-- END GENERATED:cmd:media_progress_set -->

- [x] 输入：`resourceId` + 可选 `positionMs/durationMs/watchedDeltaMs/finished`；NULL 表示不更新该列。
- [x] 输出：更新后的完整 `MediaProgressRow`。
- [x] 错误：同 `media_progress_get`；负的 `watchedDeltaMs` 按仓储语义钳制。
- [x] 事件：无。
- [x] DB 读写：`media_progress` upsert 由 `vfsRepo.mediaTranscripts.setProgress` 在调用方连接上完成。
- [x] 取消/并发：无。
- [x] 时间/ID：`updatedAt` 为本次写入时刻（毫秒）。

## 命令 `media_related_notes`

<!-- BEGIN GENERATED:cmd:media_related_notes -->
- Rust：`src-tauri/crates/dstu-media/src/media/library.rs:440` · async
- 前端：app（1 处，例 `src/features/media-studio/api.ts:223`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：resourceId: string
  - 结果：MediaRelatedNote[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:media_related_notes -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `media_study_ledger`

<!-- BEGIN GENERATED:cmd:media_study_ledger -->
- Rust：`src-tauri/src/media/ledger.rs:27` · async
- 前端：app（1 处，例 `src/features/media-studio/api.ts:229`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：resourceIds: string[], includeCardIds?: boolean | null
  - 结果：MediaStudyLedger[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:media_study_ledger -->

- [x] 输入：`resourceIds` 去空白、去重、保持首次出现顺序，最多 500 个；`includeCardIds` 默认 false（`src-tauri/src/media/ledger.rs:27-47,427-440`）。
- [x] 输出：按请求顺序每个 id 一项；卡片数/到期/新卡、题目数/作答数/正确率、错题数、题目集按题数降序（同数 id 升序）（:466-513）。
- [x] 错误：任一数据库查询失败转为字符串错误；畸形 JSON 不使整条查询失败（:456-513,83-190）。
- [x] 事件：无（:454-513）。
- [x] DB 读写：只读 `mistakes`（Anki）`document_tasks`→`anki_cards`→`fsrs_card_states`，以及 VFS `questions`→`exam_sheets`；不做写操作（:53-190）。
- [x] 取消/并发：无取消点；`spawn_blocking` 内两个库各查一次（:455-513）。
- [x] 时间/ID：`now_ms = Utc::now().timestamp_millis()` 仅用于到期判断；不生成 ID（:462）。

## 命令 `media_transcribe_cancel`

<!-- BEGIN GENERATED:cmd:media_transcribe_cancel -->
- Rust：`src-tauri/crates/dstu-media/src/media/commands.rs:366` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:287`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：resourceId: string
  - 结果：TranscriptStatusView · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:media_transcribe_cancel -->

- [x] 输入：`resourceId` 为 `files.id` 或 `res_*`，先按音视频文件加载（`dstu-media/src/media/commands.rs:367-373`）。
- [x] 输出：取消后返回不带 segments 的 `TranscriptStatusView`；已完成段保留，`running=false`（:374-380）。
- [x] 错误：媒体不存在/非音视频沿用 `load`；取消失败映射 `Database`（:373-379）。
- [x] 事件：无（:366-380）。
- [x] DB 读写：取消只操作 `PdfProcessingService` 的进程内任务与任务行；状态视图只读段/进度（:374-379）。
- [x] 取消/并发：`cancel_media` 发送取消信号并清理任务行；命令不等待后台任务结束（:374-376）。
- [x] 时间/ID：不生成（:366-380）。

## 命令 `media_transcribe_estimate`

<!-- BEGIN GENERATED:cmd:media_transcribe_estimate -->
- Rust：`src-tauri/src/media/commands.rs:19` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:278`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：resourceId: string
  - 结果：TranscribeEstimate · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:media_transcribe_estimate -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `media_transcribe_start`

<!-- BEGIN GENERATED:cmd:media_transcribe_start -->
- Rust：`src-tauri/src/media/commands.rs:28` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:283`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：resourceId: string
  - 结果：TranscriptStatusView · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:media_transcribe_start -->

- [x] 输入：`resourceId` 为 `files.id` 或 `res_*`，先按音视频文件加载（`dstu-media/src/media/commands.rs:367-373`、`src-tauri/src/media/commands.rs:29-45`）。
- [x] 输出：返回不带 segments 的 `TranscriptStatusView`；运行中直接返回 running=true 的现状，已完成直接返回；否则校验 ASR 配置后调用 L12 `startPipeline(fileId, null)`，再按 `isRunning` 返回最新视图（`commands.rs:325-362`）。
- [x] 错误：媒体不存在/非音视频沿用 `load`；非导入且为链接条目 → LinkOnly；ASR 配置失败映射 AsrFatal；`startPipeline` 失败映射 Database；视图构建错误透传（`commands.rs:334-359`）。
- [x] 事件：命令本身不发事件；L12 调度器发 `media-processing-progress/completed/error`（`pdf_processing_service.rs`）。
- [x] DB 读写：读 `files` / `media_transcript_segments` / `media_progress`；`startPipeline` 写 `files.processing_status/progress`；提供者写段、`media_progress.duration_ms` 与 `files.extracted_text`（`pipeline.rs:360-535`）。
- [x] 取消/并发：按 `isRunning` 去重；命令不等待后台任务；提供者用进程内单飞锁，排队阶段可取消（`pipeline.rs:398-410,737-775`）。
- [x] 时间/ID：不生成 ID；进度百分比 queued 0、decode 1–31、vad 32、asr 35–90；`transcript_chars` 为转写文本 Unicode 标量数（`pipeline.rs:360-535`）。

## 命令 `media_transcript_export`

<!-- BEGIN GENERATED:cmd:media_transcript_export -->
- Rust：`src-tauri/crates/dstu-media/src/media/commands.rs:504` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:301`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：resourceId: string, format: string, dest: string
  - 结果：TranscriptExportResult · 错误：string · 注入：window, state
<!-- END GENERATED:cmd:media_transcript_export -->

- [x] 输入：`format` 经 `parse_export_format`（大小写不敏感、去除前导点，接受 webvtt/text 别名）；`dest` 为输出路径。
- [x] 输出：`{path,format,segments,bytes}`；`segments` 仅计 `status=1` 且 trim 后非空的段，`bytes` 为 UTF-8 字节数。
- [x] 错误：无完成段 `InvalidInput: 还没有可导出的字幕（请先转写或导入字幕）`；格式错误 `不支持的导出格式: …（可选 srt / vtt / txt）`；写文件失败按 `Io` 返回。
- [x] 事件：无。
- [x] DB 读写：只读转写段；向 `dest` 写文本文件。
- [x] 取消/并发：无。
- [x] 时间/ID：srt 用逗号毫秒、vtt 用点毫秒，`-->` 在文本中转义为 `→`。

## 命令 `media_transcript_get`

<!-- BEGIN GENERATED:cmd:media_transcript_get -->
- Rust：`src-tauri/crates/dstu-media/src/media/commands.rs:382` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:291`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：resourceId: string
  - 结果：TranscriptView · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:media_transcript_get -->

- [x] 输入：`resourceId`（`res_*` 亦可）。
- [x] 输出：`TranscriptView`：状态由 `processing_status` + 段计数派生；`segments` 按 `idx`；`progress.percent` 取 `processing_progress.percent`，完成态兜底 100；`error` 只在 error/partial 时返回。
- [x] 错误：同 `media_progress_get`。
- [x] 事件：无。
- [x] DB 读写：只读 `files`、`media_transcript_segments`、`media_progress`（后两者经 `vfsRepo.mediaTranscripts`）。
- [x] 取消/并发（L18-M01）：读取 L12 `pdf.isRunning(fileId)`，再组装视图；修复旧实现写死 false（Rust `media/commands.rs:388-394`），生产入口测试覆盖 queued/running/停止三种快照。
- [x] 时间/ID：段起止为毫秒。

### v2 L18-M01：转写查询、取消与文件导入

Rust 入口 `crates/dstu-media/src/media/commands.rs:366-478`；TS 入口
`index.ts` 的同名三个注册。以下不把上游索引缺口或 owner 违规声明为已完成：

| Rust 分支 | TS 落点 / 预期 |
|---|---|
| :388-394 load → is_running → build_view | `media_transcript_get`：运行中 queued/pending/null 为 queued，其余为 running；保留段 |
| :374-376 cancel_media Err | `media_transcribe_cancel`：映射 MediaError Database JSON 字符串，不落 HandlerPanic |
| :433-437 读文件失败 | `media_transcript_import`：在取消之前返回 Io，旧任务不被取消 |
| :450-455 正在运行 | 取消失败终止，不替换字幕；成功才 import |
| :456-468 写字幕 → refresh_index → info | 原顺序，不提前发成功日志 |
| :470-478 start_pipeline Err/Ok | 失败只 warn、保留字幕；成功查询 isRunning 返回实际状态 |
| :204-210 progress JSON Value | 无 JSON.parse 类型断言；只有 object.percent 数字可取，f64→f32；其他 JSON/解析错误按 0/100 回退 |

- [ ] 数据边界：kernel 入参保留 resourceId/path；TranscriptView camelCase/Option null 见 Rust :58-102；L11 i64 端口仍需 D3 复核。
- [ ] 日志映射：import info/warn 与 Rust :464-475 一一对应；refresh_index 的 L13 owner 尚缺 main 接线，见 BLOCKERS。
- [ ] 错误映射：取消错误与文件读错顺序由新入口测试锁定；全量仓储 Err 映射另审。
- [ ] 所有权：转写段经 L11；extracted_text 的旧越权写属于 M02/B01，不能据本单元签收。
- [ ] 运行时：文件同步 IO/worker、完整调度取消待后续；本单元修复状态快照与副作用顺序。
- [ ] 测试与证据：`tests/media-commands.test.ts` 的 L18-M01 生产 kernel 用例；原 `import_get_export_flow` Rust helper 断言保留，命令用例状态改为 start_pipeline 后 queued，不把 helper 的 completed 套在命令上。
- [ ] 独立复验：待 main 集成后 R1 签收。

本单元验证：先补回归作业 `20261104105205-1f5ac4`，6 failed / 21 passed，exit 1，
确认确实击穿旧实现。修复后 `20261104105954-6f6654` 27 passed exit 0；Electron
`20261104110209-e2222d` 27 passed exit 0；全插件 `20261104110208-6014d0`
357 passed / 2 skipped exit 0；typecheck `20261104105954-5d6a55` exit 0；
importable `20261104105954-4df432` exit 0，wiring `20261104105954-4f5c7e` exit 0。
strict `20261104105954-f3904f` exit 1（全仓 4 项均在 `host/plugins/vfs/repository/`，
本 lane 无违规），未越权修其他 lane。ledger `20261104105954-66099f` exit 0。

R1 补审（`bf6479dc8`，基线 `eeaf5bdc7` 早于本单元）的 R1-MD-02/MD-03 与本单元对应同一
Rust 分支；X2-R22（cancel_media 错误成 HandlerPanic）同为 :374-376。三项均待 R1/X2
在 main 集成后复验，本 lane 不声明关闭。

### v2 L18-M05：媒体转写 ASR 计时、超时、用量与错误文案（仅 ASR 部分）

| Rust 分支 | TS 落点 / 预期 |
|---|---|
| `asr.rs:35,120` `ASR_REQUEST_TIMEOUT` 120s | `ASR_REQUEST_TIMEOUT_MS` 传入 `sendAsrRequest`（语音输入仍 90s，`voice_input.rs:446`） |
| `asr.rs:207-221` Instant 计时 + `record_asr_usage(MediaTranscription, …, e.to_string())` | `HttpAsrBackend.transcribe` 用 `performance.now()`，毫秒取整；`index.ts` 注入 `recordAsrUsage(llm_usage, MediaTranscription)`，写失败只 warn |
| `voice_input.rs:582-607` heuristic 0/0、config_id trim、缺错误为 Unknown error | `recordAsrUsage(conn, caller, usage)`，语音输入经同一函数 |
| `voice_input.rs:622-628` Display：传输层 message / `HTTP {status} {body}` | `formatAsrHttpError`；runner `on_failed`、AsrFatal 文案与用量错误均用它，替换原 `JSON.stringify` |
| `asr.rs:416-499` Instant 调度/退避/冷却 | `runAsrJobsWith` 全部改 `performance.now()`（vitest 3 fake timers 覆盖 performance，原 runner 用例通过） |

- [ ] 范围：LANE M05 中 Bilibili deadline/TTL/lease 墙钟部分未处理，仍是待办。
- [ ] 测试与证据：`tests/media-commands.test.ts` 的 L18-M05 用例经 `ctx.mediaTranscriber.transcribe`
  （真实 llm 配置 → HTTP mock → llm_usage SQLite）断言 3 行 media_transcription、
  `HTTP 400 bad audio`、120000 超时与 warn 文案。作业 `20261104113954-5722cb`
  32 passed exit 0；ASR/语音相关 6 文件 `20261104113338-c69c29` 除本用例的夹具缺字段外均通过，
  修夹具后由前者覆盖；typecheck `20261104113954-005ea4` exit 0。
- [ ] 独立复验：待 R1。

### v2 L18-M04：PDF OCR 控制状态

Rust `src/commands.rs:786-871` 只有一个 `AppState` 映射集。原 TS 命令与 `ocr` 服务各持
一份，且服务的 startSession/addPage/processPdf/startBackendSession 无条件抛出“未找到
pdfium 库”（F7 nativePdfium 已 provide，文案不实）。修复：命令委托 `ocr` 服务同一
`PdfOcrControlState`；四个创建方法从 `OcrService` 与实现中移除（无消费方），待 L18-B02
页级 OCR 调用可用后随 `init_pdf_ocr_session`/`start_pdf_ocr_backend` 一起实现。

- [ ] 测试：`tests/pdf-ocr.test.ts` 的 L18-M04 用例经 kernel invoke 与 `ctx.ocr` 交叉操作同一状态。
- [ ] 会话编排：仍阻塞于 B02（main 已有 `llmOcrModels.getOcrConfigsByPriority`、
  `llmOcrRegions.parse`，缺 `call_deepseek_ocr_page_raw` 等价调用与共享 OCR 熔断器）。

## 命令 `media_transcript_import`

<!-- BEGIN GENERATED:cmd:media_transcript_import -->
- Rust：`src-tauri/crates/dstu-media/src/media/commands.rs:422` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:296`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：resourceId: string, path: string
  - 结果：TranscriptView · 错误：string · 注入：window, state, state
<!-- END GENERATED:cmd:media_transcript_import -->

- [x] 输入：`resourceId` 为 `files.id` 或 `res_*`，`path` 为字幕文件；读取上限 `MAX_SUBTITLE_BYTES=20 MiB`，扩展名只用于识别 srt/vtt/BCC（`dstu-media/src/media/commands.rs:423-431,397-409`）。
- [x] 输出：导入完成后返回完整 `TranscriptView`（`running` 取导入后的任务状态，`with_segments=true`），`status` 由导入段推导为 `completed`（:465-471）。
- [x] 错误：媒体文件不存在/非音视频沿用 `load`；读文件失败、超大、字幕格式/条目错误分别映射 `Io`/`InvalidInput`（:429-434,397-401）。
- [x] 事件：无（:423-471）。
- [x] DB 读写：`set_imported_segments` 整份替换 `media_transcript_segments`（status=done、source=import、plan_version+1）；时长未知时以最后一条字幕结束时间补 `media_progress.duration_ms`；再把 `[mm:ss] 文本` 写回 `files.extracted_text`（空文本写 NULL）（:405-420）。
- [x] 取消/并发：导入前若该文件正在转写则 `cancel_media`；导入与写库在 spawn_blocking 中完成；随后 best-effort 刷新时间窗索引并调度 `start_pipeline`，失败只记 warn（:443-471）。
- [x] 时间/ID：不生成新 ID；`updated_at` 由仓储写入，`plan_version` 递增（`media_transcript_repo.rs`）。

## 命令 `notes_export_docx`

<!-- BEGIN GENERATED:cmd:notes_export_docx -->
- Rust：`src-tauri/src/cmd/handout.rs:146` · async
- 前端：app（1 处，例 `src/features/notes/noteDocxExport.ts:72`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：spec: Value
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:notes_export_docx -->

- [x] 输入：任意 JSON `spec`；仅当 `spec.blocks` 为数组时逐块处理：`type=="image"`、`data` 非空字符串则跳过；`src` 为字符串且非 `http(s)://` 时经 `getImageAsBase64(appDataDir, src)`（= `file_manager.get_image_as_base64`）填入 `data`（handout.rs:151-182）。不修改调用方对象（Rust 按值获取）。
- [x] 输出：F7 `nativeOfficeWriter.generateDocx`（= `DocumentParser::generate_docx_from_spec`，含默认与 `handout`/`official` 版式，D9 docx@9.15.2）生成的字节，标准 base64。ZIP 打包字节不要求一致（D9）。
- [x] 错误：取图失败只 `warn` `[notes_export_docx] image unavailable: {src} ({e})` 并继续（坏图由生成端退化为占位文字）；生成失败 → `AppError::internal(e.to_string())`（`DOCX解析错误: DOCX 生成失败: …`）。宿主未提供 `nativeOfficeWriter` 时报 configuration 错误（Rust 无此分支，属宿主装配缺失）。
- [x] 事件：无。
- [x] DB 读写：无；只读应用数据目录内图片文件。
- [x] 取消/并发：无取消；Rust `spawn_blocking` 对应异步生成，无共享状态。
- [x] 时间/ID：不生成时间/ID。

## 命令 `parse_document_from_base64`

<!-- BEGIN GENERATED:cmd:parse_document_from_base64 -->
- Rust：`src-tauri/src/commands.rs:4121` · async
- 前端：app（1 处，例 `src/components/TranslateWorkbench.tsx:607`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：fileName: string, base64Content: string
  - 结果：string · 错误：string
<!-- END GENERATED:cmd:parse_document_from_base64 -->

- [x] 输入：`fileName`、`base64Content`（支持 `data:` URL，逗号缺失报 Base64 错误）；先按编码长度检查解码上界，再 STANDARD 解码。Office 检查用固定名（docx=`document.docx`，pptx=`presentation.pptx`，pdf=`document.pdf`），Excel 用传入文件名；无扩展名时按纯文本清单回退。
- [x] 输出：`DocumentParser` 文本。txt/md/代码扩展名走编码探测 + trim；pdf 走 F7 `nativePdfium.extractText`（页间 `\f`）+ trim；csv 走 `nativeOfficeText.extractCsv`；json 为 `to_string_pretty`（preserve_order、ryu）；xml 为 quick-xml 0.37 trim_text 文本拼接；epub 自有实现；docx/pptx/rtf 走 F7 `nativeOffice.extractText`。xlsx/xls/xlsb/ods 与 html 的 F7 引擎尚不可用（`OfficeEngineUnavailableError`），在 Rust 对应库调用位置报错：Excel path `无法打开Excel文件: …`、bytes `无法解析Excel数据: …`，HTML `HTML 转文本失败: …`，不空成功。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：Rust 用 spawn_blocking；此处在异步 docs 服务上运行，无共享状态。
- [x] 时间/ID：无。
- [x] 错误：`Base64文档解析失败: {ParsingError Display}`（字符串），`error!` 同文；开始 `info!` `开始解析Base64文档: {fileName}`，成功 `debug!` `Base64文档解析成功，提取文本长度: {UTF-8 字节数} 字符`。

## 命令 `parse_document_from_path`

<!-- BEGIN GENERATED:cmd:parse_document_from_path -->
- Rust：`src-tauri/src/commands.rs:4093` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：filePath: string
  - 结果：string · 错误：string
<!-- END GENERATED:cmd:parse_document_from_path -->

- [x] 输入：`filePath`。不存在 → `文件未找到`；扩展名取 basename 的 `Path::extension`（无回退）。pdf/excel/pptx 先按 metadata 检查大小，各格式读文件均走 `read_file_safely`；Office 加密与 ZIP Bomb 检查用真实文件名；csv/json/xml 读出后以文件名转 bytes 分支。
- [x] 输出：`DocumentParser` 文本。txt/md/代码扩展名走编码探测 + trim；pdf 走 F7 `nativePdfium.extractText`（页间 `\f`）+ trim；csv 走 `nativeOfficeText.extractCsv`；json 为 `to_string_pretty`（preserve_order、ryu）；xml 为 quick-xml 0.37 trim_text 文本拼接；epub 自有实现；docx/pptx/rtf 走 F7 `nativeOffice.extractText`。xlsx/xls/xlsb/ods 与 html 的 F7 引擎尚不可用（`OfficeEngineUnavailableError`），在 Rust 对应库调用位置报错：Excel path `无法打开Excel文件: …`、bytes `无法解析Excel数据: …`，HTML `HTML 转文本失败: …`，不空成功。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：Rust 用 spawn_blocking；此处在异步 docs 服务上运行，无共享状态。
- [x] 时间/ID：无。
- [x] 错误：`文档解析失败: {ParsingError Display}`（字符串），并 `error!` `{msg} (path={filePath})`；开始 `info!` `开始解析文档: {path}`，成功 `debug!` `文档解析成功，提取文本长度: {UTF-8 字节数} 字符`。
- 差异：Rust pptx path 版用 `convert_to_md` 未 trim 的整页拼接并跳过 None 页；F7 仅有字节入口（每页 trim、空页保留），页间空白可能不同，需 F7 提供原始逐页接口才能逐字节一致。

## 命令 `pause_pdf_ocr_session`

<!-- BEGIN GENERATED:cmd:pause_pdf_ocr_session -->
- Rust：`src-tauri/src/commands.rs:802` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：sessionId: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:pause_pdf_ocr_session -->

- [x] 输入：sessionId（src/commands.rs:803）。
- [x] 输出：pauses 表中有该会话时 send(true) 并返回 true（不移除），否则 false（:804–810）。
- [x] 错误：无 Err 分支（:804）。
- [x] 事件：无（:801–811）。
- [x] DB 读写：无，仅进程内 map（:703,804）。
- [x] 取消/并发：get+cloned 在锁内，send 在锁外；重复暂停仍返回 true（:804–807）。
- [x] 时间/ID：无（:801–811）。


## 命令 `pin_images`

<!-- BEGIN GENERATED:cmd:pin_images -->
- Rust：`src-tauri/src/commands.rs:356` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：tempId: string, images: string[]
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:pin_images -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `process_pdf_ocr`

<!-- BEGIN GENERATED:cmd:process_pdf_ocr -->
- Rust：`src-tauri/src/commands.rs:774` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：request: PdfOcrRequest
  - 结果：PdfOcrResult · 错误：AppError · 注入：state, app-handle
<!-- END GENERATED:cmd:process_pdf_ocr -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `remove_ocr_engine`

<!-- BEGIN GENERATED:cmd:remove_ocr_engine -->
- Rust：`src-tauri/src/cmd/ocr.rs:527` · async
- 前端：app（2 处，例 `src/features/chat/readiness/autoAssignModel.ts:217`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：configId: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:remove_ocr_engine -->

- [x] 输入：configId（`src-tauri/src/cmd/ocr.rs:528`）。
- [x] 输出：删除并按数组顺序重新编号后返回 true（:556-564）。
- [x] 错误：Validation「系统 OCR 引擎由系统自动管理，无法删除」/「未找到该 OCR 引擎」（:540-554）；读取/解析/序列化/保存失败为 Database AppError（:532-563）。
- [x] 事件：无。
- [x] DB 读写：读 `ocr.available_models`（缺失按 `[]`），重编号后整体回写（:532-563）。
- [x] 取消/并发：无取消点；单次读写。
- [x] 时间/ID：不生成。

## 命令 `resume_pdf_ocr_session`

<!-- BEGIN GENERATED:cmd:resume_pdf_ocr_session -->
- Rust：`src-tauri/src/commands.rs:814` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：sessionId: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:resume_pdf_ocr_session -->

- [x] 输入：sessionId（src/commands.rs:815）。
- [x] 输出：pauses 表中有该会话时 send(false) 并返回 true（不移除），否则 false（:819–825）。
- [x] 错误：无 Err 分支（:819）。
- [x] 事件：无（:813–826）。
- [x] DB 读写：无，仅进程内 map（:703,819）。
- [x] 取消/并发：get+cloned 在锁内，send 在锁外（:819–822）。
- [x] 时间/ID：无（:813–826）。


## 命令 `save_available_ocr_models`

<!-- BEGIN GENERATED:cmd:save_available_ocr_models -->
- Rust：`src-tauri/src/cmd/ocr.rs:356` · async
- 前端：app（1 处，例 `src/features/settings/components/SiliconFlowSection.tsx:1006`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：models: SaveOcrModelRequest[]
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:save_available_ocr_models -->

- [x] 输入：models；isFree 缺省 false，enabled null/缺省 true，priority null/缺省为索引（src/cmd/ocr.rs:363–398）。
- [x] 输出：true；不验证模型、不重排输入（:363–383）。
- [x] 错误：Database AppError，序列化/保存 OCR 模型配置失败: + 原错误，details:null（:377–381）。
- [x] 事件：无（:357–384）。
- [x] DB 读写：camelCase 七字段 JSON 写 ocr.available_models，委托 F4 settings.save（:363–381）。
- [x] 取消/并发：没有取消点；单次保存，不增加事务（:380）。
- [x] 时间/ID：不生成业务 ID；设置时间由 F4 保持（:380）。

## 命令 `save_pdf_to_temp`

<!-- BEGIN GENERATED:cmd:save_pdf_to_temp -->
- Rust：`src-tauri/src/commands.rs:891` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：pdfBase64: string, fileName: string
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:save_pdf_to_temp -->

- [x] 输入：pdfBase64（允许 data: 前缀，内容取第一个逗号之后；无逗号时整串）、fileName（src/commands.rs:892–923）。
- [x] 输出：`{uuid}_{fileName}` 的绝对路径，文件字节为 STANDARD base64 解码结果（:921–929）。
- [x] 错误：创建目录失败 → FileSystem 创建临时目录失败:；解码失败 → Validation Base64 解码失败: + base64 0.21 文案；写入失败 → FileSystem 保存 PDF 文件失败:（:902–927）。
- [x] 事件：无（:890–930）。
- [x] DB 读写：无（:890–930）。
- [x] 取消/并发：无取消点；uuid v4 命名避免并发覆盖（:922）。
- [x] 时间/ID：UUID v4（:922）。


## 命令 `set_ocr_engine_type`

<!-- BEGIN GENERATED:cmd:set_ocr_engine_type -->
- Rust：`src-tauri/src/cmd/ocr.rs:88` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：engineType: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:set_ocr_engine_type -->

- [x] 输入：engineType，经 `OcrEngineType::try_from_str` 严格校验且不 trim（`src-tauri/src/cmd/ocr.rs:88-98`）。
- [x] 输出：保存规范化 `as_str()` 后返回 true（:99-102）。
- [x] 错误：Validation「Unknown OCR engine type: '<原值>'. Valid types: deepseek_ocr, paddle_ocr_vl, paddle_ocr_vl_v1, generic_vlm」（:91-97）；保存失败 Database「保存 OCR 引擎配置失败: …」（:99-101）。
- [x] 事件：无。
- [x] DB 读写：写 `ocr.engine_type`（:99-101）。
- [x] 取消/并发：无取消点；单次写入。
- [x] 时间/ID：不生成。

## 命令 `set_ocr_thinking_enabled`

<!-- BEGIN GENERATED:cmd:set_ocr_thinking_enabled -->
- Rust：`src-tauri/src/cmd/ocr.rs:76` · async
- 前端：app（1 处，例 `src/features/settings/components/OcrEngineCard.tsx:365`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：enabled: boolean
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:set_ocr_thinking_enabled -->

- [x] 输入：enabled bool（src/cmd/ocr.rs:77）。
- [x] 输出：true（:84）。
- [x] 错误：Database AppError，保存 OCR 推理配置失败: + DB 错误，details:null（:83）。
- [x] 事件：无（:77–85）。
- [x] DB 读写：ocr.enable_thinking 写字符串 true/false，委托 F4 settings.save（:79–82）。
- [x] 取消/并发：没有取消点，单次保存（:79）。
- [x] 时间/ID：仅 F4 设置时间（:79）。

## 命令 `skip_pdf_ocr_page`

<!-- BEGIN GENERATED:cmd:skip_pdf_ocr_page -->
- Rust：`src-tauri/src/commands.rs:829` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：sessionId: string, pageIndex: integer(usize)
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:skip_pdf_ocr_page -->

- [x] 输入：sessionId、pageIndex（usize）（src/commands.rs:830–834）。
- [x] 输出：恒为 true；首次访问创建 HashSet 后插入页号，重复插入不改变集合（:835–839）。
- [x] 错误：无 Err 分支（:835）。
- [x] 事件：无（:828–840）。
- [x] DB 读写：无，仅进程内 map（:707–709,835）。
- [x] 取消/并发：整段在同一个锁内完成（:835–839）。
- [x] 时间/ID：无（:828–840）。


## 命令 `start_pdf_ocr_backend`

<!-- BEGIN GENERATED:cmd:start_pdf_ocr_backend -->
- Rust：`src-tauri/src/commands.rs:846` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：pdfPath: string, pdfName?: string | null, renderDpi?: integer(u32) | null
  - 结果：string · 错误：AppError · 注入：state, app-handle
<!-- END GENERATED:cmd:start_pdf_ocr_backend -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `test_ocr_engine`

<!-- BEGIN GENERATED:cmd:test_ocr_engine -->
- Rust：`src-tauri/src/cmd/ocr.rs:612` · async
- 前端：app（1 处，例 `src/features/settings/components/OcrEngineTestPanel.tsx:127`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：request: OcrTestRequest
  - 结果：OcrTestResponse · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:test_ocr_engine -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `test_pdfium_status`

<!-- BEGIN GENERATED:cmd:test_pdfium_status -->
- Rust：`src-tauri/crates/dstu-docs/src/pdfium_utils.rs:192` · sync
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：（无）
  - 结果：object · 错误：string
<!-- END GENERATED:cmd:test_pdfium_status -->

- [x] 输入：无参数（`pdfium_utils.rs:192`）。
- [x] 输出：`HashMap<String, String>`。Rust 写 `exe_path`/`exe_dir`（`:197-203`）、`candidate_{i}`（`:205-212`）、`load_result`（`:214-217`）、`parse_test`（`:217-227`）。Host 用 `process.execPath` 写前两项（JSON 字符串形式对齐 Rust `{:?}`），用 F7 `nativePdfium.open(MINIMAL_PDF)` 的真实结果写 `load_result`/`parse_test`；Host 的 PDFium 是 WASM 适配器，没有原生库候选路径，因此不伪造 `candidate_N`，键集比 Rust 少 `candidate_*`。
- [x] 错误：Rust 命令返回 `Result<HashMap, String>`，本诊断路径总是 `Ok`（加载失败写进 `load_result`，`:222-225`）。Host 同样不抛业务错误；`nativePdfium` 未提供时写 `FAIL: nativePdfium service not available`，最小 PDF 打开失败时写 `FAIL: {message}`。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：无取消点；单次加载/打开，关闭文档后返回。
- [x] 时间/ID：不生成 ID；无时间字段。

## 命令 `textbooks_add`

<!-- BEGIN GENERATED:cmd:textbooks_add -->
- Rust：`src-tauri/src/cmd/textbooks.rs:114` · async
- 前端：app（2 处，例 `src/dstu/adapters/textbookDstuAdapter.ts:178`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：sources: string[], folderId?: string | null
  - 结果：Textbook[] · 错误：AppError · 注入：window, state, state
<!-- END GENERATED:cmd:textbooks_add -->

实现：`src/textbooks-add.ts`（注册在 `index.ts`）；测试 `tests/textbooks-add.test.ts`（全部走 `host.invoke('textbooks_add')`）。

- [x] 输入：`sources: string[]`、`folderId?: string | null`（`textbooks.rs:114-121`）。空 `sources` 直接返回 `[]`，不检查 VFS（:122-124）。
- [x] 输出：`Textbook[]`（`toTextbook`）。重复导入返回 `get_by_sha256` 查到的快照（恢复/改名之前，:292-358）。
- [x] 错误：VFS 未配置 → `Configuration("VFS database not configured")`；`VFS 查询教材失败`/`VFS 恢复教材失败`/`获取 VFS 连接失败`/`VFS 挂载教材失败` → `Database` 整体返回错误（`?`）。单文件失败（格式/大小/读取/PDF 头/加密/blob/解析/入库）只跳过并发 `error` 进度事件；全部跳过时补发汇总事件（:687-692）。入库 `locked`/`busy` 最多 4 次，间隔 250ms×次数（:593-632）。
- [x] 事件：`textbook-import-progress`、`dstu:change:/{id}` + `dstu:change`（`created`/`restored`）。Tauri 2 `Window::emit` 是全局广播，TS 用 `backendEvents.emit` / `emitTo({kind:'Any'})`。
- [x] DB 读写：均经 L11 所有者接口：`textbooks.getBySha256/restoreTextbook/renameTextbook/attachBlobIfMissing/createTextbookWithPreview/updateTextbookOcrPagesJson/markTextbookRenderError`、`blobs.storeBlob`、`folders.addItemToFolder`；PDF 预览经 `attachmentProcessing.renderPdf(conn, blobsDir, bytes, undefined, progress)`；PDF 流水线经 L12 `vfsIndex.pdf.startPipeline(id, 'ocr_processing')`（后台，失败只 warn，服务缺失按失败分支 warn）。
- [x] 已知差异：TS 无 panic，重活里未映射的异常按 JoinError 分支（`处理任务异常终止: <message>`）；`blobs.storeBlob` 同步（L11），哈希/读取为异步 IO。
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `textbooks_relink`

<!-- BEGIN GENERATED:cmd:textbooks_relink -->
- Rust：`src-tauri/src/cmd/textbooks.rs:700` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/TextbookContentView.tsx:580`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：id: string, newPath: string
  - 结果：Textbook · 错误：AppError · 注入：window, state
<!-- END GENERATED:cmd:textbooks_relink -->

- [x] 输入：`id` 教材 ID，`newPath` 用户重新选择的本地文件路径。
- [x] 输出：重新查询后的 `Textbook` DTO（`updated.to_textbook()`，`file_path` = 新 `original_path`）。
- [x] 错误：未配置 VFS → Configuration「VFS database not configured」；查询失败 → Database「VFS 查询教材失败: …」；教材不存在 → NotFound「教材不存在: {id}」；文件读取失败 → FileSystem「读取文件失败: …」；哈希不一致 → Validation「所选文件与原文件内容不一致，请选择同一个文件」；连接/SQL/blob 补存失败 → Database「获取 VFS 连接失败: …」/「更新 original_path 失败: …」/「补存 blob 失败: …」。
- [x] 事件：成功后依次 emit `dstu:change:/{id}` 与全局 `dstu:change`，载荷 `{ type: "updated", path: "/{id}" }`。
- [x] DB 读写：先 `UPDATE files SET original_path = ?1, updated_at = ?2 WHERE id = ?3`；随后在缺失时 `attachBlobIfMissing`（写 blobs 并回填 `blob_hash`）；最终重新读取教材。
- [x] 取消/并发：Rust 以 `spawn_blocking` 串行执行哈希/更新/补存；Host 同步执行同一顺序，无取消点。
- [x] 时间/ID：`updated_at` 使用 `chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ")` 等价格式；blob 扩展名取自已存 `file_name` 的小写扩展名。

## 命令 `textbooks_update_bookmarks`

<!-- BEGIN GENERATED:cmd:textbooks_update_bookmarks -->
- Rust：`src-tauri/src/cmd/textbooks.rs:821` · async
- 前端：app（1 处，例 `src/api/vfsFileApi.ts:129`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：id: string, bookmarks: Value[]
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:textbooks_update_bookmarks -->

- [x] 输入：`id` 教材 ID，`bookmarks` 任意 JSON 数组。
- [x] 输出：`true`。
- [x] 错误：教材不存在/仓储更新失败映射为 `AppError::Database`（`更新教材书签失败: …`）。
- [x] 事件：无。
- [x] DB 读写：`textbooks.bookmarks` 由 `vfsRepo.textbooks.updateBookmarks` 在调用方连接上更新。
- [x] 取消/并发：无。
- [x] 时间/ID：`vfsRepo.textbooks.updateBookmarks` 与 `VfsTextbookRepo::update_bookmarks` 一致，同时把 `updated_at` 刷新为当前时刻。

## 命令 `tts_check_available`

<!-- BEGIN GENERATED:cmd:tts_check_available -->
- Rust：`src-tauri/src/tts.rs:25` · async
- 前端：app（1 处，例 `src/utils/tts.ts:32`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：（无）
  - 结果：boolean · 错误：AppError
<!-- END GENERATED:cmd:tts_check_available -->

- [x] 输入：无（src/tts.rs:26）。
- [x] 输出：Windows/macOS true，Linux 执行 which espeak 看退出状态，其他平台 false（:27–55）。
- [x] 错误：进程启动失败折叠为 false；不向 IPC 抛错误（:43–49）。
- [x] 事件：无（:26–56）。
- [x] DB 读写：无（:26–56）。
- [x] 取消/并发：不因 invoke abandon 取消，使用异步子进程等待（:43–46）。
- [x] 时间/ID：无（:26–56）。

## 命令 `tts_speak`

<!-- BEGIN GENERATED:cmd:tts_speak -->
- Rust：`src-tauri/src/tts.rs:59` · async
- 前端：app（1 处，例 `src/utils/tts.ts:116`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：text: string, lang?: string | null, rate?: number | null, volume?: number | null
  - 结果：null · 错误：AppError
<!-- END GENERATED:cmd:tts_speak -->

- [x] 输入：text/lang/rate/volume；rate 按 f32 乘 175 后饱和转换 u32，volume 忽略；lang 缺省不加 voice 参数（src/tts.rs:60–65,137–153,188–204）。
- [x] 输出：say/espeak 完成后 null；语言映射保留 Ting-Ting/Alex/Kyoko 或 zh/en/ja（:137–164,188–215）。
- [x] 错误：Windows 与其他平台保留 Rust Unknown 错误；执行失败和非零状态为 Unknown AppError，details:null（:88,114–116,155–164,206–215）。
- [x] 事件：无（:60–89）。
- [x] DB 读写：无（:60–219）。
- [x] 取消/并发：spawn 无 shell、不因前端 abandon 停止；等待子进程完成，允许并行朗读（:129–167,180–218）。
- [x] 时间/ID：无（:60–219）。

## 命令 `tts_stop`

<!-- BEGIN GENERATED:cmd:tts_stop -->
- Rust：`src-tauri/src/tts.rs:93` · async
- 前端：app（1 处，例 `src/utils/tts.ts:130`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：（无）
  - 结果：null · 错误：AppError
<!-- END GENERATED:cmd:tts_stop -->

- [x] 输入：无（src/tts.rs:94）。
- [x] 输出：null；Rust 原行为仅打印后 Ok(())，不是迁移占位（:95–99）。
- [x] 错误：无（:98）。
- [x] 事件：无（:94–99）。
- [x] DB 读写：无（:94–99）。
- [x] 取消/并发：不追踪子进程、不终止朗读，保留原行为（:95–98）。
- [x] 时间/ID：无（:94–99）。

## 命令 `unpin_images`

<!-- BEGIN GENERATED:cmd:unpin_images -->
- Rust：`src-tauri/src/commands.rs:384` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：tempId: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:unpin_images -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `update_ocr_engine_priority`

<!-- BEGIN GENERATED:cmd:update_ocr_engine_priority -->
- Rust：`src-tauri/src/cmd/ocr.rs:403` · async
- 前端：app（4 处，例 `src/features/chat/readiness/autoAssignModel.ts:320`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：engineList: UpdateOcrPriorityItem[]
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:update_ocr_engine_priority -->

- [x] 输入：engineList[{configId, enabled}] 完整有序列表（`src-tauri/src/cmd/ocr.rs:404-407`）。
- [x] 输出：按数组下标设置 priority、同时更新 enabled，按 priority 稳定排序后返回 true；未知 configId 忽略（:417-436）。
- [x] 错误：读取/解析/序列化/保存失败为 Database AppError（:409-436）。
- [x] 事件：无。
- [x] DB 读写：读 `ocr.available_models`（缺失按 `[]`），更新后整体回写（:409-436）。
- [x] 取消/并发：无取消点；单次读写。
- [x] 时间/ID：不生成。

## 命令 `upload_pdf_ocr_page`

<!-- BEGIN GENERATED:cmd:upload_pdf_ocr_page -->
- Rust：`src-tauri/src/commands.rs:747` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：sessionId: string, page: PdfOcrPageInput
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:upload_pdf_ocr_page -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `validate_ocr_model`

<!-- BEGIN GENERATED:cmd:validate_ocr_model -->
- Rust：`src-tauri/src/cmd/ocr.rs:113` · async
- 前端：none
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：model: string, engineType: string
  - 结果：ValidateOcrModelResponse · 错误：AppError
<!-- END GENERATED:cmd:validate_ocr_model -->

- [x] 输入：model + engineType；engineType 经 `from_str`，未知回退 paddle_ocr_vl（`src-tauri/src/cmd/ocr.rs:113-121`）。
- [x] 输出：`{isValid, recommendedModel}`；仅 invalid 时给推荐模型，否则 null（:118-127）。
- [x] 错误：无（:118-127）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：无取消点；单次同步计算。
- [x] 时间/ID：不生成。

## 命令 `vfs_get_file_blob_path`

<!-- BEGIN GENERATED:cmd:vfs_get_file_blob_path -->
- Rust：`src-tauri/src/cmd/textbooks.rs:785` · async
- 前端：app（8 处，例 `src/features/learning-hub/apps/views/FileContentView.tsx:466`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：id: string
  - 结果：string | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:vfs_get_file_blob_path -->

- [x] 输入：VFS `files.id`（`src-tauri/src/cmd/textbooks.rs:786-789`）。
- [x] 输出：`files.blob_hash` → `blobs.relative_path` → `blobs_dir/relative_path`，仅文件存在时返回绝对路径，否则 null（:799-817）。
- [x] 错误：未配置 VFS 时 Configuration「VFS database not configured」（:790-793）；连接/查询失败 Database「获取 VFS 连接失败: …」/「查询 blob_hash 失败: …」/「查询 blob 路径失败: …」（:795-813）。
- [x] 事件：无。
- [x] DB 读写：只读 VFS `files.blob_hash` 与 `blobs.relative_path`（:799-813）。
- [x] 取消/并发：无取消点；单次同步查询。
- [x] 时间/ID：不生成。

## 命令 `voice_input_transcribe`

<!-- BEGIN GENERATED:cmd:voice_input_transcribe -->
- Rust：`src-tauri/src/voice_input.rs:21` · async
- 前端：app（1 处，例 `src/voice-input/providerRegistry.ts:29`）
- 契约：`contracts/ipc/L18-media-docs.json`
  - 参数：request: VoiceInputTranscribeRequest（rename_all = camelCase）
  - 结果：VoiceInputTranscribeResponse · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:voice_input_transcribe -->

- [x] 输入：`VoiceInputTranscribeRequest{audioBase64, mimeType, providerId?, model?, configId?, language?, prompt?, durationMs?}`；mimeType 仅用于扩展名/表单 Content-Type（`dstu-media/src/voice_input.rs:33-42、460-471`）。
- [x] 输出：`{text, language, durationMs, providerId, model}`；text 去掉 Qwen `language X<asr_text>` 前缀后 trim，durationMs 原样回传（`voice_input.rs:840-862、930-966`）。
- [x] 错误：AppError.message 是 `{"code","message"}` JSON 字符串；settings-required → Configuration，其余配置错误 → Validation（`voice_input.rs:101-108、437-443`）；HTTP 401/403 → LLM auth-failed、429 → rate-limited、其它非 2xx → transcription-failed；传输失败 → Network timeout/network-failed；空转写 → Validation empty-transcript；Base64 失败 → Validation invalid-audio（`voice_input.rs:473-480、781-838`）。
- [x] 事件：无。
- [x] DB 读写：读 `voice_input_asr_model_config_id` 分配、`get_api_configs` 配置表与 `builtin-siliconflow.api_key` / `siliconflow.api_key` 密钥（`voice_input.rs:246-269、414-435、515-536、866-926`）；usage telemetry 经 F3 `host/platform/storage/llm-usage.ts` 写入 `llm_usage_logs`：`caller_type=voice_input`、0/0 token、`token_source=heuristic`、duration 为请求耗时毫秒，失败记录 `AppError.message`（缺省 `Unknown error`），端点解析失败也记录；写库异常只告警、不改变转写结果（`src/voice-input.ts:156-224`、`index.ts:917-933`）。
- [x] 取消/并发：无取消点；端点解析后单次 HTTP POST，客户端超时 90 s（`voice_input.rs:445-447、930-956`）。
- [x] 时间/ID：仅回传请求里的 durationMs；不生成 ID（`voice_input.rs:840-862`）。

## 提供者服务 `examSheetSession`

- Rust 源：`src-tauri/crates/dstu-vision/src/exam_sheet_service.rs`（详情 :299、更新 :312；重命名命令 :981 复用更新）。三个 Tauri 命令 `get_exam_sheet_session_detail` / `update_exam_sheet_cards` / `rename_exam_sheet_session` 属 L14-qbank（`src-tauri/src/commands.rs:946/958/981`），本 lane 只提供服务，不注册这三个命令。
- 提供方式：`host/plugins/media/api.ts` 导出 `ExamSheetSessionService` / `ExamSheetUpdateOutcome`，`index.ts` 注册 Cordis 服务 `examSheetSession` 并加入 `meta.provides`；实现位于 `src/exam-sheet-service.ts`（`ExamSheetSessionCore` + `ExamSheetSessionCordisService`），模型编解码与 bbox 计算位于 `src/exam-sheet-model.ts`，RGBA 像素裁剪暂由 `src/rgba-crop.ts` 完成（main 尚未发布 F7 `nativeImage.cropRgba`；F7 分支已实现，合入后切换并删除本地裁剪），PNG 编码通过 F7 `ctx.nativeImage.encode({format:'png'})`（main 未合并前生产运行返回能力缺失错误，测试夹具编码器仅在 `tests/helpers/png.ts`）。
- `getExamSheetSessionDetail(sessionId)`：读取 VFS 整卷；不存在返回 AppError.not_found「未找到指定的整卷会话」；解析 `preview_json`/`metadata_json`，分页读取正式题目；正式题目非空或 metadata 含 `question_document_version` 时用正式题目覆盖兼容预览（保留旧卡片的页面几何/裁剪资源字段，清空 `linked_mistake_ids`）；把原始页图与裁剪图归档到 `images/exam_sheet_archive/{sessionId}`；按图片尺寸补齐 `resolved_bbox`，最后补全 bbox 并返回详情。
- `updateExamSheetCards(request)`：有卡片增删改且 `countQuestions(sessionId)>0` 时返回 Validation「该题目集使用正式题目实体，请通过题目编辑/删除接口操作，不能单独修改兼容预览」；既无卡片变更也无 `exam_name` 时返回 Validation「没有需要更新的内容」；按 session 串行化读改写（进程内 Promise 链）。删除已关联错题的卡片返回 Validation「题目 {label} 已关联错题，请先解除关联后再删除。」；新增/改框会重新裁剪并写 PNG，缺失页面/卡片返回 not_found，最终重算 tags/page_count/card_count 与 `updated_at` 后整体写回 VFS；返回 `{detail, updated_mistake_ids: []}`（Rust 当前也不产生错题联动 ID）。
- `renameExamSheetSession(request)`：把 `exam_name ?? ''` 转为更新请求，`null`/缺失表示清空名称（Rust 语义：`None` 改名请求转 `Some("")`）；名称未变化时不写库，仅返回当前 summary。
- 错误：全部以 `ExamSheetSessionError` 抛出，`appError` 保留 Rust `AppError` 的 type/message 线缆值；数据库失败前缀「VFS 查询整卷失败」「读取正式题目失败」「更新整卷会话失败」等；文件系统失败映射 `std::io::Error` 文本。锁只保证单进程内同一 session 的更新串行，跨进程无锁。

## 提供者服务 `mediaTranscriber`

- Rust 源：`crates/dstu-media/src/media/transcriber_hook.rs`（L12 调度入口）与 `pipeline.rs::transcribe_resource`（解码→VAD→ASR→落库）。
- 提供方式：`api.ts` 导出 `MediaTranscriberService` / `MediaTranscriptionRequest` / `MediaTranscriptionResult`，`index.ts` 注册 Cordis 服务 `mediaTranscriber` 并加入 `meta.provides`；实现位于 `src/media-transcriber.ts`，核心流水线位于 `src/pipeline.ts::transcribeResource`。
- 输入/输出：`{fileId,tempDir,imported,signal,onProgress}` → `{transcriptChars,doneSegments,totalSegments,failedSegments}`；进度阶段为 `queued`/`decode`/`vad`/`asr`，百分比与 Rust 一致（0、1–31、32、35–90）。
- imported：以数据库 `planInfo(...)[1] === 'import'` 为准；导入字幕只写 `files.extracted_text` 并调用 L13 `refreshTranscriptIndex`，不建 ASR 后端、不占单飞槽。L12 仍负责在 `transcriptChars > 0` 后调度向量索引。
- 持久化：解码完成即写 `media_progress.duration_ms`；`applyPlan`/`resetFailed` 续做；每段成功/失败立即写段表；每 20 段及结束时刷新 `files.extracted_text` 与 L13 索引。
- 并发/取消：进程内单飞（`TranscriptionGate`），排队中的请求可由 `AbortSignal` 取消；取消/失败时已完成的段保留。
- WP-204 公开错误：`api.ts` 直接重导出 `src/errors.ts::MediaError`，与真实 provider 抛出的类具有同一身份。消费者通过 `instanceof MediaError` 读取 `code`、原 Display `message`、`toPayloadString()` 原文（`transcriber_hook.rs:126-140`）；ASR 配置失败仍由生产 `AsrConfigError` 映射，取消仍为 `cancelled` / `已取消`。不新增 serializer 或错误包装。
- WP-204 验证：`tests/media-commands.test.ts` 两个 `WP-204` 用例经注册的 `ctx.mediaTranscriber.transcribe`，分别触发真实缺 ASR 配置路径、真实 pipeline 取消路径；断言公开类身份、code/message 与完整 payload 字符串。消费侧 Rust `pdf_processing_service.rs:1010` 是 WARN，`:1017` 的 set_error 二次失败是 ERROR，随后仍 emit 原 payload 并 Ok；该消费行为归 L12，本包仅提供公开错误类。
- 运行边界：当前 main 的 L12 `PdfProcessingService` 尚无 `PdfStageRuntime` 媒体运行时；提供者与命令已可单测，端到端 `startPipeline` 调度待 L12 合并候选 `runMedia` hook，未做目标平台 ASR 网络签收。

## 事件 `dstu:change`

<!-- BEGIN GENERATED:event:dstu:change -->
- 事件名 `dstu:change`
- 发送点：`src-tauri/src/cmd/textbooks.rs:76`（emit）
<!-- END GENERATED:event:dstu:change -->

- [ ] 载荷：教材导入/恢复/重关联为 `{ type, path }`，`type` 取 `created`（新导入）、`restored`（回收站恢复后重新导入）或 `updated`（`textbooks_relink`），`path` 为 `/{textbook_id}`（`src-tauri/src/cmd/textbooks.rs:63-80、290-355、680、778`）。Bilibili 建链接条目额外带节点：`{ type: "created", path, node }`（`crates/dstu-media/src/media/bilibili.rs:1278-1287` 的 `DstuWatchEvent::created`）。TS 侧教材重关联复用 `{type,path}`，Bilibili 复用 `createdEvent(node.path, node)`。
- [ ] 触发时机与顺序：教材每个成功写入 VFS 的文件在挂载文件夹、启动 PDF 流水线之后发送一次；已存在教材恢复/复用同样发送；先发 `dstu:change:{path}`，再发全局 `dstu:change`。Bilibili 仅在真正新建链接条目（`created.is_some()`）时发送，条目已存在则不发；同样先路径后全局。
- [ ] 节流/合并：无节流、无合并；批量导入按文件逐个发送，一个文件固定一对事件。
- [ ] 是否在事务提交后：是。事件在 VFS 写入/恢复/重关联完成并读取到最终记录后发送，不在 SQL 事务内；发送失败只记录警告，不回滚业务。
- [ ] 目标窗口（emit / emit_to / emit_filter）：`Window::emit`，目标是发起命令的窗口，不是全应用广播；TS 用 `backendEvents.emitTo({kind:'Window', label: source.window})` 对齐。

## 事件 `media_bilibili_playback_error`

<!-- BEGIN GENERATED:event:media_bilibili_playback_error -->
- 事件名 `media_bilibili_playback_error`
- 发送点：`src-tauri/crates/dstu-media/src/media/bilibili_stream.rs:835`（emit）
<!-- END GENERATED:event:media_bilibili_playback_error -->

- [x] 载荷：`{ fileId, qn, epoch, attempt, message }`（`bilibili_stream.rs:826-837`）。`fileId` 从 `bilistream://` 路径解析，失败时为空串；`qn`/`epoch` 从查询串解析；`attempt` 取查询参数 `a`，缺省 0；`message` 是响应体按 UTF-8 有损转换后的全文。
- [x] 触发时机与顺序：自定义协议流式响应状态码为 5xx 时，在请求处理完成、返回该响应之前发送一次；同一请求只发一次，不重试。
- [x] 节流/合并：无节流、无合并；每个失败的 Range/分段请求各发一条。
- [x] 是否在事务提交后：无数据库事务；纯播放协议错误通知。
- [x] 目标窗口（emit / emit_to / emit_filter）：`AppHandle::emit`，全应用广播到所有窗口；`src/bilibili-protocol.ts` 在 5xx 响应产生后调用 `ctx.backendEvents.emit('media_bilibili_playback_error', payload)`。

## 事件 `pdf_ocr_progress`

<!-- BEGIN GENERATED:event:pdf_ocr_progress -->
- 事件名 `pdf_ocr_progress`
- 发送点：`src-tauri/crates/dstu-vision/src/pdf_ocr_service.rs:388`（emit）
- 发送点：`src-tauri/crates/dstu-vision/src/pdf_ocr_service.rs:414`（emit）
- 发送点：`src-tauri/crates/dstu-vision/src/pdf_ocr_service.rs:440`（emit）
- 发送点：`src-tauri/crates/dstu-vision/src/pdf_ocr_service.rs:463`（emit）
- 发送点：`src-tauri/crates/dstu-vision/src/pdf_ocr_service.rs:486`（emit）
- 发送点：`src-tauri/crates/dstu-vision/src/pdf_ocr_service.rs:499`（emit）
- 发送点：`src-tauri/crates/dstu-vision/src/pdf_ocr_service.rs:640`（emit）
- 发送点：`src-tauri/crates/dstu-vision/src/pdf_ocr_service.rs:701`（emit）
- 发送点：`src-tauri/crates/dstu-vision/src/pdf_ocr_service.rs:729`（emit）
- 发送点：`src-tauri/crates/dstu-vision/src/pdf_ocr_service.rs:751`（emit）
- 发送点：`src-tauri/crates/dstu-vision/src/pdf_ocr_service.rs:1165`（emit）
- 发送点：`src-tauri/crates/dstu-vision/src/pdf_ocr_service.rs:1169`（emit）
<!-- END GENERATED:event:pdf_ocr_progress -->

- [ ] 载荷：按 `type` 区分（`crates/dstu-vision/src/pdf_ocr_service.rs`）。`Started`：`{type,session_id,total_pages}`（:891），渲染流水线的首事件另带 `pdf_name`、`render_dpi`（:579）；`RenderStarted`：`{type,session_id,total_pages}`（:388）；`Paused`：`{type,session_id}`（:555、:946）；`PageRenderFailed`：`{type,session_id,page_index,error}`（:414、:440、:463）；`PageRendered`：`{type,session_id,page_index,rendered,total}`（:486）；`PageCompleted`：`{type,session_id,page_index,completed,total,page_result:{page_index,width,height,blocks:[{text,bbox}]}}`，缓存路径带 `cached:true`、实跑路径带 `cached:false`（:640-668、:701-724、:997-1018、:1031-1049）；`Retrying`：`{type,session_id,page_index,attempt,max_attempts,backoff_ms,hint}`（:729-744、:1052-1065）；`PageFailed`：`{type,session_id,page_index,error}`（:751-758、:1071-1078、:1165-1174）；`Completed`：`{type,session_id,total_pages,success_count,failed_count,has_failures,cancelled}`（:1145-1158）。
- [ ] 触发时机与顺序：渲染阶段先发 `RenderStarted`，逐页发 `PageRendered` 或 `PageRenderFailed`；OCR 阶段在首次收到渲染页时发 `Started`，每页完成/失败/重试各发一条，最后发 `Completed`。模型配置读取失败时先发 `PageFailed(page_index:0)` 再发 `Completed(success_count:0,failed_count:total_pages,has_failures:true)`（:901-918）。暂停期间只重复 `Paused`。
- [ ] 节流/合并：无通用节流；`Paused` 每 500 ms 重复一次（:553-559、:944-950）；限流重试最多 3 次，退避从 1000 ms 指数增长到上限 20000 ms（:738-744、:1060-1065），每次重试发 `Retrying`。
- [ ] 是否在事务提交后：OCR 结果先写页缓存再发 `PageCompleted`，没有 SQL 事务；事件与缓存写入之间无事务边界。
- [ ] 目标窗口（emit / emit_to / emit_filter）：`AppHandle::emit`，全应用广播到所有窗口。当前宿主未提供 PDF OCR 服务（`process_pdf_ocr` 等依赖 L02 原始 OCR 调用），本 lane 无发送方。

## 事件 `pdf-annotations:changed`

<!-- BEGIN GENERATED:event:pdf-annotations:changed -->
- 事件名 `pdf-annotations:changed`，常量 `PDF_ANNOTATIONS_CHANGED_EVENT`
- 发送点：`src-tauri/src/chat_v2/tools/textbook_pdf_executor.rs:1040`（emit）
<!-- END GENERATED:event:pdf-annotations:changed -->

- [ ] 载荷：`{textbook_id,resource_path,kind,action,updated_at}`（`src-tauri/src/chat_v2/tools/textbook_pdf_executor.rs:1034-1057`）。`resource_path` 为 `/{textbook_id}`；`kind` 取 `bookmarks` 或 `highlights`；`action` 取 `add`/`update`/`remove`；`updated_at` 是写操作返回的教材最新更新时间。
- [ ] 触发时机与顺序：仅在书签/高亮写操作成功后发送；`add`/`update`/`remove` 各一次，`get` 不发送。发送点在版本校验写入完成之后、命令返回结果之前（:226-231、:389-394）。
- [ ] 节流/合并：无节流、无合并；每次成功写操作一条。
- [ ] 是否在事务提交后：是。`replace_bookmarks_if_version` / `replace_highlights_if_version` 已完成持久化并返回更新后的教材后才发送；发送失败只记录警告，不影响命令结果。
- [ ] 目标窗口（emit / emit_to / emit_filter）：`ctx.window_ref().app_handle().emit`，全应用广播到所有窗口。该发送点属于 chat_v2 教材 PDF 工具（非本 lane 生产代码），L18 未实现。

## 事件 `textbook-import-progress`

<!-- BEGIN GENERATED:event:textbook-import-progress -->
- 事件名 `textbook-import-progress`
- 发送点：`src-tauri/src/cmd/textbooks.rs:156`（emit）
- 发送点：`src-tauri/src/cmd/textbooks.rs:452`（emit）
<!-- END GENERATED:event:textbook-import-progress -->

- [ ] 载荷：`TextbookImportProgress{file_name,stage,current_page?,total_pages?,progress,error?}`（`src-tauri/src/cmd/textbooks.rs:26-39`）。`stage` 取 `hashing`/`copying`/`rendering`/`parsing`/`saving`/`indexing`/`done`/`error`；`current_page`/`total_pages` 仅渲染阶段；`progress` 为 0–100；`error` 仅错误阶段。
- [ ] 触发时机与顺序：逐文件发送。校验失败（格式/大小）先发 `error`（progress 0）；正常流程为 `hashing` 5 → `copying` 10 → PDF `rendering` 15（页回调 `(current/total)*70+15`，上限 85）或非 PDF `parsing` 15 → `saving` 90 → `indexing` 95 → `done` 100；已存在教材恢复/复用时只发 `done` 100。入库、挂载、启动流水线后先发 `dstu:change` 再发 `done`（:680-683）。整批全部跳过时额外发一条 `file_name:""`、`stage:"error"`、`progress:0`、`error` 为汇总原因的收尾事件（:687-692）。
- [ ] 节流/合并：无节流；PDF 每渲染一页回调一次，事件本身不合并。
- [ ] 是否在事务提交后：无显式事务；`saving` 在入库前发送，`done` 在 VFS 写入/文件夹挂载完成后发送，错误事件在失败分支即时发送。
- [x] 目标窗口（emit / emit_to / emit_filter）：Tauri 2 `Window::emit` 为全局广播；`textbooks_add` 用 `backendEvents.emit`（target Any）。

## 事件 `dstu:change:{}`

<!-- BEGIN GENERATED:event:fmt:dstu:change:{} -->
- 动态事件名（format! 模板）
- 发送点：`src-tauri/src/cmd/textbooks.rs:70`（emit）
<!-- END GENERATED:event:fmt:dstu:change:{} -->

- [ ] 载荷：与全局 `dstu:change` 相同：教材为 `{type,path}`，Bilibili 为 `{type:"created",path,node}`；`path` 为 `/{textbook_id}` 或链接条目节点路径（`src-tauri/src/cmd/textbooks.rs:63-80`、`crates/dstu-media/src/media/bilibili.rs:1278-1287`）。
- [ ] 触发时机与顺序：每次发送全局事件前，先发动态事件名 `dstu:change:{path}`，再发 `dstu:change`；两者载荷相同，业务写入完成后立即发送。
- [ ] 节流/合并：无节流、无合并；与全局事件成对发送，每业务成功一次发一对。
- [ ] 是否在事务提交后：是。教材在 VFS 创建/恢复/重关联完成后发送；Bilibili 在链接条目写入、索引刷新与流水线启动后发送；不在 SQL 事务内，发送失败只告警。
- [ ] 目标窗口（emit / emit_to / emit_filter）：`Window::emit`，只发给发起命令的窗口；TS 用 `backendEvents.emitTo({kind:'Window', label: source.window})` 对齐。
