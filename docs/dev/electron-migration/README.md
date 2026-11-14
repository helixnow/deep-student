# 桌面版 Electron / Node 全量迁移：总方案与调度

状态：§2.1 ADR 与 §3.4 原生依赖映射已批准（2026-11-03）；余项见 §8。本文是 29 条并行责任线（lane，F1–F7 + L01–L07/L10–L24）的唯一依据；任务卡见
[`lanes.md`](lanes.md)，规模数据由 `node scripts/electron-migration/inventory.mjs`
静态生成到 [`inventory/`](inventory/)（不编译、不启动 Rust）。

## 0. 目标与硬约束

| # | 约束 | 本方案的落点 |
|---|---|---|
| 1 | 只做桌面（Win/macOS/Linux），移动端本轮不做 | Rust 与 Tauri 移动端代码**保留不删**，桌面构建不再编译它们 |
| 2 | 核心业务 100% TS，优先成熟框架 | Host 全 TS；Cordis 内核；仅无成熟 TS 等价物的引擎以**预编译** wasm/napi 进入 `platform` 适配器（§3.4） |
| 3 | 学 DSH，官方功能插件化，用户不碰 Rust 即可替换业务 | 一切业务 = Cordis 插件 + 版本化服务契约；profile/patch 覆盖 |
| 4 | 前端完整保留 | preload 实现 Tauri 内部 IPC 协议，命令名/事件名/载荷/错误形状不变 |
| 5 | 严格保留 Rust 语义 | 三级证据：A 迁移跑通 → B 静态验证（原测试延续、对照审读）→ C 动态验证（录制回放、E2E）（§5.1） |
| 6 | 两天、并行、先定架构、统一契约、独立验收 | 48h 四波次（§6），G0 冻结契约后才实现；交叉审读（§5.4） |
| — | 避免频繁编译/启动 Rust | 迁移与静态验证全程不碰 Rust；仅 F6 独立做一次批量录制（§4.1） |

## 1. 规模（inventory 实测）

- Rust 879,604 行（含内联与 `tests/`，不含 vendor），1066 个 `#[tauri::command]` 定义（契约 1058 个），
  其中 765 个被前端静态调用，292 个前端无调用；8036 个 Rust 测试。
- 前端 invoke 了 50 个 Rust **未定义**的命令名（历史遗留，现状即报错）——迁移后必须
  返回与 Tauri 相同的 "command not found" 错误，不得"顺手补实现"。
- 7+ 个 SQLite 库（mistakes/vfs/llm_usage/audit/settings/superagent/sync_state）、
  137 个迁移文件（refinery）、LanceDB、3 个自定义协议（pdfstream/filestream/bilistream）、
  41 个 Rust 侧事件；前端用到 `@tauri-apps/api/{core,event,window,webview,path,dpi}`
  与 10 个 Tauri 插件（dialog/fs/opener/clipboard/notification/http/updater/process/
  global-shortcut/haptics）。未使用 `ipc::Channel`。

## 2. 目标架构

```
Electron main（薄壳，F2）
  BrowserWindow/菜单/托盘/单实例/electron-updater/globalShortcut/vibrancy
  protocol.handle: asset, pdfstream, filestream, bilistream
  utilityProcess.fork(host) ── MessagePort ──┐
preload（F2）：Tauri 兼容桥                    │
  window.__TAURI_INTERNALS__ = { invoke, transformCallback, convertFileSrc, metadata… }
  invoke(cmd,args) / plugin:event|listen / plugin:<tauri插件>|<cmd> → Host
                                              │
Desktop Host（Node，utilityProcess）── Cordis 插件树
  kernel（F1）  connection · commands 路由 · events · config/profile/patch · plugin-manager
  platform（F3/F4/F7） storage(SQLite) · vector(Lance) · secrets · fs · http · log · native 适配器
  业务插件（L01–L22）  llm · chat · agent-* · vfs · notes · qbank · review · anki · memory
                        · media · mcp/browser · sync · backup …
  用户插件              profile 中按 id 覆盖同名服务（与 DSH 同机制）
```

### 2.1 关键决定（ADR，G0 前可改，之后走变更流程）

1. **内核 = Cordis**（MIT，DSH 生产在用）：服务、类型化事件、可撤销副作用、依赖注入、
   HMR、配置 patch 均复用。现有 `src/plugin-runtime/host.ts` 的语义（版本化服务 id、
   Host 持有 schema、停用顺序、依赖子树卸载、安装回滚）作为 Cordis 之上的**契约层**保留，
   并迁移其测试。
2. **进程模型**：Host 跑在 `utilityProcess`；业务代码不进 main、不进 renderer。
   CPU 密集（索引、PDF、导出、压缩）放 `worker_threads`，由 platform 提供池。
3. **传输 = MessagePort**（无端口、无认证面）；`connection` 是 seam，后续 headless/SDK
   可加 WebSocket 实现。
4. **命令路由**：每个 Tauri 命令名 → 一个服务方法（`commands` 注册表，按契约校验入参/出参）。
   未注册命令返回与 Tauri 字节一致的错误。
5. **事件**：Rust `emit` 的 41 个事件名与载荷原样保留；`listen/unlisten/emit` 语义按
   Tauri（含 target 过滤）实现。
6. **存储**：`better-sqlite3`（随 Electron ABI 预编译），打开**用户现有库文件原地**；
   TS 迁移器读写同一张 `refinery_schema_history`，执行同一批 SQL；SQLite ≥ 3.51.3。
   SQL 归插件 `repository/`，事务句柄绑定连接，业务事件提交后发出（沿用
   `docs/dev/plugin-migration/README.md` 的存储约束）。
7. **数据目录 / 标识**：沿用 Tauri 的 app data 路径与文件布局，老用户无感升级。
8. **移动端**：冻结在 Rust/Tauri；共享 `contracts/` 以便日后复用。

### 2.2 目录布局（所有权 = 目录，避免合并冲突）

```
electron/                       F2   main、preload、打包配置
host/kernel/                    F1
host/platform/{storage,vector,secrets,fs,http,log,native/*}/   F3 F4 F7
host/plugins/<lane-domain>/     L*   manifest.ts · src/ · repository/ · migrations/(引用) · tests/
                                     SPEC.md（行为清单） · TESTMAP.md（原测试去向）
contracts/ipc/<lane>/*.json     F5   命令/事件 wire 契约（唯一来源，生成 TS 类型）
contracts/services/*.json       F5   跨插件服务契约
fixtures/golden/<lane>/         F6   录制回放数据（校验和锁定）
fixtures/db/<version>/          F6   历史库快照
migration/LEDGER.md             S0   实时账本入口说明（账本本身由 ledger.mjs 计算，不入库）
```

共享文件（命令注册表、插件清单、契约索引）一律**生成**，不手改。

## 3. 契约与语义清单

### 3.1 wire 契约（F5）

由 tree-sitter-rust 静态解析（**不编译**）`#[tauri::command]` 签名与 serde 类型，处理
`rename_all`/`rename`/`skip_serializing_if`/`default`/`flatten`/`tag`/`untagged`/
`Option`/`u64`；遇到不认识的形状**报错并人工补**，不猜。产出 JSON 契约 + 生成的 TS 类型 +
运行时校验器。错误类型（`AppError` 等）的序列化形状单列。

### 3.2 跨插件服务契约（F5 + 各 lane）

依据 crate 间 `pub` 调用（`scripts/check-crate-layers.mjs` 的分层）定义服务接口：
提供方 lane 实现，消费方 lane 只依赖契约。H4 前各 lane 提交"我提供 / 我消费"清单。

### 3.3 全局语义清单（每个 lane 的 SPEC.md 必须逐条声明）

- `Option`→`null` vs 字段缺省；`u64/i64` 超过 2^53（用 string 还是 number，以 Rust 实际
  序列化为准）；`serde_json` `preserve_order` 的字段顺序；`f32` 精度。
- 错误：字符串还是对象、文案、错误码；panic 现状 → 映射为相同的前端可见结果。
- 取消：`CancellationToken`/drop 语义 → `AbortSignal`，取消点位置一致。
- 并发：Rust 锁/单写者/队列语义在 Node 中的对应（单线程不等于无竞态——await 交错）。
- 时间与 ID：生成方式、格式（ulid/uuid/nanoid）、时区（chrono-tz）。
- 事件：顺序、节流、是否在事务提交后。
- 禁止对含 HashMap 字段的结构做序列化后哈希/字符串比对（AGENTS.md）。

### 3.4 原生依赖映射（F7 负责适配器与等价性向量）

| Rust | Node 方案 | 等价证明 |
|---|---|---|
| rusqlite/r2d2/refinery | better-sqlite3 + TS 迁移器 | 历史库升级对照 |
| lancedb 0.22 | @lancedb/lancedb（锁定兼容 lance 格式版本） | 真实库读写对照 |
| pdfium-render | pdfium wasm 封装（同引擎，**不换 pdf.js**） | 栅格/文本向量 |
| fsrs =6.6.2 | ts-fsrs（调度）+ 官方 napi 绑定（优化器） | 数值向量，逐项比对 |
| starlark（PTC） | starlark 预编译 wasm | 原测试 + 向量；换语言属功能变化，不做 |
| tiktoken-rs | js-tiktoken | 计数向量 |
| keyring | @napi-rs/keyring（同 service/account） | 读出既有密钥 |
| aes-gcm / argon2 / sha* | node:crypto / argon2 | 测试向量逐字节 |
| prost / zstd / flate2 | protobufjs（同 .proto）/ zstd / zlib | 字节向量 |
| aws-sdk-s3 / suppaftp / WebDAV | @aws-sdk/client-s3 / basic-ftp / 现有 HTTP | 录制回放 |
| docx-rs / calamine / umya / pptx | 逐文件选库 | 抽取后文本与结构对照（不比字节） |
| symphonia / heic / image | 逐项选库（ffmpeg-static / libheif wasm / sharp） | 解码结果对照 |
| reqwest / SSE / tungstenite | undici fetch / eventsource-parser / ws | 录制回放 |
| sentry / tracing | @sentry/electron / pino | — |

预编译产物在 CI 上为 win-x64、linux-x64、mac-x64、mac-arm64 构建，用户与开发者都
不需要 Rust 工具链。

## 4. 优先级与 Rust 资源纪律

**优先级（冲突时按此取舍）：代码完整迁移并跑通 > 静态验证 > 动态验证。**
三者对应 ledger 的三个独立等级（§5.1）；低等级不阻塞高等级的推进，动态验证（录制回放）
**不在迁移关键路径上**，任何 lane 不等待录制数据。

- 迁移与静态验证全程不编译、不运行 Rust：语义依据是 Rust 源码 + 原测试断言。
- 只有 F6 可以运行 cargo / 启动 Rust 应用，且独立排期（§4.1），失败或延迟不影响其他 lane。

### 4.1 录制（F6，独立进行，不阻塞）

录制 = 让现有 Rust 版按剧本跑一遍，在前端 IPC 边界记下 invoke 参数、返回值/错误、事件
序列，以及场景前后的 SQLite 规范化快照；之后用同一份数据库副本和同样输入驱动 TS 版逐项
比对。**不需要真实 API key 或云账号**——比对只要求两边看到相同的外部输入：

- LLM / 搜索 / 抓取：本地**脚本化假供应商**（OpenAI/Anthropic/DeepSeek 兼容的 SSE 与
  JSON 接口，按剧本吐固定流，含错误、重试、中途断流），Rust 版与 TS 版都指向它。
  真实供应商的流格式怪癖由 L01 的原测试与适配器单测覆盖。
- 同步 / 备份：仓库现成的 `scripts/dev/docker-compose.sync-test.yml`（MinIO、WebDAV、FTP）
  本地起服务，不需要外部账号。
- 历史库：用旧版本 Rust 迁移链或现有 `tests/migration_fixture_upgrade_gate.rs` 的 fixture
  生成；有真实脱敏库可补充，但不是前提。

排期：F6 从 H0 起自行编写剧本（依据前端流程与各 lane 的 SPEC.md），选机器空闲时段
**一次**批量录制（复用 `target/` 增量构建、隔离 identifier，勿碰用户正式数据）；需要的
纯函数向量（FSRS、KDF、分块等）同批产出。录制数据就绪后再接入 CI 回放。

## 5. 验收证据与门禁

### 5.1 三级完成定义（ledger 分级记录，由 CI 推进）

| 等级 | 名称 | 条件 | 关键路径 |
|---|---|---|---|
| **A** | 迁移完成并跑通 | 命令/服务按 SPEC 完整实现（无 TODO/mock/空实现）；契约运行时校验通过；插件在 Host 中加载；Electron 中经真实前端冒烟可走通该功能 | **是** |
| **B** | 静态验证 | 原 Rust 测试全部移植并通过，`TESTMAP.md` 闭合（`ported`/`merged`/`obsolete` 需批准）；SPEC 逐条对照 Rust 源码；交叉审读（§5.4）无未决问题；边界与契约门禁通过 | 是（A 之后） |
| **C** | 动态验证 | 录制回放一致（结果、错误、事件序列、DB 快照差分）；历史库升级 E2E；三平台 E2E | 否，尾部并行 |

- 前端无调用的 292 个命令：默认照常迁移；只有证明"前端无调用 + Rust 内部无调用 +
  非移动端专属"才可标 `dead-proven`，需协调者批准。
- 前端调用但 Rust 未定义的 50 个命令名：返回与 Tauri 一致的 not-found 错误，不补实现。
- C 级发现的差异按缺陷回到原 lane 修复，但不回退 A/B 进度的统计。

### 5.2 自动门禁（CI，任何 lane 不能绕过）

- `check-boundaries`：生产路径禁 mock/fake、`TODO`/`unimplemented`/空 catch、
  跨插件引用实现文件、插件外写 SQL、插件内直连数据库驱动、`@tauri-apps` 导入。
- 移植测试的期望值不得改动原 Rust 断言含义（审读检查）；golden 文件校验和锁定，只有 F6 可更新。
- `inventory --check` 与 ledger：任何命令无归属或无状态即红。
- 契约漂移检查；严格 TS 编译。

### 5.3 数据安全

- 所有测试与 E2E 用 `fixtures/db` 的**副本**，不碰用户正式数据目录。
- 历史库由 F6 用旧版本迁移链与现有 migration fixture 生成（至少 3 个旧 schema 版本 +
  当前版本），不依赖用户提供。
- 加密数据（密钥库、备份加密）用向量证明能解开旧数据。

### 5.4 独立验收（不设三人小组）

交叉审读属于 B 级静态验证，在 Wave 2（H30–H36）进行：每条 lane 达到 A 级后审读另一条 lane（下表），验收人只看
契约、Rust 源码、TESTMAP 与 CI 结果，不看实现者说明；结论写入
`host/plugins/<domain>/ACCEPTANCE.md`，问题回到原 lane 修复。

| 验收人 → 被验收 | | | |
|---|---|---|---|
| L01→L07 | L02→L06 | L03→L05 | L04→L03 |
| L05→L04 | L06→L01 | L07→L02 | L10→L13 |
| L11→L10 | L12→L11 | L13→L12 | L14→L15 |
| L15→L16 | L16→L14 | L17→L18 | L18→L17 |
| L19→L23 | L20→L21 | L21→L20 | L22→L24 |
| L23→L19 | L24→L22 | — | — |
| F1→F3 | F3→F1 | F2→F4 | F4→F2 |
| F5→F7 | F7→F5 | F6：不验收他人，其录制数据由 L22 抽检 | |

## 6. 48 小时调度（并发上限 30 = 29 lane + 1 机动）

```
H0 ────── H8 ═══════════════ H28 ═════════ H36 ─────────── H44 ── H48
 Wave0     │G0  Wave1 实现（目标 A 级）  │ Wave2 全量接线 │G1 Wave3 收尾  │G3
 地基+SPEC │冻结 B 级测试随实现同步转绿  │ 冒烟+交叉审读  │ B 闭合 + C 级  │发布候选
 测试移植  │                             │ （B 级）       │ 回放/升级/三平台│
 F6：剧本与假供应商 ──→ 空闲时段一次批量录制 ──→ H28 起 CI 回放（全程不阻塞）
```

### 6.1 Wave 0（H0–H8，29 线全开）

| 时点 | 产出 |
|---|---|
| H1 | 各 lane 读完任务卡与所属路径，开 worktree，提交骨架（manifest、SPEC/TESTMAP 模板） |
| H3 | F5 出 wire 契约草案（全部命令）；F1 出 Kernel API 草案（`host/kernel/API.md` + d.ts） |
| H4 | L* 提交"提供/消费服务"清单；F1 冻结 Kernel API |
| H6 | F2 外壳启动真实前端（所有命令返回 not-found 等价错误） |
| H8 | **G0**：契约冻结（之后改动走 F5 变更单，受影响 lane 确认）；F3 存储 + 迁移器可用；L* 的 SPEC.md 与测试移植就绪 |

业务 lane 在 Wave 0 只做静态工作：逐文件读 Rust，写 SPEC（每命令的输入、输出、错误、
事件、DB 读写、取消/并发），把 Rust 测试移植成 TS（先挂起为待实现），列服务清单。

### 6.2 Wave 1（H8–H28）：代码完整迁移（A 级）

- 业务 lane 实现插件，**首要目标是 A 级**：全部命令实现、插件在 Host 中加载、真实前端
  冒烟走通。移植的原测试随实现同步转绿（B 级的主体），但不为补测试推迟实现。
- 跨 lane 依赖：提供方未就绪时**只在测试里**用契约级替身；生产路径一律经 kernel 服务
  查找，Wave 2 接真。
- 关键提供方里程碑（消费最多，延误即升级处理）：F3 存储 H8 · F4 密钥/设置 H10 ·
  F7 原生适配器 H16 · L02 `llm` 服务 H16 · L11 VFS 仓储 H16 · L13 VFS API 核心 H18。
- F 线在里程碑后转支援：F1→L03/L04，F3→L11/L13（vfs.db 多写入方事务），
  F4→L22，F7→L18；F5 负责变更单与 ledger。
- 检查点 H14 / H20 / H26：按 A 级完成率排序，落后 30% 以上的 lane 获机动名额或拆子包。

### 6.3 Wave 2（H28–H36）：全量接线与静态验证（A 闭合、B 推进）

- H28–H32：F1 全量 profile 在 Electron 中加载全部插件，去掉所有测试替身后的真实接线；
  各 lane 在真实应用里冒烟自己的全部前端流程（`playwright-electron` 脚本留存，供 C 级复用）。
- H30–H36：交叉审读（§5.4）——对照 Rust 源码与 SPEC 逐条审读被验收 lane，问题回原 lane。
- **G1（H36）**：全部命令 A 级；B 级未闭合项有清单和负责人。

### 6.4 Wave 3（H36–H44）：B 闭合 + C 级动态验证

- 各 lane 闭合 TESTMAP 与审读问题（B 级全绿为 G3 必要条件）。
- F6 的回放数据接入 CI，逐命令比对；F3/F6 跑历史库升级 E2E；F2 出三平台未签名构建并跑 E2E。
- C 级差异作为缺陷回原 lane；按优先级，C 级未完全覆盖不阻塞 G3，但必须在报告中逐项列明。

### 6.5 G3 发布候选（H44–H48）

桌面构建切换为 Electron（`package.json` 脚本与 CI 去 cargo），签收报告按 A / B / C 三级
给出每个命令的证据链接、每条 Rust 测试去向、`dead-proven` / `obsolete` 批准记录、C 级未
覆盖清单与已知限制。

## 7. 协调与通信

- **账本**：`scripts/electron-migration/ledger.mjs` 按源码与测试报告实时计算的账本是进度唯一来源（入口见 `migration/LEDGER.md`）；仓库不保存账本快照，lane 不得手写状态。
- **变更单**：契约/服务接口在 G0 后的改动提 `contracts/CHANGES.md` 条目，F5 合并，
  受影响 lane 在 1 小时内确认。
- **决策日志**：语义歧义写 `docs/dev/electron-migration/decisions.md`，协调者裁定；
  不允许"差不多"实现。
- **合并队列**：每个可验证单元立即提交（AGENTS.md 并发纪律）；只提交自己目录；禁止
  stash/reset/checkout --/clean；合并由协调者按队列变基后跑分片 CI。
- **升级规则**：同一包两次未过 CI 或交叉验收 → 协调者换一个全新上下文的代理接手。
- **编排与协调者设计**：通用蓝图 `BLUEPRINT-orchestration.md`；本项目协调者能力诊断
  `audits/W11-coordinator-diagnosis.md`；修复动作、巡检、进展监控与催办闸的部署见 `ops/oc-orchestrator/README.md`。

## 8. 开工前置条件

1. ~~他人未提交的插件改动~~ 已确认均为试验用途：F1 / L02 只把已提交的 `f3958900`
   作为参考，不受其约束；不符合本方案的部分直接替换。工作区里那几个未提交文件不动
   （不做 checkout/clean），由所属会话自行处理，新代码不依赖它们。
2. ~~签名~~ 本轮出**未签名**三平台构建；CI 仍需 Windows / Linux / macOS runner。
3. ~~录制材料~~ 不需要 API key 或云账号：假供应商 + 本地 MinIO/WebDAV/FTP + 生成的历史库
   （§4.1）；录制不阻塞迁移。
4. ~~ADR 与原生依赖映射~~ 已批准。
