# WAVE0 v0 B 驱动（WP-041 / WP-111 / WP-112 / WP-124 / WP-183 / WP-185 / WP-176）

## WP-176：原 provider sidecar（B-only）

`runScenario(scenario, freshRoot, { providerScript: absoluteSidecarFile, inputDirectory?, seedCatalog? })`
直接消费 X5 `providerScripts` / `startLlmService({extraScripts})`，只为当前原 scenario.id 注册脚本。
每次调用新建服务，`${provider.url}` **整值**严格绑定 `llm.baseUrl(scenario.id)`，包含 `/s/<id>/v1`。
没有 sidecar 时该引用仍明确 `unsupported v0 reference`；未知脚本在启动 Electron 前阻塞，无默认公网地址。
不扩任意 provider 模板；原数字原文、`${n.path}`、字符串后缀保持。

CLI 保持三个原位置参数，新增 `--provider-script FILE`、可重复 `--scenario ID`、`--takes N`：

```sh
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- xvfb-run -a node host/e2e/smoke/b-driver.mjs host/plugins/qbank/equivalence/pending-provider/ai-grading-scripted.json --provider-script host/plugins/qbank/equivalence/pending-provider/ai-grading-scripted.provider.json --scenario qbank.ai_grade.scripted.correct_verdict --scenario qbank.ai_grade.scripted.regrade_same_submission_twice --scenario qbank.ai_grade.scripted.http_500 --takes 2
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- node host/e2e/smoke/check-provider.mjs <root>
```

选择不改写原 suite/steps/capture；`input.raw.json` 为完整原字节。单 take 保持 `<root>/<原index>`；多 take 用 `<root>/<原index>/take-N`，每个目录独立 Electron、seed、副本和服务，`runs.json` 记录去向。
`provider.input.raw.json` 保留完整 sidecar 字节；`provider.json` 保存实际 URL、stop 确认、停止后 X5 全请求（原 requestBody/rawHeaders/response headers/chunks/end）。服务在 `finally` 中、Electron 关闭后真实 `await stop()`，seed/启动/步骤失败同样关闭，不以 sleep 代替。

`events.all.json` 保留从启动到 Host 关闭的全量 Host event envelope；旧 `events.json` 与 250ms 观察窗口保持，绝不把尾窗当异步完成。
这三个 qbank 原场景的生产 `qbank_ai_grade` 同步 await 流完成、落库、发 complete/error 后才返回（Rust `pipeline.rs:152–491,1130–1292`；TS `grading-service.ts:349–499`）。验收检查每次 grade 的真实终态先于 invoke 返回，以及准确业务返回/HTTP500 错误；`expect:error` 不接受任意错误。
DB 继续走 X3 关闭写者后的原始全库捕获。A1/A2 unsupported，comparison=not-run，不计 C/G1；WP135 入站大数另包。

入口（从 X1 worktree 执行，经 jobs；依赖现有 Electron / Playwright / Xvfb 和 F2 生成的 `electron/.build/preload.cjs`）：

```sh
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- xvfb-run -a node host/e2e/smoke/b-driver.mjs host/e2e/smoke/scenarios/shell-readonly.v0.json
```

X7 可导入 `runScenario(scenario, freshAbsoluteDirectory)`（`b-driver.mjs`），在自己的 Xvfb 作业中调用。每次调用启动独立真实 Electron + 官方 profile + production preload + production `start()`，HOME/XDG/userData/dataDir 均隔离。命令由页面 `__TAURI_INTERNALS__.invoke` 发出，不直接调用 Host handler。最小页面仅供命令录制；G1 另用 `window-smoke.mjs` 加载真实 `dist`。

返回与磁盘 `B.json` 相同：`schema: wave0-v0-B-raw`、`scenario`、按 steps 顺序的 `results`、按接收顺序的 `events`、`eventWindow`、`rawWire`。业务错误保留 `kind:error`（命令失败并不等于录制失败）；超时为 `kind:timeout`，CLI exit 1。CLI exit 0 只表示录制完成，**不是差分通过**。

- `${n.path}`（含 `.0` 数组索引）与 `${n}` 取先前成功结果，保持原类型；支持 `${0}/w0-file`、`${0.path}/child` 的字符串后缀拼接。非字符串拼接、缺失字段、未来步骤、错误步骤引用直接报错；`null` 是合法整值。多个模板或前缀插值不在既有后缀语法内，明确拒绝。
- CLI 使用 F4 `parseJsonDocument` 校验并保留数字原文为本地 `JSON.rawJSON` 原子。引用递归不会展开该原子；参数以 JSON 文本跨 Playwright，在 renderer 重建后调用原生产 `__TAURI_INTERNALS__.invoke`。普通 `runScenario` 调用方已是 Number 的数字按实际 Number 序列化，无法恢复的精度不补造；已舍入的旧文件也不会恢复。顶层数组会触发生产 preload 的二进制 invoke，JSON source replay 明确拒绝；raw 输入使用下文唯一显式描述。
- `wire.jsonl` 是权威原始记录：Host MessagePort 的 `message.json` / `payloadJson` 和 renderer bridge 的 `body.data` 原文保留。WP-111 起 `B.json` JSON 结果/错误的 `value` 来自按 webContents+callback 关联的响应原文；`rawJson` 保存原文，`wire.invokeSeq/responseSeq` 指回记录。页面已经解析的便捷投影单独保留为 `rendererValue`；后续引用只读无损 `value`，不从 Number 猜回原数字。字节、undefined、timeout 标签保持原语义。
- **当前 Host 入参仍有供方缺口**：main 的 `electron/shell/runtime.ts:280,301` 普通解析 renderer JSON 后只转发对象；WP-183 开工 main 已有 F1 `InvokeRequest.argsJson`（`protocol.ts:48-50`），F2 此发送点尚未消费。WP-111 实测 renderer 的 993/992 不同，Host 请求两者均为 992；CLI exit 0 不能说明 Host 数字保真。后继 F2/134→X1/135 独立验收；本包未绕生产 preload、未替换请求。
- `events.json` 保留完整 Host event envelope（包含关联 ID/target/payloadJson），有顺序、有序号；不排序、不去重、不删事件。当前最小记录窗口为步骤开始至最后一步后 250ms，显式标注；长流式场景需 X5/X7 定义终止条件后扩展，不能据此宣称流完整。
- `expect:error` 仅备注，不改返回值也不决定 A/B 判等。
- 支持 X3 catalog seed 与 `capture.db:["*"]`（WP-183，见下文）；`capture.db:[]` 仍是不捕获、`captured:false`。其他 DB 过滤请求明确 blocked。`normalize:[]` 不变，不擦掉 storageClass。
- `normalize` 是 **JSONPath**。JSON Pointer（`/foo`）拒绝；非空 JSONPath 也明确要求 A1/A2 原件与 C2 审核，本驱动不应用任何变换。后续审核记录必须逐 scenario+JSONPath 写 A 双录差异、原因、精确变换、C2 结论；动态 ID 要一致引用映射，固定错误文本/null/缺失/数字/事件序列不抹除。
- `input.raw.json` 保留输入原件；A1/A2 不由 B 驱动生成或覆盖，`comparison:not-run`。既有 headless A2 记录仍在旧审计引用的原路径。
- shell 五插件探针单列在 `platform-probes.json`：opener 拒绝非法 URL，notification 查权限，clipboard 在独立 Xvfb 写读，updater 只测试非法 timeout 的解析错误，global-shortcut 注册/查询/注销。没有真实更新、安装或应用重启步骤。

## WP-112：B-only raw 文件输入

唯一扩展为 step 的 `rawBody: { file: string, headers?: Record<string,string> }`，与 `args` **互斥**：

```json
{"cmd":"convert_heic_to_jpeg","rawBody":{"file":"valid.heic","headers":{"X-X1-Raw-Probe":"valid-heic"}},"expect":"error"}
```

- CLI 相对路径以输入 scenario JSON 所在目录为基准；API `runScenario(scenario, root, { inputDirectory })` 默认当前 cwd。不解析 raw 文件路径中的引用。先读取所有文件，再启动 Electron；缺失/不可读/目录直接失败，绝不退为空体。空体必须来自真实零长度文件。
- 不新增 bytes/base64/URL 等配置形式。step 只允许 cmd/args/rawBody/expect；rawBody 只允许 file/headers。未知字段、空路径、非字符串 headers 或非法 HTTP header 明确拒绝。`args` 对象中名为 rawBody/bytes 的业务字段仍按 JSON 传递。
- 文件字节用 Buffer 载入，经 Playwright 的 base64 **载体**送到页面，在页面构造 `Uint8Array` 后调用真实 `__TAURI_INTERNALS__.invoke(cmd, bytes, {headers})`。preload 自行生成 `application/octet-stream`；不手工调用 Shell/Host、不改变协议、不用 JSON 数组冒充 Request body。
- `step-N.input.bin` 是发送的源字节副本，`step-N.json.rawInput` 记录来源路径/长度/配置 headers。`wire.jsonl` 保留真实 headers/contentType，并在 renderer IPC 与 Host MessagePort 发送观察点附加 `binary: {type,byteLength,base64}`（只观察，原消息原样转发）。`check-raw-body.mjs` 用 `Buffer.equals` 比对源文件、副本、两段 wire，验证确实收到 Uint8Array（包括空数组视图）；不增加哈希。
- **A blocked**：此 rawBody 为本 B driver 的局部扩展，不是共享 v0 或 A 驱动已支持的声明。`B.json.rawBodySupport.A` 明确标 blocked，a1/a2 仍 null、comparison:not-run、C=0。交给 A 时必须先确认其实现支持；不能忽略 rawBody 后用默认 `{}` 冒充已执行。

### 命令、Rust 来源与 headers

选定 L18 `convert_heic_to_jpeg`：Rust 注册 `src-tauri/src/lib.rs:1917`，入口 `src-tauri/src/heic_decoder.rs:79–83` 接收 `tauri::ipc::Request`；`:53–70` 只接受 Raw，空体和 >50MiB 分别拒绝；`:135–140` 桌面平台对其余非空体保留 `HEIC_UNSUPPORTED_PLATFORM`。**没有读取任何自定义 headers**。场景中的 `X-X1-Raw-Probe` 仅证明生产 headers 透传，不是业务参数或内容类型覆盖。

对应已发布协议 `electron/shell/bridge-messages.ts:11–23`；生产序列化 `electron/preload/bridge.ts:79–122`；Shell `electron/shell/runtime.ts:277–301` 将 raw Uint8Array 和 headers 交 Host。L18 `host/plugins/media/index.ts:352–365` 经 `call.payload` 消费 F7 `nativeHeic`，`host/platform/native/heic/index.ts:4–15` 保留桌面错误。

三类 raw 输入 + 一条 JSON 对照（未改原 production 预算，单步仍 10s）：

```sh
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- node host/e2e/smoke/prepare-raw-body.mjs
# 将上一条输出的实际 scenario 路径填到下一条；它生成 empty.bin / valid.heic / invalid.heic。
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- xvfb-run -a node host/e2e/smoke/b-driver.mjs <generated-raw-body.v0.json>
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- node host/e2e/smoke/check-raw-body.mjs <CLI-output-root>
```

合法 HEIC（656 字节）的来源/许可见 `__fixtures__/RAW-BODY-FIXTURE.md`；非法文件为 7 字节 `00 ff 80 01 0d 0a 7f`。两者在桌面都应返回原平台错误，**不是解码成功或文件内容校验成功**。空体应为 `HEIC_INVALID_INPUT: empty image body`；JSON `{bytes:[...]}` 应为 `expected raw binary request body`。所有生产返回值/错误继续保留原文。

WP-111 最小生产链原件与分段验收（第二条在上述 F2/F1 缺口存在时必须报红）：

```sh
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- xvfb-run -a node host/e2e/smoke/b-driver.mjs host/e2e/smoke/scenarios/source-fidelity.v0.json
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- node host/e2e/smoke/check-source-fidelity.mjs <上一条输出的root>
```

`insight_list.offset` 为生产契约 `Option<i64>`，993/992 均合法；小 limit + 空库无大分配。原件直接以十进制文本写入，未用 Number 生成。路径来自真实 `get_pdf_ocr_temp_dir` 返回值。`precision-check.json` 单列 renderer / Host 检查及 wire 序号；失败不改成通过。

真实 dist 路由探底：

```sh
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- env NODE_OPTIONS=--max-old-space-size=8192 npm run build
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- node electron/scripts/build-preload.mjs
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- xvfb-run -a node host/e2e/smoke/window-smoke.mjs
```

页面导航用生产 `NAVIGATE_TO_VIEW` / `SETTINGS_NAVIGATE_TAB` 事件与实际 Apps 面板点击。所有导航失败同样保存截图、DOM 文本、ARIA snapshot、console/IPC 原件；受 gate 控制的入口和缺少资源种子的入口显式标注。`plugin:host|status` 只返回 degraded 数组，绝不把它冒称 installed 列表；安装数量由真实 HostReady、实际选中 profile、profile-failed 事件及 degraded 状态共同判断，并在 summary 标明证据口径。

## WP-124：B-only 显式终态屏障（`waitFor: "backup-job-terminal"`）

只支持这一组事件。step 可加 `waitFor:"backup-job-terminal"`（与 `rawBody` 互斥，其他值拒绝）。**A unsupported**：此字段是本 B driver 的局部扩展，不是共享 v0 或 A 驱动已支持的声明；`B.json.waitForSupport.A` 明确标注，a1/a2 仍 null、comparison:not-run、C=0。格式提案与事件原件交 C1/X7（L21 README §5.1 的终态等待需求），不改共享 runner 或既有语料语义。没有 waitFor 的 step 行为不变。

来源：Rust `src-tauri/crates/dstu-sync/src/backup_job_manager.rs:973-984` 发 `backup-job-progress`，载荷 `BackupJobEvent`（`:166-196`，`job_id`/`status`），`BackupJobStatus::is_terminal`（`:86-92`）= completed/failed/cancelled。B 端同名事件 `host/plugins/backup/src/jobs.ts:181`。前端参照 `src/hooks/useBackupJobListener.ts`。

- **订阅/取消**用已公开能力，同 `@tauri-apps/api/event` 的 `listen`/`_unlisten`：renderer 中 `__TAURI_INTERNALS__.transformCallback` + `invoke('plugin:event|listen',{event,target:{kind:'Any'},handler})`，结束时 `__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener` + `invoke('plugin:event|unlisten',{event,eventId})`。经生产 preload → Shell `electron/shell/plugins/event.ts` → Host `backendEvents`，不直接调 Host。
- 顺序：listen 完成 → 发命令 → 按**命令实际返回的 `job_id`** 等首个终态 → unlisten。终态在 invoke 返回前到达时已在 renderer 缓冲中，不会漏。其它 job 或非终态事件不解除等待。
- 结果：`result.barrier.outcome` = `terminal`（附 `status`）| `not-started`（命令返回业务错误，原 error 不变）| `runner-error`（返回值无字符串 job_id、页面失败、listen/unlisten 失败）| `runner-timeout`。所有结局都执行 unlisten；listen 失败时**不发命令**。`runner-*` 让 `B.json.runner` 为 `blocked: …`、CLI exit 1，**不当作业务错误或完成**。
- 预算：WP-185 起 listen / invoke / wait / unlisten / buffer read **共用原单步 10s 单调 deadline**（`STEP_BUDGET_MS`）。WP-124 原来只有 invoke/wait 消费 remaining，不能证明整个屏障的上限，已由 WP-185 反证与修复。85s/175s/180s 保持。
- 事件：`events.json` / 250ms 尾窗语义不变（所有 Host event 原序保留，包含 create_job 在命令返回前同步发出的 queued 事件）。`barrier.received` 是本 listener 的 renderer 原序缓冲；`barrier.wire` 给 listen/命令/结果/终态 emit/Host 终态/Host 结果/unlisten 的 wire 序号、unlisten 之后的投递（应为空），以及 `terminalBeforeInvokeReturn` / `hostTerminalBeforeResult` 竞态标记。

```sh
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- xvfb-run -a node host/e2e/smoke/b-driver.mjs host/e2e/smoke/scenarios/backup-job-terminal.v0.json
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- node host/e2e/smoke/check-job-barrier.mjs <上一条输出的root>
```

场景只在隔离 empty 数据目录运行：`run_backup`（completed）、`import_zip` 指向 `/`（后台 `无法读取 ZIP 文件` → failed，用于先终态后返回竞态）、不存在 ZIP（同步业务错误 → not-started）。真实 cancelled 终态需要在任务进行中并发取消，v0 串行步骤表达不了，只有单元测试覆盖解除监听分支；不使用替身服务冒充业务取消。

### WP-185：预算到期与迟到清理

屏障到期返回 `runner-timeout`；已有业务 result/error 保留，但不算步骤完成。剩余预算耗尽不再启动业务 invoke/wait/read，仍发起一次 unlisten；所有 page 调用均不在 deadline 后继续等待。正常终态、先终态后 invoke 返回、not-started 的接线不变。

`barrier.cleanup.state` 区分 `unlistened`（预算内确认）、`pending`（没有确认）、`unlisten-failed`、`listen-failed`，以及迟到的 `late-unlistened` / `late-unlisten-failed` / `late-listen-failed`。失败状态保留 reason；有 listener id 时保留 id。listen 拒绝不代表可证明 Shell 没有注册；原生订阅失败时移除已创建的 renderer callback。迟到 listen 成功后仍调用真正的 unlisten，且不补发业务命令；迟到 unlisten 的确认/失败更新 cleanup，不反转 timeout。`runWithBarrier` 的 `settled` 仅供受控验收等待实际迟到清理，生产 B 驱动不等待它，否则不 settle 的清理会再次造成挂起。

`Promise.race` 只取消本地 timer，不取消底层 page 调用。`pending` 绝不等价于已清理：驱动终止后续步骤并沿既有 `driver.close()` 关闭隔离 Electron/Host，最终保存能观察到的 cleanup 和 wire 原件；页面永久不响应时以进程关闭收尾，不宣称已收到 unlisten ack。事件缓冲保留为证据，renderer callback 经原公开 unregisterListener 释放。

受控真实 Electron 验收（原10s，握手释放，无任意延迟）：

```sh
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- xvfb-run -a node host/e2e/smoke/check-barrier-deadline.mjs
```

该脚本用 page adapter 在真实订阅返回后或真实解除之前持有一个 renderer evaluate；直接调用生产 B 用的 `runWithBarrier/liveOps/pageOps`。原件记录 deadline 返回时 callback 仍存在、释放后真实 unlisten ack、主动 emit 后零投递/零 callback；永久未 settle 的页面调用由真实 Electron 关闭拒绝。它是受控传输失败证据，不冒充生产业务故障发生率或 A/B golden。

## WP-183：X3 catalog → 单次副本 → SQLite 原始终态（Linux）

供 X7 的精确入口（不新增 seed 协议，直接使用 X3 `SCENARIO-V0.md`）：

```js
// 调用方先用 X3 createSeed(name, catalog) 构造一次并关闭所有写者。
// runScenario 不接受运行中的应用数据目录，不改 catalog 源。
await runScenario(scenario, freshAbsoluteRunDirectory, {
  inputDirectory: scenarioFileDirectory, // rawBody 相对路径；默认 cwd
  seedCatalog: absoluteX3CatalogDirectory,
});
```

- `resolveSeed(scenario.seed, seedCatalog)` 解析，检查源无打开句柄，随后恰好一次 `copySeed(name,catalog,<run>/seed)`，全部在 Electron 启动之前完成。目标必须为空；不覆盖/重用旧副本。省略 catalog 仅允许 `empty`，在 `<run>/seed-catalog` 用 X3 构造再复制。
- 名称由 X3 公开 API 决定，不私造别名、路径占位符、SQL seed 或表过滤；首验为 `historical-wp013-v1` 与 `empty`。前者是 **SQL 构造夹具**，不是 A 实录/发布物。`skill-zip-v0` 可由同一 API 解析复制，但本包不声称其业务验收。
- 目录：`HOME=USERPROFILE=<run>/seed/home`；`DS_APP_DATA_DIR=copy.dataDir=<run>/seed/app-data`；`XDG_DATA_HOME=LOCALAPPDATA=copy.dataLocalDir=<run>/seed/local-data`。F2 生产 `start()` 用 DS_APP_DATA_DIR 发 Host handshake；F3 `locations.ts:dataLocalDir()` 读取 XDG_DATA_HOME。Chromium userData/config/cache/tmp 仍独立位于 run 外层。`launch.json` 和 `seed.json` 保存实际映射，wire `host-start.handshake` 证明 Host 收到的 appDataDir。
- `capture.db:[]` 不调用 snapshot，仍 `db:{requested:[],captured:false}`。仅 `["*"]` 触发全库捕获；`['notes']`、混用/重复 `*` 明确 `blocked: unsupported capture.db`，验证阶段抛错、CLI 非零，绝无 captured=true。
- 步骤及 WP-124 终态屏障完成后，仍经生产 Electron `before-quit → HostSupervisor.shutdown()` 关闭。观察器仅记录原方法调用、每次 Host start/spawn/exit 及 shutdown 完成；要求 Electron exit0、所有观察到的 Host exit0、shutdown 完成，再扫描副本的打开句柄，才调用 X3 `snapshotDirectory(copy.directory)`。SIGKILL/重启异常/未关闭 Host/仍有打开句柄/读取失败均 blocked。没有重写 shutdown，也不以固定 250ms 尾窗替代写者关闭。
- 句柄检查是 Linux `/proc/<same-uid-pid>/fd`，拒绝该隔离目录中的任意打开句柄（包括只读句柄）；检查不可访问就失败，不忽略。前置是同用户、合作式测试目录，不支持其他平台或外部写者边复制边启动；不宣称跨用户锁协议。
- 成功保存 **X3 原始 DirectoryState** 到 `<run>/B.db.raw.json`，不额外包装/过滤/normalize；包含所有 DB、全部 schema、表、i64 十进制字符串、storageClass、FTS/shadow、trigger 副作用。`B.json.db` 给 `file/directory/files/closure`；closure 指回 wire shutdownSeq/hostExits 与 Electron exit。源读取/复制/启动/关闭/快照失败保留 `runner:"blocked: …"`、`db.captured:false`，CLI exit1；不写成功快照。非法 scenario 与 raw 文件输入仍按原验证错误抛出。
- `scenario.json`、套件 `input.raw.json`、step 原件、`wire.jsonl`、events 与 DB 位于同一 run；不生成 A1/A2/golden，`comparison:not-run`。DB 差异并非业务差分裁决。

CLI 第四个位置参数为 catalog（输出目录必须一并指定）：

```sh
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- xvfb-run -a node host/e2e/smoke/b-driver.mjs <suite.json> <fresh-output-directory> <X3-catalog>
# 最小真实验收：一次构造 source + 未运行对照副本，再跑历史/empty 两个真实 Electron 场景。
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- xvfb-run -a node host/e2e/smoke/run-seed-capture.mjs
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- node host/e2e/smoke/check-seed-capture.mjs <上一条输出的root>
```

`notes_get → notes_update(title) → notes_get` 经原 renderer/preload/Shell/Host，owner 为已 main 的 L10；`notes_update` 注册在 `host/plugins/notes/index.ts:273-284`，Rust `src-tauri/src/cmd/notes.rs:1245`。不直接写 SQL。empty 用同一 `note_old` 读取失败及 `notes_list=[]` 作为负对照。验收保留整个 source→B raw diff（包括启动迁移/后台写入），断言源及另一副本的原 DB 字节/全库状态不变；没有将所有差异都归因于那一次 title 更新。
