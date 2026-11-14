# W14 可移植平台服务：进度

分支 `assault/W14-portable-platform`（worktree `wt/W14`）。只建地基，不改业务插件。

| 步骤 | 状态 | 提交 |
|---|---|---|
| 1. `ctx.crypto` 接口 + Node 实现 + WebCrypto 实现 + 双实现测试 | 完成 | `8c532ae` |
| 2. `ctx.files` 接口 + Node 实现 + 根目录包含判断测试 | 完成 | `dad2fd2` |
| 3. `ctx.http` 接口 + 桌面实现（复用 llm `http_proxy.ts`）+ 测试 | 完成 | `7d6a6c2` |
| 4. 插件平台声明 `meta.platforms` + profile 按平台过滤 + `mobile.json` | 完成 | `2dc85ce` |
| 5. `scripts/portability/` 扫描器 + 基线 + 工作量报告 | 完成 | `adc92b9` |
| 6. `host/platform/API.md` 新章节与迁移指南 | 完成 | `f8661bf` |
| 7. 收尾验证（新服务测试、`host/platform` 全量、tsc、boundaries） | 完成 | 见下 |

## 收尾验证（2026-11-07 03:20 前后，本机 macOS arm64）

- W14 新增测试 119 个全绿：crypto 61 + 3、files 23 + 11 + 1、http 13 + 1、profiles 6；扫描器 `node --test` 10 个全绿。
- `host/platform` + `host/profiles` 全量（经 `bin/heavy`）：1501 个，通过 1468、失败 23、跳过 10。失败全在 W14 未触碰的文件：
  `storage/startup-busy-handler`（8）与 `native/sqlite-busy`（13）= 缺 darwin-arm64 预编译（已知环境问题）；
  `native/fsrs-optimizer` 的 abort 用例（WASI 优化器 150ms 内就跑完，abort 来不及）与 `native/xml` 的 3000 层嵌套
  （`Maximum call stack size exceeded`）单独重跑仍失败，属本机环境，W14 没有提交涉及 `host/platform/native` / `storage`。
- 全量 `tsc -p tsconfig.host.json`（经 `bin/heavy`）：0 错误。
- `boundaries.mjs`：4 条违规，全在 `electron/storage-migration/`（W07，W14 未改）；W14 新增文件 0 违规。
- `node host/profiles/generate.ts --check`：两个 profile 均最新；`scan.mjs --check`：0 新增；`--profile mobile.json`：0 违规。

## 决策记录

- `PluginMeta` 在 `host/kernel/api.ts`（不归 W14），平台声明先用模块增强挂在 `host/profiles/platforms.ts`，
  交接 W01 并入 kernel。
- 代理逻辑已有 llm `http_proxy.ts`/`system_proxy.ts` 一份完整实现（env → 系统代理 → NO_PROXY/系统例外），
  `ctx.http` 桌面实现直接复用它，不写第二套；第二阶段把这两个文件下沉到 `host/platform/http/`。
- WebCrypto 没有同步/增量摘要：Web 实现的异步接口只用 `crypto.subtle`，同步/增量哈希用已有依赖
  `@noble/hashes`（纯 JS，无 Node）。WebCrypto 拒绝零长度 HMAC 密钥，Web 实现用等价的全零块密钥。
- `ctx.files` 原子写复用 `paths/compat.ts` 的 `atomicWriteFile`（不再新增一份）；流式原子写需要自己的临时文件处理。
- 扫描器基线按（文件, 依赖键）的出现与否记录，不按次数/行号，避免漂移；已声明仅桌面的插件豁免。

## 关键发现

- `host/kernel/api.ts`（全部 26 个插件值导入）、`host/platform/util/index.ts`（25 个）、`host/platform/errors/api.ts`（19 个）
  的运行时闭包含 `node:http` / `node:zlib` / `node:crypto` / `Buffer` / `process`：插件自身再干净也无法装进移动端，
  需要先拆出可移植入口（交接 W01 与平台 owner）。
- 隐性依赖最多的是全局 `Buffer`（262 个文件），多于 `node:crypto`（218）和 `node:fs`（210）。

## 第二轮：拆掉三个门户入口

| 步骤 | 状态 | 提交 |
|---|---|---|
| 1. `util/portable.ts`（纯函数 + `TextEncoder`/`TextDecoder`）；ZIP → `zip.ts`、QR → `util/qr.ts`（桌面子模块）；`errors/api.ts` 闭包干净 | 完成 | `d3d1197` |
| 2. `kernel/core.ts` 可移植入口；`ShellError` → `shell-error.ts`；iLink → `host/plugins/ilink/`；`PluginMeta.platforms` 收进 kernel，删除 profiles 模块增强 | 完成 | `0a45d33` |
| 3. `http_proxy.ts` / `system_proxy.ts` 下沉到 `host/platform/http/{proxy,system-proxy}.ts`，llm 原位置 re-export | 完成 | `02fabf9` |
| 4. `dstu.integration` 装进 `mobile.json`（`compareUtf8`、改 import 路径、声明双平台） | 完成 | `eba0079` |
| 5. 基线与报告 | 完成 | `98f1daa` |
| 6. API.md（platform / kernel） | 完成 | `9812802` |

决策：

- iLink/QR 从 `kernel/api.ts` 删除而非保留 re-export：引用方只有 `kernel/plugins.ts`、3 个 kernel 测试和
  `host/e2e/streaming/fixed-https/probe-b.ts`，全部改路径；保留 re-export 会让 `api.ts` 永远带 Node。
  因此 `api.ts` 本身也可移植，26 个插件的 `definePlugin` 导入无需改动。
- `util/index.ts` 继续导出全部内容（含 ZIP、QR 与返回 `Buffer` 的 `decodeBase64Standard`），兼容 357 处值导入；
  `util/portable.ts` 的其余导出与 `index.ts` 是同一个值，`decodeBase64Standard` 返回 `Uint8Array`。
- 501 状态短语改为按词拼接（字面量会命中边界规则 todo-marker），不再依赖 `node:http`；测试与 `STATUS_CODES[501]` 比对。
- `TextDecoder` 设 `ignoreBOM: true`，与 `Buffer#toString` 一样保留 BOM（有测试）。
- llm `createLlmHttpClient` 包装平台 `createProxyHttpClient` 并注入 llm 的 `logInfo`/`logWarn`，日志路由不变；
  `ctx.http` 用 `ctx.logger('dstu_http::proxy')`。
- review 不能在本轮装进移动端：剩余阻塞在 `platform/native/wasm/loader.ts`（fsrs WASM：`node:wasi`/`worker_threads`/`fs`）、
  `anki/src/card-utils.ts`（`node:crypto`/`node:path`/`Buffer`）与 review 自身 4 处，均不在本轮可改范围；
  改用最干净的 `integration` 证明机制。

数字（插件生产文件；运行时闭包 = 传递依赖）：

- 门户：`kernel/api.ts`（26 插件）、`errors/api.ts`（19 插件）从「传递依赖」表消失；`util/index.ts` 去掉 `node:http`。
- 闭包完全不触达 Node 的文件：335/1429（23.44%）→ 367/1433（25.61%）；闭包干净的插件入口 0 → 1（integration）。
  若各插件把 `util/index.ts` 值导入改为 `util/portable.ts`：可到 448（31.26%）。
- 直接依赖口径（REPORT）：运行时可移植 893 → 897，总工作量 74.13 → 73.85 人日，学习伴侣范围 35.33 → 34.85 人日。

收尾验证（本机 macOS arm64）：

- `host/kernel` + `host/platform` + `host/profiles` + 插件 ilink/integration/llm/media/review（经 `bin/heavy`）：
  4201 个，通过 4165、失败 24、跳过 12。失败均为已知：sqlite-busy 13、startup-busy-handler 8、fsrs-optimizer 1、xml 1、
  media `bilibili-bridge-server` 1（工作区缺 `src-tauri/resources/bilibili/`，stash 后基线同样失败）。
- 扫描器 `node --test` 10/10；全量 `tsc -p tsconfig.host.json` 0 错误；`boundaries.mjs` 仍是 W07 的 4 条；
  `generate.ts --check` 两个 profile 最新；`scan.mjs --check` 0 新增；`--profile mobile.json` 2 个模块、0 触达 Node。

## 第三轮：F1 补丁、WASM 可移植、移动端存储设计

| 任务 | 状态 | 提交 |
|---|---|---|
| 1. 吸收 `.transfer/inflight/F1-kernel.patch`（WP-287） | 完成，TESTMAP 段未落 | `bd8af43` |
| 2. WASM 加载器可移植化 | 完成 | `30f897aa` |
| 3. 移动端存储设计 `storage-mobile/DESIGN.md` | 完成（仅设计） | `699ec858` |
| 4. 收尾验证 | 完成 | 见下 |

F1 补丁（WP-287，云同步配置入站的 internal-tag struct enum 校验）：

- 落地 `kernel/serde.ts`（`checkInternalStructEnum`）、新测试 `kernel/tests/cloud-config-inbound.test.ts`（16 个；改 serde 前 14 红，改后全绿）、
  `migration/spec/F1-kernel.md` 的 WP-287 说明段（无勾选）。
- **未落**：补丁里的 `migration/testmap/F1-kernel.md` WP-287 段（TESTMAP 禁改），交主代理处理。

WASM 可移植（`host/platform/native/`）：

- `wasm/core.ts`：可移植核心。`compileWasm` 接受 `Uint8Array`/`ArrayBuffer`/`Response`/`Promise<Response>`，
  `application/wasm` 时走 `compileStreaming`。还包括协议常量、日志 sink 和 `WasmCancelledError`（`loader.ts` 原样再导出，是同一个对象）。
- `wasm/loader.ts`：桌面适配器，行为不变（读盘、`node:wasi` + worker、`runWasmSync`），只改为经核心编译。
- `wasm/wasi.ts` + `engine.ts`：手写的内存版 WASI preview1，恰好实现 F7 模块声明的 17 个导入；`/out` 与只读 `/media` 是内存目录。无新依赖。
- `wasm/web.ts`：移动端 / Web 适配器，按 URL fetch，默认 `new URL('./f7-native-wasm.wasm', import.meta.url)`，交给打包器处理。
- `fsrs/core.ts`、`tokenizer/core.ts`：桌面与 Web 共用的业务逻辑；`index.ts` 的导出不变。
  新增 Web 入口：`fsrs/web.ts`、`tokenizer/web.ts`（`tiktoken/init` + 调用方提供的 `.wasm`）、`argon2/web.ts`（`@noble/hashes`，已是依赖）。
- 证据：
  - `tests/wasm-portable.test.ts`（jsdom，7 个）：9 个可移植入口的运行时闭包 0 触达 Node；`.wasm` 只经 `fetch` 获取；
    FSRS evaluate / tokenizer / Argon2 与桌面金值一致。
  - `tests/wasm-portable-desktop.test.ts`（5 个）：把桌面路径钉在同一组金值上。
  - `scripts/portability/browser-wasm-smoke.mjs`：Vite + headless Chromium 148 实跑，`process` 不存在，三项全部一致，
    报告存于 `browser-wasm-smoke.report.json`。
  - 发现：FSRS `rmseBins` 在桌面 `node:wasi` 上同样有末位 f32 抖动（约 1e-8）；按现有 optimizer 测试的做法用 1e-6 容差比较。
- 改了 `fsrs/index.ts`、`tokenizer/index.ts`（不在 `wasm/**` 内，但这是本任务的必要改动）。
  已核对，其他 assault 分支和工作树都没有改这两个文件。

收尾验证（本机 macOS arm64，经 `bin/heavy`）：

- `host/kernel` + `host/platform` + `host/profiles`：1870 个，通过 1837、失败 23、跳过 10。
  失败均为已知：sqlite-busy 13、startup-busy-handler 8、fsrs-optimizer「signal 中止」1（stash 基线同样失败）、xml 1。
- 使用方插件：review、chat-pipeline、llm 两个 tokenizer 测试，共 96 个文件 / 818 个测试全绿。
- 全量 `tsc -p tsconfig.host.json` 0 错误；`boundaries.mjs` 仍是 W07 的 4 条（本轮新增的 1 条已修）；
  扫描器 `node --test` 10/10；`scan.mjs --check` 0 新增；`generate.ts --check` 两个 profile 都是最新。

交接：

- F1 TESTMAP WP-287 段待主代理落地。
- 移动端存储依赖申请：自编 `sqlite3.wasm`（3.53.4，编译选项对齐桌面）或 `@sqlite.org/sqlite-wasm`。
  W08 释放 `host/platform/storage` 后，先抽 `Connection`、迁移 SQL 来源和 fingerprint 哈希三个端口，再做 spike S1–S6（见 DESIGN.md §7）。
- review 装进移动端还差：把 `fsrs/index.ts` 的值导入改为经 `ctx.nativeFsrs`，或改用 `fsrs/web.ts`；
  另有 anki `card-utils.ts` 与 review 自身的 4 处 Node 依赖（上一轮已交接）。
- 移动端打包时 tiktoken 的 `.wasm` 用打包器的资源 URL（如 Vite 的 `tiktoken/tiktoken_bg.wasm?url`）传给 `loadWebTokenizer`。

## 2026-11-07 午间轮：util 桶去 Node、storage 棘轮、遗留六项（基于 INT `fd621db5`）

| 任务 | 状态 | 提交 |
|---|---|---|
| 1. util `index.ts` / `api.ts` 删掉 Node 再导出，导入方改走 `util/node.ts`，`entries.test.ts` 收紧 | 完成 | `9c9c63e8` |
| 2. storage 棘轮：只剩 profile-isolation？——核实后不是，见下 | 完成（交接） | `fc388b16` |
| 3a. `ctx.http.checkPublicPinned` | 完成 | `1088849f` |
| 3b. `destination: 'public'` + `allowLoopback: false` | 完成 | `1088849f` |
| 3c. storage `api.ts` 声明 `getPersistentAppDataDir` / `getTempAppDataDir` | 完成 | `ccabdba1` |
| 3d. `storage/node.ts` 导出 W10 要的 5 个函数 | 完成 | `7e798710` |
| 3e. coordinator 接线 `ensurePendingMemoryCandidatesSchema`（W07 r5） | 完成 | `aebcc2df` |
| 3f. `ctx.files` 按位置读写句柄（W08 移动端备份） | 完成（桌面 + OPFS） | `a18a1ec7` |
| 附. portability 文档刷新、修 `scan.test.mjs` 过期断言 | 完成 | `83dc83db` |
| 附. file-manager / staged-upload 的导入改成与 W07 `559ac6d4` 逐字相同 | 完成 | 见 git log |

util 桶：

- `index.ts` = `portable.ts` 原样；`api.ts` 只剩可移植声明，`decodeBase64Standard` 是 `base64-core.ts` 的 Uint8Array 版。
  ZIP 类型移到 `zip.ts`；ZIP、QR、Buffer 版 base64 只从 `node.ts` 导出。
- `entries.test.ts` 断言：两个桶的每个导出与 `portable.ts` 是同一个值、不含任何 Node 名字、闭包为空；
  `node.ts` 与 `portable.ts` 只共有 `decodeBase64Standard` 且两者不同。PENDING_IMPORTERS 棘轮删除（tsc 已经能拦）。
- `--mobile-readiness` 前后（同一 INT 基线）：网关合计 151 → 116；以 util 桶为网关的插件 31 → 0；
  网关背后的 Node 文件数合计 3573 → 3227；就绪插件仍是 1 个（integration）。21 个插件的网关数下降（明细见交付报告）。
- 已核对所有 assault 分支：没有分支相对自己的 merge-base 新增从 util 桶导入被删名字的代码；
  当前代码里也没有人从 `util/index.ts` / `api.ts` 取 `decodeBase64Standard`（都走 `node.ts` 或 `portable.ts`）。

storage 棘轮的漏洞：

- 旧棘轮只认 `platform/storage/api.ts` 这类字面路径，漏掉 `../api.ts` 等相对导入。改为先解析说明符再比较，
  另加一条测试证明相对路径能被识别。
- 结果：除 `host/kernel/tests/profile-isolation.test.ts`（W01）外，还有 15 个 W07 的 storage 测试 / 夹具从 `api.ts` 取 Node 值。
  名单固定在 `storage-mobile/tests/storage-entries.test.ts` 的 PENDING_IMPORTERS 里（逐文件、逐名字，必须完全一致）。

ctx.http：

- `checkPublicPinned(url, { allowLoopback? })`：与 `public-pinned` 同样解析并校验，不建立连接，失败抛同样的 `HttpError`；
  没有 pinned transport / 解析器的平台抛 `UnsupportedOnPlatform`。
- `public` 的 `allowLoopback` 缺省仍为 true（与 Rust 一致）；显式 false 时拒绝回环字面量、`localhost` 和解析到回环的名字，
  每一跳重定向都检查。解析逻辑抽成 `resolvePinnedAddress`，与 pinned transport 共用。测试 `http/tests/public-loopback.test.ts` 8 个。

coordinator 接线：

- mistakes 库校验通过（`after_verification`）后调用修复；不写 refinery 历史、不进指纹。
  修复失败只记 warn，迁移照常成功，表保持 Rust 的样子。
- RF-W07 的三条测试改为经 `runAll` 验证（v0.9.2 旧表在迁移前种入），另加失败路径（同名视图）和日志两条。
  去掉接线后三条 RF 测试变红。

`ctx.files.openFile`（按位置读写句柄）：

- `openFile(path, { mode, createParents?, unixMode? })`，`mode` = `read`（默认）/ `readWrite` / `create` / `truncate` / `exclusive`。
  返回 `RandomAccessFile { path, mode, size, read(position, length), write(data, position), truncate, sync, close }`。
  结构上就是 ZIP 核心的 `ZipByteSource` / `ZipByteSink`，`ZipReader.open(handle)` / `new ZipWriter(handle)` 可以直接用。
- 桌面：`fs/promises` 的 FileHandle，包含判断与其他操作相同（词法 + 真实路径）。
- OPFS：`read` 模式不加锁，每次读取用 `getFile()`，主线程也能用；写入模式持有 `FileSystemSyncAccessHandle` 直到 `close()`，
  期间同一文件的其他写入抛 `Other`（`NoModificationAllowedError`），读取不受影响。不在 Worker 中时写入模式抛 `UnsupportedOnPlatform`。
- 新增 3 个一致性用例（按位置读写、各模式、ZIP 往返），在桌面、内存 OPFS 和真实 Chromium Worker 三处都跑；
  平台差异单独测（锁、无同步句柄、配额、符号链接逃逸、权限位、桌面允许两个写入句柄）。变异验证：两处改动各让对应用例变红。

验证（本机 macOS arm64）：

- 单文件测试：util 35、native/log 80、storage-entries 6、http 33、fetch-chat-executor + paper-save 26、
  pending-memory-candidates 5、files + opfs 85，全部通过。
- 迁移相关 16 个文件（经 `bin/heavy`：storage coordinator / migration-* / startup / service / repairs / definitions，
  anki anki-db / pending-memory-writer，backup migration-behavior / backup-manager，sync-providers business_tables_sync，
  e2e data-compat g3-slot-seeds / owner-databases）：366 通过、1 跳过。
- 移动端 e2e `mobile/tests/files-opfs.spec.ts`（经 `bin/heavy`，真实 Chromium）：2/2；`mobile` 的 `tsc --noEmit` 0 错误。
- 门禁：`boundaries.mjs` 0 违规；`import-cycles --check` 0 新增；`rust-fixes --check` 0 错误（52 条登记、68 个标记）；
  `scan.mjs --check` 0 新增 / 0 消除，mobile profile 4 个模块 0 触达 Node；`contracts:check` OK；
  `tsc -p tsconfig.host.json`（经 `bin/heavy`）0 错误；扫描器 `node --test` 13/13。

路径归属说明：

- `host/platform/files/**`、`host/platform/http/**` 不在本波 §6 任何一行里（W14 第一波创建）；本轮按 INTEGRATION-NOTES 的点名在这里实现。
- 改到别人路径的地方（都只为本轮任务所必需）：`storage/node.ts`（W07，按点名导出 5 个函数）、
  `storage/tests/pending-memory-candidates-schema.test.ts`（W07，接线后旧断言描述的是未接线状态）、
  `storage/file-manager.ts:16`、`storage/staged-upload.ts:15`（W07，现与 W07 `559ac6d4` 逐字相同，合并无冲突）、
  `log/diagnostics-sanitize.ts:5` 与 `native/tests/` 6 个测试的导入行（W01）。

交接（文件 + 行号见交付报告）：

- W01：`kernel/tests/profile-isolation.test.ts:28` 的 `syncStateDatabasePath` 改从 `platform/storage/node.ts` 导入；
  `API.md` 的 util / zip / files / http 段落按本轮更新。
- W07：15 个 storage 测试的 Node 值改从 `node.ts` 导入；RF-W07-pending-memory-candidates-schema 的说明与 G3 选择器
  （新库现在有整张表，不止 `subject` 列）。
- W08：移动端备份可直接用 `openFile` 句柄配 `zip/core`。
- S01 / W03 / W10 / W06：`checkPublicPinned`、`allowLoopback: false`、`storage/node.ts` 导入、`getPersistentAppDataDir`、net-policy 纯 IP 拆分。

## 2026-11-07 下午轮：defineQuery 叶子模块、备份根、去 Buffer 垫片、Linux 棘轮核对（基于 INT `6c491e6f`，合并 `0e7b7ee9`）

| 任务 | 状态 | 提交 |
|---|---|---|
| 1. `defineQuery` 移到可移植叶子 `storage/query.ts`；`api.ts` 的 Node 再导出逐个评估 | 完成（其余交接 W07） | `45b3692a` |
| 2. 备份根：`FilesService.backupRoot`（桌面 + OPFS）+ 一致性用例 | 完成 | `7992f87a` |
| 3. 删 `mobile/src/worker/node-globals.ts`、其导入和 `buffer` 依赖；完整移动端 e2e | 完成 | `68567604`、`5b7b93d0` |
| 3 附. 移动端迁移补 `pending_memory_candidates`（e2e 暴露的回归） | 完成 | `68567604` |
| 4. Linux 全量（INT `1fcc7743`）两个棘轮失败 | 核对完：名单过期，非平台问题，无需改代码 | — |
| 5a. 扫描器：`--write-baseline` 不再给豁免文件加键（INT `3380c140` 被迫手改基线） | 完成 | `274958d7` |
| 合入 INT `fe5feb68`（第四批） | 无冲突；W01 删掉的 profile-isolation 名单行自动合入 | `540e69eb` |
| 5b. `pinned-policy.ts` 改从 `net-policy/ip.ts` 取纯 IP 判定；前缀/消息统一取 W01 的 `errors/unsupported-on-platform.ts` | 完成 | `40e34b91` |
| 5c. 移动端 Worker 日志导出器补 `levels: WARN`（之前所有 warn 被静默丢弃） | 完成 | `c0e24494` |
| 5d. 移动端 hostCall 带 `caller: 'dstu.mobile.diagnostics'`（W01 SEC-E06 交接） | 完成 | `cfdd082a` |

storage `api.ts`：

- `query.ts` 只有 `import type`，闭包为空；`api.ts` 原样再导出同一个函数。只声明查询的仓储可以直接从 `query.ts` 取，
  类型仍从 `api.ts` 用 `import type`。
- 纯函数（`isVirtualUri` 等 6 个）改为从 `file-names.ts` 再导出，不再经 `unified-file-manager.ts` 带进 `node:fs`。
- 没人用的再导出删掉：`finishWorkspaceDeletion`、`recoverWorkspaceDeletions`、`cancelReadyWorkspaceDeletion`。
- 剩下的 Node 值再导出（13 个）只被 W07 的 15 个测试 / 夹具和 W01 的 profile-isolation 使用，挪到 `node.ts` 需要先改这些导入方（交接）。
- 棘轮收紧：`api.ts` 的 Node 再导出必须恰好等于 PENDING_IMPORTERS 里名字的并集，导入方迁走后再导出必须跟着删。
- `--mobile-readiness`：网关合计 116 → 116（memory / sync-support 仍从 `api.ts` 取 `defineQuery`）。
  模拟 memory 与 sync-support 改走 `query.ts` / `errors.ts`：116 → 114；再模拟 W07 迁完、`api.ts` 不留 Node 再导出：→ 100。

备份根：

- `ctx.files.backupRoot` = `appData` 根下的 `recovery/backups`（Rust `default_recovery_backup_dir`），在 A/B 槽之外，不需要 `grant()`。
  桌面取 `ctx.paths.recoveryBackupsDir`，OPFS 取 `<dataDir>/recovery/backups`；没有 `appData` 根时读取抛 `UnsupportedOnPlatform`。
- 自定义备份目录：桌面 `grant(dir)` 后访问、用完 `revoke()`；移动端没有（Rust `pick_backup_directory` 在移动端报错）。
- 一致性用例在桌面、内存 OPFS、真实 Chromium Worker 三处跑；平台测试覆盖缺省值（posix / win32）、显式值、无 `appData`、grant / revoke。

去 Buffer 垫片：

- Worker 不再注入 `Buffer` / `process` / `setImmediate`；boot 诊断报告这三个全局，`host-e2e` 断言都是 `undefined`。
- `mobile/` 下 `npm uninstall buffer`（同时移除 `ieee754`；`base64-js` 仍被 `plist` 使用）。
- 完整移动端 e2e 第一次 7/8：冷启动 schema 与桌面基准不一致，原因是上一轮 `aebcc2df` 只在桌面 coordinator 接了
  `pending_memory_candidates` 修复，移动端迁移没跟上（上一轮只跑了 `files-opfs.spec.ts`）。与垫片无关（nodeGlobals 断言先通过了）。
  `storage-mobile/migrations.ts` 在 mistakes 校验后调用同一修复、同一日志文本；新测试 4 个（新库、v0.9.2 旧表、vfs 不动、失败只 warn），
  去掉调用点 3 个变红。修好后 8/8。
- `68567604` 误带了 `node-globals.ts` 的删除（之前 `git rm` 已暂存），单独检出时 `host-worker.ts` 有悬空导入；`5b7b93d0` 紧接着修正。

Linux 棘轮：

- 按 `1fcc7743` 的树复算两个测试的命中数，与服务器报告完全一致（util 1 对 8、storage 2 对 12），即名单在那个版本就是过期的；
  `fd621db5` 与上一轮 `9c9c63e8` / `fc388b16` 已更新名单。
- 当前测试：`toEqual` 不看键顺序、名字已排序、Windows 分隔符已归一、仓库内无符号链接；本机 HEAD 两个测试都通过。

扫描器基线：

- `buildBaseline` 原先把豁免文件（声明仅桌面、`--check` 不比较）的当前发现全写进基线；豁免文件一多出依赖，
  `--write-baseline` 就会“增条目”，按规则不能用。现在给了旧基线时，豁免文件只保留旧基线里已有且仍存在的键。
- 在 INT 暂存树上复现：修复前重写多出 `backup/src/restore-commands.ts node-global:process`，修复后与现有基线逐条相同。
  新测试 1 个，去掉过滤后变红。

合入 INT 之后：

- `http/pinned-policy.ts` 的运行时闭包不再含 Node（`portability.test.ts` 期望改为 `[]`）。
- `storage/errors.ts`、`pinned-policy.ts`、files 三个实现、`mobile/src/capabilities.ts` 的 `UNSUPPORTED_ON_PLATFORM` 前缀和消息格式都取自
  `errors/unsupported-on-platform.ts`（无 import，可移植）；`storage/errors.ts` 仍原样再导出前缀，导入方不用改。
- 移动端 Worker 的 Cordis 导出器没设 `levels`，默认阈值 INFO 会丢掉 warn（这个分支里 WARN = 2 > INFO = 1）；桌面
  `host/kernel/log-export.ts` 早已显式取 WARN。补上后，host-e2e 的“不得出现缺 caller 的 warn”断言才有意义：
  去掉 `caller` 后它变红（修复导出器之前，同样的变异不会变红）。

`--mobile-readiness`（同一扫描器）：INT `fe5feb68` 网关合计 98、就绪 2（integration、review）；本分支 HEAD 相同。
在临时副本上模拟交接：

- W03 / W08 把 memory、sync-support 的 `defineQuery` 改从 `query.ts`、`StorageError` 改从 `errors.ts` 取：98 → 96，memory 变为就绪（就绪 3）。
- W07 迁完 15 个测试、`api.ts` 去掉 Node 再导出：98 → 82，`storage/api.ts` 不再是任何插件的网关，memory 同样就绪。

验证（本机 macOS arm64）：

- 单文件：storage-entries 7、files + opfs 91、storage-mobile pending-memory-candidates 4 + portable-migration-core 9，
  http（portability / pinned / public-loopback / http）29、errors unsupported-on-platform 4、storage-mobile capabilities 4、
  storage portability 5，全部通过；扫描器 `node --test` 14/14。
- 移动端完整 e2e（`bin/heavy npx playwright test`）：合入 INT 前 8/8，合入并完成 5b–5d 后 8/8；`mobile` 的 `tsc --noEmit` 0 错误。

## 2026-11-07 r9（14:30 起，基于 INT `390f244b`，合并提交见 git log）

派单：H4 存储层两项提速、W31 交来的移动端迁移错误前缀与 `openFile` 文档、V07 P3-1/P3-2、`api.ts` 再导出收尾、继续削网关。
与 W31 切分：W14 只碰 `storage-mobile/migrations.ts` 和 `tests/storage-entries.test.ts`；`mobile/src/**`、mobile 各 config、
`mobile/tests/unit|boot`、storage-mobile 其余源文件归 W31。

| 任务 | 状态 | 提交 |
|---|---|---|
| 合入 INT `390f244b` | 无冲突 | 见 git log |
| H4-a `refinery.ts` 迁移 SQL 缓存（按绝对路径，每次 stat 校验 dev/ino/size/mtimeNs/ctimeNs） | 完成 | `8ad4d1f8` |
| H4-b `fingerprint.ts` scope 缓存（键 = 重放的（版本、SQL）序列本身，逐项全等） | 完成 | `10ef0fca` |
| W31 交接：移动端迁移失败文本与桌面一致（`Refinery error:` / `Database error:`） | 完成 | `5e087533` |
| W31 交接：`api.ts` `openFile` 写明移动端共用连接与 BUSY 语义 | 完成 | `91b0d1a3` |

H4 剖析（本机，负载 24–41）：
- `loadSqlMigrations` 4 库 134 个文件：读文件 10–118 ms，`stat` 约 0.6 ms，checksum 4–8 ms。缓存后同进程重复加载中位数 14–49 ms → 约 7 ms。
- scope：`:memory:` 重放约 100–180 ms（vfs 占大头，V20261023 一条约 54 ms）。迁移 Worker 是池化复用的（size 1），
  诊断的槽 C、槽 D 在同一个 Worker 里跑，所以进程内缓存对槽 D 生效；同进程重复计算 147–530 ms → 约 0.1 ms。
- 先试过用 SHA-256 做键：冷启动多 8–9 ms（纯 JS noble），改为直接比较（版本、SQL）序列，未命中零开销、无碰撞。
- 首次调用（冷 Worker、桌面启动）不变：交替顺序 8 轮，首次中位数 head 约 547 ms、新版约 391 ms，噪声内。
- 端到端诊断测试在这种负载下 A/B 不可分辨（槽 D 前 313–373 ms，后 138–834 ms）。

交接（W07）：`definitions.ts:64-66` 的 `loadMigrationSql` 与 `repairs.ts:39-41` 的 `readSql` 改用 `refinery.ts` 的 `readMigrationSql`，
每个 coordinator 构造时 131 个文件只剩 stat（`loadMigrationSets` 本机 6–60 ms）。

r9 后半（合入 INT `2be7ed80`）：

| 任务 | 状态 | 提交 |
|---|---|---|
| V08-11（util 部分）：`lossless-json` 认得 kernel 的 `JSON.rawJSON` 原子，比较/序列化/投影按 `parseJsonLossless(raw)` 处理，不再写成 `{"rawJSON":…}` | 完成 | `ed27f8ac` |
| V10 P2-4：`util/durable-fs.ts` 的 `renameWithRetry(Sync)`（仅 win32 对 EPERM/EACCES/EBUSY 退避，合计约 1.3 s）与 `fsyncDirectory(Sync)`（win32 空操作），经 `util/node.ts` 导出 | 完成 | `6fbaec4a` |
| `ctx.files` 的 `rename` 与 `openWrite({mode:'atomic'})` 改用 `renameWithRetry`；`writeAtomic` 的 durable 用 `fsyncDirectory` | 完成 | `069b8927` |
| W04：代理客户端 `requestTimeoutMs: null` = 不设总超时 | 完成 | `207a077b` |
| W08：`ctx.http` 的 `timeoutMs: null` 贯穿策略层、代理与钉住传输（sync-providers 可去掉 `2^31-1` 的绕法） | 完成 | `0aa2b2a8` |
| W08：`HttpRequestInit.decompress: false` | 只出设计 | — |
| W04/W08 基线收紧 | 无需：合入后 `--check` 为 0 new / 0 resolved | — |
| `api.ts` Node 再导出删除 | 未到条件：INT 上 14 个 W07 测试仍从 `api.ts` 取 Node 值 | — |
| 网关削减 | 合入后 97 → 93（media、sync-providers、translation，均来自其他 lane）；W14 路径内余下的网关见下 | — |

`decompress: false` 未做的原因：Node 内置 fetch 只要响应带 `content-encoding` 就解码，没有开关。要拿原始字节只能另走 undici
`Dispatcher.request`，重写请求体归一化（Blob/FormData/URLSearchParams/流）、重定向、超时与 `TimeoutError`/`AbortError`
错误形态，两条路径容易漂移；iOS `URLSession` 也总是解码，移动端无法兑现。设计：仅桌面 `any`/`public` 支持，代理传输在
`decompress === false` 时用同一个 `Agent`/`ProxyAgent` 的 `request()`，响应体用 `Readable.toWeb` 包成 `Response` 并补 `url`；
`public-pinned` 与移动端以 `UnsupportedOnPlatform` 拒绝。

W14 路径内余下的移动端网关：`storage/api.ts`（16 个插件，等 W07 迁 14 个测试导入）、`util/node.ts`（5 个插件，导入方本身还用
ZIP 或 `node:fs`，只换 base64 去不掉）、`http/index.ts`（agent-skills `src/http.ts` 的桌面回退，W02 已在 W02-1316 记录）、
`util/qr.ts`、`http/proxy.ts`（低价值）。

## 2026-11-07 r10（15:18 起，基于 INT `2be7ed80`，之后合入 D 趟）

派单：rename 重试收敛到 W07 的一套、删 `storage/api.ts` 的 Node 再导出、finalizer 接口类型（AL-07）、W08 的 `decompress: false`
真实性核对、交接收集，之后 files/http/util/portability 补强。

| 任务 | 状态 | 提交 |
|---|---|---|
| 交接收集 | W07 表里给 W14 的四条：storage-entries 冲突与 api.ts 再导出 → 任务 3；storage-mobile dispose → W31；files rename → 任务 2；storage-mobile pending-memory 调用点已在 C 趟 `68567604` | — |
| refinery SQL 缓存的 racy-clean 窗口（Linux 粗粒度时钟下同一 tick 的原地改写签名不变） | 完成 | `44397c9a` |
| W08 `decompress: false` | 需求不成立，不实现；`ctx.http` 的内容编码约定写进 `api.ts` 并在两种桌面传输上测试 | `f6aeccf1` |
| 合入 INT `1d1fdb78`（D 趟，含 W07 `433dac40` / `f93cdc98`，RF-W07-windows-rename-retry 已批准） | 无冲突 | `c5ee1d26` |
| rename 重试收敛到 `paths/rename-retry.ts` | 完成，登记 RF-W14-files-rename-retry（proposed，依赖 RF-W07） | `71a04dd2` |
| 删 `storage/api.ts` 的 Node 再导出 | W07 `f93cdc98` 已删（含 PENDING_IMPORTERS 清空）；这里把棘轮改成终态守卫，并断言 api.ts 运行时闭包可移植 | `ea813ab4` |
| finalizer 接口类型（AL-07） | 卡在第 1 步：W10 `5f4df9a8` 只在 `assault/W10-g3-storage`，未进 INT；第 2 步（W07 `service.ts:234` 返回撤销函数）也未做 | — |

rename 收敛：`durable-fs.ts` 的 `renameWithRetry(Sync)` 现在就是 `fs.rename` 套 `retryRename(Sync)(process.platform, …)`，
`util/node.ts` 不再导出 `RENAME_RETRY_DELAYS_MS` / `RenameRetryOptions`（无外部导入方）。与 W07 版本的语义差异：无，错误码、
平台判断、退避表、用尽后抛最后一次原始错误都来自同一个文件；原来的 `{ platform }` 测试选项去掉了，测试改为改写
`process.platform`。两处包装都做过变异检查（去掉重试各有 3 个用例失败）。

统一用法：
- 策略只在 `host/platform/paths/rename-retry.ts`（W07）：`retryRename(platform, op)` / `retryRenameSync(platform, op)`、
  `RENAME_RETRY_DELAYS_MS`。不要自己维护错误码集合或退避表。
- 插件里对 `node:fs` 做 rename：从 `host/platform/util/node.ts` 取 `renameWithRetry(from, to)` /
  `renameWithRetrySync(from, to)`；目录落盘用同一处的 `fsyncDirectory(Sync)`（win32 上什么也不做）。
- 平台代码：W07 路径内用 `paths/compat.ts` 的 `renameWithRetry` / `renameSyncWithRetry`（secrets 已在用），其他平台代码用
  `util/durable-fs.ts`；rename 操作不是 `fs.rename`（例如注入的 fs）时直接调 `retryRename(platform, op)`。
- `ctx.files` 的 `rename`、`openWrite({ mode: 'atomic' })`、`writeAtomic` 已经重试，调用方不要再包一层。
- 其他 lane 的调用点改过去之后算有意偏离，登记方式由总编排裁定：各自登记 RF（同本 lane），或扩大 RF-W07 的范围免标记。

storage/api.ts 前后（`scan.mjs --mobile-readiness --json -`，前 = INT `2be7ed80` 导出到临时目录用 `--root`，后 = 合入
`1d1fdb78` 之后）：就绪插件 2 → 3（新增 memory），网关 93 → 76，可达 2748 → 2303；`storage/api.ts` 作为网关的插件 16 → 0。
后者的数字包含 D 趟其他 lane 的改动，`storage/api.ts` 一行是本任务的直接结果。W14 路径内余下的网关：`util/node.ts`（5 个
插件）、`http/index.ts`、`http/proxy.ts`、`util/qr.ts`（各 1 个），原因同 r9。

`decompress: false` 的结论（取代 r9 的设计）：
- Rust `dstu-sync` 用工作区的 reqwest 0.11.27（`src-tauri/Cargo.toml:157` 没开 `gzip`，`Cargo.lock` 里 0.11.27 不依赖
  `async-compression`），所以 Rust 不发 `Accept-Encoding`、也不解码，服务端硬塞的 gzip 字节会原样当作内容交给调用方。
- TS 两条桌面传输都发 `accept-encoding: identity`（RFC 9110：不接受任何编码；Rust 不发这个头，按 RFC 反而等于接受任何编码），
  服务端仍回 gzip 时 undici 解码，正文是真实内容，`content-length` 保持编码后长度（本机回环实测 48 vs 226 字节）。
- 只有违反 RFC 的服务端才会触发；触发时 Rust 拿到的是 gzip 字节（对 ZIP/JSON/DSBK 都是坏数据，后续解析失败），TS 拿到的是
  正确内容。照 Rust 关掉解码等于复刻一个缺陷，因此不做。唯一的 TS 侧差异在 W08 的 `getBounded`：
  `ensureMemoryGetMatchesDeclaredLen` 拿解码后长度比编码后的 `content-length`，会以“下载不完整”拒绝（Rust 同场景也失败，只是
  晚一步、文案不同）。是否在 `content-encoding` 非 identity 时跳过长度核对由 W08 决定（属于有意偏离，要登记）。

## 2026-11-07 r11（16:07 起，基于 INT `1d1fdb78`，INT 本轮未前进）

refinery SQL 缓存与 W35 收敛：`d0ef8ab8` 合入 `assault/W35-refinery-racy-cache`（`162c693f`），`refinery.ts` 和
`refinery-sql-cache.test.ts` 逐字取 W35 版本（blob 与 W35 tip 相同），W14 `44397c9a` 的 2 s 窗口作废，以 W35 的 3 s 为准
（FAT 2 s + 1 s 时钟偏差）。W14 旧用例里 W35 没覆盖的只有窗口边界：`f52da61a` 在文件末尾追加“恰好 3 s 仍重读、3 s + 1 ms 可信并缓存”
和“时间戳超前于本机时钟永不可信”两例。`44397c9a` 的另一处改动（真实 ctime 循环到变化）测的是文件系统行为而不是缓存逻辑，
W35 用 pinTimes 固定 ctime 的用例已覆盖“只有 ctime 变也重读”，不追加。之后这两个文件仍归 W14，改动叠在 W35 版本上。

L01 复核 `d8656a26` 的非阻塞项：
- F3（`5b63fe10`）：undici 的 `headersTimeout` / `bodyTimeout`（各 300 s）在所有 dispatcher 上关掉：代理客户端的直连 Agent 与
  无配置兜底、ProxyAgent（含明文 HTTP 转发客户端和 CONNECT 客户端，undici 用 `factory` / `clientFactory` 构造它们时不带
  agent 自己的选项）、public-pinned 的逐请求 Agent。reqwest 只有 `.timeout()`（这里是请求 signal），没有读超时。
  `read-timeouts.test.ts` 用 undici 自己的计时器时钟（`undici/lib/util/timers.js` 的 `tick`）推进 301 s，四条路径 × `null` /
  600 000，改前 12 例全红（`HeadersTimeoutError` / `BodyTimeoutError`）。数字超时超过 300 s 时原来也会被提前截断，一并修好。
- F4（`5598f7ce`）：删掉 `JSON.isRawJSON` 模拟旧运行时，带 `rawJSON` 键的对象在所有函数里都按普通对象处理，数字语义不变。
- F6（`88358ae2`、`643ddb78`）：`createNodeFiles({ platform })` 是 Unix 权限位、chmod、目录 fsync、win32 rename 重试的唯一来源
  （插件传 `ctx.app.platform`），`flavor` 只管路径语法、默认由 `platform` 推出。`durable-fs` 的 `renameWithRetry(Sync)` 恢复
  `{ platform }` 选项（缺省 `process.platform`），测试改为注入平台。剩下 `writeAtomic`：改名在 W07 `atomicWriteFile` 里读
  `process.platform`，补丁已交 W07（`.reports/W14-handoffs/W07-atomic-write-platform.patch`），合入前该用例仍改写 `process.platform`。
  RF-W14-files-rename-retry 的测试名、行为描述和 commits 已同步。

统一 rename 用法更新（取代 r10 的对应两条）：插件对 `node:fs` 做 rename 用 `util/node.ts` 的
`renameWithRetry(from, to, { platform })` / `renameWithRetrySync(from, to, { platform })`，有 `ctx.app.platform` 就传它，缺省
`process.platform`；测试注入 `{ platform: 'win32' }`，不要改写 `process.platform`。

W04 交接：
- `formatRustFixed`（`eb6f18ec`，`util/rust-fixed.ts`）：Rust `format!("{:.N}", f64)` 逐字节一致（中点五成双、负零保留符号、
  不用指数形式、精度不设上限、`NaN` / `inf`）。对照表由本机 rustc 1.98.1 实际输出生成（`tests/fixtures/rust-fixed/`），231 行全对。
- `vfs-handlers/src/pdf.ts:2`：不需要新 API，用 `ctx.files.stat` / `readBytes`；同步函数要改 async，补丁和验证见
  `.reports/W14-handoffs/W14-r11-handoffs.md` 第 2 节。

跳过：AL-15（W10 `b6693579` / `5f4df9a8` 未进 INT）、AL-16 与 FM-12（W01 `6e4d9c7f` 未进 INT）。FM-14：M4 在 D 趟删掉
`storage/api.ts` 的 13 个 Node 值重导出、只留 `export type`，与 r10 的终态守卫（`storage-entries.test.ts`：`api.ts` 运行时闭包
为空、没有导入方从它取 Node 值）一致，符合边界设计。
