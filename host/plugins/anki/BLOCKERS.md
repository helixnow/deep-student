# L16-anki：真实阻塞（v2 接手，2026-11-04）

当前分支已有 R5 `ACCEPTANCE.md`（含正常 main 窄范围复验）；本文件不代替复核人签收。

## WP-160 范围说明（2026-11-05）

本包的模板 owner 已在 main（`src/service.ts:92`、`src/template-service.ts`、
`repository/templates.ts`），没有 F3/WP140 前置。WP119 四项缺口现由本分支六个公开方法补齐，
下一步为正常集成后 L24 消费；本文件下方的历史 APKG/生成任务依赖不阻塞本包，也不由本包扩做。
正式 lane-gate 的 foreign ledger dirty 前置问题单列于交付报告，不更改两份生成账本。

## B1 / L15-review：集成测试服务名

**已解除**：`95d567a50` 后继修复已进入 main（C1 确认），不再作为当前等待项。
下面保留历史失败证据，不注册旧名别名、不重复改测试。

- `host/plugins/review/tests/l24-review-state-consumer.test.ts:18-24` 只安装 review/chatanki，
  提供 `'anki@1': {}`；chatanki 的生产 inject 要求 `anki`。
- 已有运行证据：作业 `20261104090937-974672`，exit 1，
  `plugin "dstu.chatanki" did not start: required services not available: "anki"`。
- 需要 review 测试所有者修正提供键（该测试只验证 review 快照，不是完整 Anki 链）。
  不在 L16 注册旧名兼容层，不越权改 review 文件。

## B2 / L11-vfs-repos：resource 软删除过滤

**已解除且正常 main 独立复验**：main 的 `ResourceLiveReader.getLiveResource(conn, id)`
已公开并由 `VfsReposService.resources` 提供；R5 `ACCEPTANCE.md`「1e80f32b4正常main独立复验结果」
已签 live-resource 分阶段与 raw alias 子项，不作为本轮待提供/待复验阻塞。

- Rust `src-tauri/src/chat_v2/tools/chatanki_executor.rs:10642-10653` 在解析文件引用时
  要求 `(r.deleted_at IS NULL OR r.id IS NULL)`。
- 已复用 `vfsRepo.files.getFile/resources.getResource/attachments.resolveFileId/blobs.getBlobPath`
  与 `vfsDatabase`，没有复制 L11 SQL。
- `VfsResource` 仍不暴露删除状态，`getResource` 有意包含软删行；现在通过
  `resources.getLiveResource(conn, id)` 过滤存活资源，不要求修改原 DTO。
- 按 Rust 原调用位置，仅 `resolve_context_ref_from_vfs_source` 的关联资源读取用 live seam；
  `res_` 元数据读取继续用 `getResource`（原 Rust :10570），保留 source_id 重定向语义。
- 同时保持 :10615-10622 的阶段差异：找不到存活 file 报映射错误；已找到存活 file、
  但关联资源已软删则最终返回 None，不误报映射错误。均组合现有 L11 公共 API，不复制 SQL。
- 上述是原缺口与修复范围的历史证据；不扩大为所有 VFS 路径/墓碑语义签收。

## B3 / L02-llm：critic raw prompt 与 Codex OAuth

- `src/generation-service.ts` / `src/generation-critic.ts` 已消费 `llmAnkiRouting` 的 Generator/Critic 决策。
- critic 已闭合：`src/generation-critic.ts` 直接调 L02 `llmRawPrompt.callAnkiRoutedRawPrompt`
  （anki_critic.rs:968-973，images 为 None），配置选择、force_json、caller/task、failover 与用量记录都在 L02。
- 仍开放：生成流仍走 `llmStreaming.singleShotCompletion`，Codex OAuth 请求准备尚未在该传输面闭合；
  详见 SPEC 的跨 lane 接缝记录。

## 不属于跨 lane 阻塞

未使用 imports、漏传 logger、SPEC v2 未逐命令核实、同步 APKG 工作以及既有测试
断言审读均属于本 lane 自有工作，不能据此声称迁移完成。

## L24 偏好持久化 i64 联验（2026-11-05，提供面本轮已更新）

**提供/消费未正常 main 的前置已解除**：C1 核 `536aad095` / `20b1e6220` 后，本 lane
下一次正常 merge 的 main `10740c5f0` 亲核 `931643d80`、`ca01db015`、`72063aa7c`
均为祖先（检查 exit0）。后续是独立业务复验/agent handler 消费，不再记作缺 owner/consumer。
以下保留原阶段证据与适用范围，不把入 main 当完整工具链签收。

- Rust `anki_preference_memory.rs:134-135,575,591,637,704` 的时间为完整 signed i64，
  不限 safe integer；L16 已公开 `PreferenceTimestamp = number | bigint`，旧 number 调用保留，
  新 bigint 原样写回，排序不经 Number、不对 bigint 作 sort 减法。
- 历史 main `chatanki/src/preference-memory.ts:78-79` 按 MIN/MAX_SAFE_INTEGER 解码、`:124`
  直接 JSON.stringify 的问题已有 L24 **完整消费候选 `72063aa7c`（base f2d）**：C1 亲取
  official5/5、435pass/exit0，以及 Node31/Electron14/exit0；其 timestamp 公共 union、
  真实 JsonReader.readSigned 与 raw JSON 数字写入已提交。不再记作“消费者未提供”。
- **当前待项是正常联合集成/复验，不是缺实现**。本轮正常 merge 的 main `628b4192e`
  已包含 L24 API、持久化实现、新真实测试（main 上实际提交 `df59dc7b9` 等）；三个文件与
  `72063aa7c` 无 diff，但 **72063aa7c 整体并非 main 祖先**，不误记其整个 tip 已合入。
  L16 `931643d80` / `2d558e65b` 及 agent-page `ca01db015` / `6fc4b3e0a` 仍待正常进入 main。
  先前单侧第五项 exit2 历史保留；新树已提交一次正式 typecheck 与偏好18例最小真实组合验证。
  保留原七项断言，不复制 L24 持久化、不 Number 化、不自行合业务分支，不代独立签收。
- 新树实际回执：`20261105020833-230a35` 正式 typecheck **exit0**，原七项断言未动；
  `20261105020833-9df8ad` L16四例＋main L24真实十四例 **18 passed / exit0**，无 Errors/Unhandled。
  这解除当前工作树的第五类型冲突，不代表 L16 已 main 或整个工具链获独立签收。
- 这里只列跨 owner 持久化组合待完成，不阻塞 L16 纯函数与其它自有工作；
  本 lane 自有的 SPEC / worker / 日志审读不能列为外部阻塞。

## B4 / F3：APKG worker 的临时 collection 文件连接能力（精确合同请求，2026-11-05）

- 仅指 worker 内临时 `collection.anki2` 连接，不包括 L16 自有 ZIP/媒体解析、任务模块或接线工作。
  `ApkgCollectionRuntime.openDatabase/closeDatabase`（`src/apkg-import-types.ts:231-237`）与
  导出 runtime 都必须在同一 worker 打开自己生成的临时 SQLite 文件，不能传 Host 的 DatabaseHandle。
- 已核 F3 public `storage/api.ts:31-38` 的 `createDatabaseWorkerPool`：single context 只有
  `{db,payload,threadId}`；multi context 只有按固定库名的 `openExisting` 和 `close`、`log`，
  不能打开任意自有临时 collection 路径。Host 的 `storage.openFile` 已有正确语义，但对象/函数不可
  structured-clone；F3 的连接工厂在 private `service.ts`，L16 不导入实现、不直连驱动替代。
- 最小请求：由 F3 给 `MultiDatabaseWorkerTaskContext` 增补
  `openFile(path: string, options?: OpenFileOptions): DatabaseHandle`，复用 public StorageService
  同名方法的原默认 profile / mustExist / createParentDirs 行为；现有 `close` 可提前关闭，
  task finally 关闭所有尚存临时连接，失败传播原 StorageError。只给受信 lane-owned task module，
  不给调用方传任意 SQL 的通道，不改业务表所有权。
- 现有 multi context 的 log 已够；不请求新压缩库、F7 引擎或业务数据库共享连接。主线程仍只做
  最终 L16＋L15 同事务落库，不能为了 worker 拆开事务。本请求交 C1/架构统筹，不向 parked 加派。
  公开能力未发布前不虚造 worker provider 或把“有接口草稿”计为生产非阻塞已实现。
