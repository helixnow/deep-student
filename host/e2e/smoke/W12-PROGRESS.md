# W12 桌面端真实启动与黄金路径冒烟：进度

> 中断后从这里续上。分支 `assault/W12-desktop-smoke`，worktree `wt/W12`。

## 一键命令

### 接管续轮：G1 精确豁免与 X1 只读对账

提交 `f491d2ab` 将整个 `platform-probes` 阶段豁免改为两个精确负例：非法URL的scope拒绝、
`timeout=-1` 的delay范围校验错误。阶段、命令、唯一输入字段、error结果及原错误文本都须匹配；
同阶段其他失败（包括退出快照save_setting）、错误类别变化、pending/timeout全部阻断G1。
输出新增 `unexpected-ipc-issues.json`、`unexpectedIpcErrors` 和 `expectedProbeErrors`，原ipc-issues不删改。

`bin/heavy npx vitest run -c vitest.host.config.ts host/e2e/smoke/g1-ipc-verdict.test.ts --maxWorkers=1`：
5/5，exit 0。离线对既有 `vEROQT/ipc-issues.json` 应用同一判据：3条错误中2条计划负例、1条save_setting非预期；
原 `g1=true` 在新IPC判据下为false。**这是原件离线复核，不是新桌面冒烟**；未重跑全路由，等W23退出竞态结论后统一新基点实测。

X1旧补丁只读检查：13 absorbed / 46 open / 1 diverged，35 openCode逐组裁定见 `X1-INFLIGHT-REVIEW.md`。
不整包重放；保留的最小缺口为HEIC真实命令二进制链、qbank评分桌面端完整闭环、全注册命令Host自动门入口/分片完备性。
现有Host业务测试不因桌面证据不足而重派实现；旧驱动专有屏障/CLI测试不恢复成第二套runner。

### 接管实测（2026-11-07，产品基点 891d75ed）

开工 W12 干净，`git merge --ff-only 891d75ed` 成功。经根 `bin/heavy` 重建 preload/dist 后：

```sh
bin/heavy node host/e2e/smoke/desktop-smoke.mjs --rebuild 'golden/(01-|02-|03-|04-|05-|08-|16-|17-)'
```

首轮 32 项，raw exit 1（187.5s）：28 正常通过、3 unexpected-pass、1 串行跳过、0 flaky。
三个旧 pin 实际已经通过：③ #23 标题焦点、⑯ V04-02 关窗隐藏后定时提醒、⑰ V01-02 空收件箱投递。
去掉这些 `test.fail` 与同组 Dock/第二实例唤回 pin，断言不变；⑯ 后一例首轮被跳过，须复跑验证后才算通过。
随后 `bin/heavy npx playwright test -c host/e2e/smoke/playwright-electron.config.ts 'golden/(03-|16-|17-)'`
在同一产品基点、同一次 dist 上复跑：**9/9 普通通过，0 skipped/expected-fail/flaky，raw exit 0，132.8s**。
⑯ 3/3：无条件关窗退出、任务驻留隐藏期间执行一次成功、Dock/第二实例唤回与显式退出均通过。
⑰ 2/2：真实 Host 返回 `{status:'empty'}`，15s 内无重试；不使用 stub Host，也未重复 F 的驻留单测。
完整初轮 JSON、隔离原件目录索引与后续结论在工作区根 `.reports/takeover/desktop-gates.md`。
这是当前 B 端真实窗口证据；G1 全路由与 G2 A1/A2/B 正式比较单独判定，旧全量和单测不代替门通过。

G1 全路由最终使用同一 dist、`DEEP_STUDENT_BUILD_NUMBER=20000` 和默认网络环境：raw exit 0，
63 路由、42/42 插件、2849 invokes、0 console/page error，原脚本 `g1=true`。原件 `/tmp/opencode/x1-real-dist-vEROQT/`。
**正式证据缺口**：3条 IPC 错误中2条为计划负例，另1条为退出时 `save_setting(desktop.workbenchSnapshot)`
返回 `Desktop Host exited (code 0)`（wire 10581/10587）；它被 `window-smoke.mjs` 的 platform-probes 整阶段排除掩住，
不能宣称“零非预期IPC错误”。已精确交接 W06/桌面快照 owner（产品退出与防抖保存顺序）；未改产品代码或放宽门判据。
G2 当前没有新 A1/A2/B 比较，旧四场景 equal 均 false；保持未通过，不启动 G3。

```sh
node host/e2e/smoke/desktop-smoke.mjs            # 生成 src/version.ts、打包 preload、缺 dist/ 时 vite build，再跑 __tests__/golden/*
node host/e2e/smoke/desktop-smoke.mjs --rebuild  # 强制重建 dist/
node host/e2e/smoke/desktop-smoke.mjs golden/02  # 额外参数原样交给 playwright
```

性能基线 JSON：`test-results/w12-desktop-smoke/perf-baseline.json`（09 写出）。

产物：`test-results/w12-desktop-smoke/`（JSON 报告、失败截图与 trace）；每个用例的数据根在
`$TMPDIR/ds-w12-smoke/<label>-*/`（wire.jsonl、stdout/stderr、Host 主日志、截图）。
Host 级装配门禁（X1）：`DS_SMOKE_STARTUP_ONLY=1 DS_SMOKE_RUNTIME=electron node host/e2e/smoke/run.mjs`。

独立的 G1 全路由（先按上述命令重建当前 dist/preload）：

```sh
DEEP_STUDENT_BUILD_NUMBER=20000 bin/heavy node host/e2e/smoke/window-smoke.mjs
```

快照仓库可能没有历史 build-baseline commit；此处须与 dist 构建及 W12 helper 使用同一 build number，
否则 shell 插件会因 `git cat-file -e <baseline>^{commit}` 失败而降级，窗口停在 loading。
不设置 `X1_STAGES` 才可能满足 G1；定向过滤即使成功也不是全路由门通过。

## 构建与启动方式（已核实）

- 主进程：Electron 45.2.1 直接运行 `electron/main.ts`（Node 类型剥离，不预编译）。
- Host：`utilityProcess.fork(host/kernel/main.ts)`，同样直接跑 TS；profile 默认 `host/profiles/desktop.json`（39 个插件）。
- preload：`node electron/scripts/build-preload.mjs` → `electron/.build/preload.cjs`（esbuild 单文件，gitignored）。
- 前端：`DS_ELECTRON_DEV_URL` 未设置时从 `dist/` 经 `tauri://localhost` 加载；需先
  `DEEP_STUDENT_BUILD_NUMBER=20000 node scripts/generate-version.mjs`（生成未跟踪的 `src/version.ts`，不要提交），
  再 `NODE_OPTIONS=--max-old-space-size=8192 npx vite build`（默认堆 OOM，约 55s）。
- 开发态：`npm run dev:electron`（vite 1422 + preload + electron）。冒烟用生产 dist，入口是 X1 的
  `__fixtures__/window-main.mjs`（调用 `electron/main.ts` 的 `start()`，只旁路记录 IPC 线路）。

## 数据隔离（`__tests__/support/app.ts`）

`DS_APP_DATA_DIR` 只覆盖 appData。Host 的主日志（`$HOME/Library/Logs/<id>/deep-student.log`）、sync 状态库
（`$HOME/Library/Application Support/deep-student/sync`）仍按 `$HOME` 推导，所以同时重定向 `HOME`/`TMPDIR`/XDG/
`DS_ELECTRON_USER_DATA`，并设 `DEEP_STUDENT_KEY_SEED_FILE_ONLY=1`（不碰钥匙串）。外网：所有代理变量指向
`http://127.0.0.1:9`（黑洞），`NO_PROXY` 只放行回环；渲染进程的非回环 http(s) 请求由 Playwright 路由拦截并记录。

## 进度

- [x] 读计划与交接；摸清构建、启动方式
- [x] 吸收 X1 工具（f89c96e）
- [x] Host 级启动门禁：39/39 插件，无降级，约 6.5s，stderr 无 ERROR
- [x] vite build dist；真窗口手动启动：首窗 0.74s，Host ready 3.1s（fork 起算），onboarding → 学习桌面正常渲染
- [x] 路径 ① 冷启动：通过（`__tests__/golden/01-cold-start.spec.ts`，f8c0a7a）
- [x] 路径 ② 流式 / UI 停止 / Agent attempt_completion：通过（`__tests__/golden/02-llm-chat.spec.ts`，9173861、6fbb395）
- [x] 路径 ② 纯 UI 配置模型：通过（`__tests__/golden/02b-model-settings-ui.spec.ts`，285d1c9）
- [x] 路径 ③ 笔记：通过，含同数据目录重启后经 UI 重新打开（`__tests__/golden/03-notes.spec.ts`，12d7b44）
- [x] 路径 ④ 闪卡复习：通过，UI 完成一轮复习，`fsrs_review_logs` 落库（`__tests__/golden/04-review.spec.ts`，52969d3）
- [x] 路径 ⑤ 备份：通过，设置页加密导出 → 改数据 → 设置页导入 → 立即恢复 → 重启后一致（`__tests__/golden/05-backup.spec.ts`，b62b160）
- [x] 一键命令（6fbb395）；全量跑通 18/18（1.7 min，其中 2 个是以 `test.fail` 固化的已知缺陷）
- [x] 全量 `bin/heavy npx tsc -p tsconfig.host.json`：exit 0（37e0644 之后）
- [x] 纯 UI 配置模型（02b）、类型修正（37e0644）后全量冒烟复跑通过
- [x] ③b 笔记树新建文件夹（#30 固定，4e24c2b6）；⑬ 记忆决策角色与使用信号（7113d004）

## 第二轮（集成 ba5bd32 / c5e4f2b 之上）

全量一键 35 例全部按预期（5.2 min）：30 例通过，5 例是 `test.fail` 固化的已知缺陷（仍复现）。全量 Host tsc exit 0。

| 规格 | 内容 | 结果 | 提交 |
|---|---|---|---|
| 01–05 复跑 | 18 golden + 02b 2 例 | 通过；W06 把 OS 目录移到 `<data>.os/home` 后改断言（日志、sync 目录都在其下，`$HOME` 为空），原 #4 已由 W06 `8455179` 修复；W08 流式备份下 ⑤ 通过（导出 3.1s、导入 1.4s、恢复 6.6s）；已知 #1、#2 仍复现 | 5bc3d0d |
| 06 agent 工具 | fake LLM 脚本化 tool_calls → 真实工具循环 → 落库 → 界面 | qbank、review（`review://changed` 刷新已打开的复习计划视图）、todo + ask_user（界面点选“蓝色”→提交→回传模型）、docx 生成/读回 通过；无执行器工具不下发：4 个会话分批加载全部 56 个技能，347 个工具里 123 个被扣留，与 Host 日志 “Withheld” 并集完全相等；幻觉调用 `builtin-qbank_export` 干净失败 | f5e5a2c5 |
| 07 同步往返 | 自写内存 WebDAV（`__tests__/support/fake-webdav.ts`，无新依赖）；设备 A/B 两个隔离数据根，均经 设置›数据治理›同步 填表、测试连接、保存，开端到端加密 | A 上传 16 条变更、B 下载 12 条，B 笔记 id/标题/正文与 A 一致；云端对象无明文 | 14112be0 |
| 08 旧数据冷启动 | X7 `historical-wp013-v1` 夹具（`__tests__/support/build-old-data.ts`）：五个 refinery 库各落后一个迁移 + audit/sync_state/workspace-v1 历史库 + 已同意协议 + WKWebView 旧版 localStorage；slots 与无槽位两种布局 | 迁移到最新版本、种子行无丢失、无槽位布局整体搬进 slotA、localStorage 迁入渲染进程、不再弹协议、笔记应用可见旧笔记 | 02ddf692 |
| 09 性能基线 | 3 次冷启动 + 2 次热启动取中位数 | 见下表 | 5c7e2cc2 |

### 性能基线（M 系 Mac，生产 dist，冒烟隔离环境）

时间均从主进程启动算起（wire `time`），首窗与桌面就绪从 `_electron.launch` 算起。

| 指标 | 冷启动（空数据根） | 热启动（同数据根） |
|---|---|---|
| 首个窗口 | 0.88 s | 0.85 s |
| Host 启动 / fork | 0.53 s / 0.75 s | 0.44 s / 0.66 s |
| 渲染进程首个 invoke | 1.00 s | 0.92 s |
| Host ready | 3.65 s（fork 后约 2.9 s） | 2.75 s（fork 后约 2.1 s） |
| 桌面就绪（dock 可见） | 7.4 s（含首启协议点击与 2.5s 静默等待） | 2.9 s |
| 内存 空闲：主 / 渲染 / Host / GPU | 253 / 326 / 299 / 118 MB | 254 / 306 / 296 / 112 MB |
| 内存 开聊天+笔记+设置后 | 263 / 397 / 338 / 144 MB | 258 / 397 / 339 / 137 MB |

旧数据（08）冷启动：首窗 0.8–1.8 s，Host ready 3.0–4.0 s（含迁移）。另有 Network Service 约 50 MB。
同步：WebDAV 上传 16 条变更 18.3 s，主要是 provider 的每主机请求限速（`sync-providers/src/webdav.ts:195`，与 Rust 一致，有意）。

### 第二轮新发现（按严重程度）

13. **[中][W02] 压缩摘要永远失败**：`host/plugins/chat-pipeline/src/execution-runtime.ts:281` 在 `llm` 服务上找
    `callAgentCompactionRawPrompt`，它实际发布在 `llmRawPrompt`（`host/plugins/llm/index.ts:121-126`、`llm/src/raw_prompt_service.ts:295`）。
    日志 “[compaction] summary failed … L02 callAgentCompactionRawPrompt is not published”；上下文接近上限时自动压缩与手动压缩都失败。
    复现：06 规格里一次加载多个技能使上下文逼近预算即可在 Host 日志看到。
14. **[低][W02，Rust 同款] 一次 `load_skills` 结果超 30k 预算时新技能的工具不下发**：执行器注册表先按 30k 截断输出
    （`host/plugins/chat/src/executor-registry.ts:134`，Rust `executor_registry.rs:409`），`tool-round.ts:166-171` 再从截断后的
    预览里读 `result.loaded_skill_ids`，读不到，于是本轮既不追加工具也不注入技能说明。修法：读 `arguments.skills` 与执行器的未截断结果，
    或让 SkillsToolExecutor 不受结果预算。复现：06 最后一例（一次加载全部 56 个技能，输出 36,680 字符，第 2 轮只剩 `load_skills`），`test.fail` 固化。
    修好后该例会因全部技能说明约 146k token 超出默认输入预算 83,808 而需要重新配平。
15. **[低][W06] 升级首启控制台报 CSP 错**：WebView 迁移页以 `default-src 'none'` 下发（`electron/shell/protocols.ts:150`），
    preload 仍往所有文档注入拖拽区 `<style>`（`electron/preload/preload.ts:104-116`），每次带旧 localStorage 的升级启动都记一条
    `console.error`（并经 `report_frontend_log` 记 BOOT_CSP_VIOLATION）。修法：迁移页跳过注入，或给迁移页 CSP 加该样式的 hash。
    08 两例 `test.fail` 固化。
16. **[低][W03] 引导模型去调被扣留的工具**：qbank 有 6 个工具无 Host 实现、被正确扣留（`QBANK_PENDING_TOOL_NAMES`），但 qbank 技能说明写
    “批量用 builtin-qbank_batch_import”，作文执行器提示（`host/plugins/review/src/essay-tool-executor.ts:274,353,455`）也指向它。
17. **[信息]** 未知模型默认 32k 上下文窗口（`compaction-budget.ts:19`），加载 qbank+review 两个技能就接近上限；前端 `contextLimit` 又把
    窗口压到 83,808。agent 名册（`host/kernel/agent-roster.ts:217`）把 QBankExecutor 标为 missing，实际可执行（元数据过期）。
18. **[信息] 旧数据夹具与真实旧数据的差距**：
    - 库由当前 checkout 的 Rust 迁移 SQL 重放构造（每库只落后一个迁移），不是历史发行版二进制产出的库；跨多个版本的 schema 漂移、
      历史 DDL 与当前 SQL 文本差异都没覆盖（真实产物需 WP-043）。
    - 每表 1–3 行合成数据；没有 `blobs`/`files` 对应的磁盘文件、图片、教材 PDF、向量/Lance 索引、`backups/` 与 `recovery/`。
    - 没有 API 配置、模型分配与钥匙串密钥（旧版密钥在系统钥匙串，冒烟强制 file-only），所以升级后仍弹“欢迎/去配置 AI 服务”。
    - localStorage 只有一个合成键，用的是 WKWebView 旧版布局；没覆盖 origin 分区新布局与真实键集合。
    - 数据目录由 `DS_APP_DATA_DIR` 指定；默认路径（`~/Library/Application Support/com.deepstudent.app`）的定位没走到。
19. **[环境]** 冒烟目录的临时 tsc 配置（`test-results/w12-tsc`）在 4 个产品文件上报类型错误（undici 与 DOM 流类型来自 Playwright 类型环境），
    官方 `tsconfig.host.json` 无错误，不影响。

## 第三轮（集成 68d37526 → cc37e619 之上）

基线全量（合入前改动，`bin/heavy`，5.6 min）：21 过、5 败、9 未跑（串行组内前序失败），失败全部是新集成带来的断言过期或已修缺陷，
逐条处理如下。之后按规格定向复跑（机器上同时有 6–8 个其他 lane 的重任务排队）。

| 规格 | 本轮处理 | 结果 | 提交 |
|---|---|---|---|
| ① 冷启动 | 隔离断言纠正：W08 `ca0c332b` 改为首次用到同步时才打开 `sync_state.db`（与 Rust `open_default()` 一致），冷启动本就不该建 sync 目录；正向隔离断言移到 ⑦（同步后 `sync_state.db` 在 `<data>.os/home` 下，`$HOME` 为空）。快捷助手 `test.fail` 意外通过 → 转为正常断言（W09 `3592a356`） | 4/4 过 | 9c2d7e9d |
| ② 聊天 | W02 首轮后多一次非流式会话元数据请求：fake LLM 识别该请求并返回 JSON 标题/标签，流式计数改用 `streamRequests()`；新增“标题+标签+用量账本”用例；`load_session` 的 `test.fail` 意外通过 → 转正（W10），并新增“重启后在聊天窗口点开旧会话能看到历史” | 7/7 过 | 9c2d7e9d |
| ②b 设置页配模型 | 同上计数纠正，并断言元数据请求用的是同一模型与密钥 | 2/2 过 | 9c2d7e9d |
| ③ 笔记 | 失败根因：新建笔记先聚焦标题，约 80ms 后正文编辑器就绪时抢走焦点（探针：246ms 标题 focusin，327ms milkdown `focus()`），`fill` 的文字落进正文。属前端既有竞态（见 #23）；用例改为等编辑器就绪后点击标题再输入，并把 1s 后焦点所在记为注解 | 3/3 过 | ebb13d56 |
| ⑥ agent 工具 | `runTurn` 只计流式请求；最后一例仍按预期失败，原因改引 `RF-W02-loaded-skill-ids-truncation`（修复在 W02 分支 `c453fe6a`，未进集成） | 6 过 + 1 预期失败 | 9c2d7e9d |
| ⑦ 同步 | 新增 A、B 两端同步后的 `sync_state.db` 隔离断言 | 2/2 过 | 9c2d7e9d |
| ⑧ 旧数据 | CSP `test.fail` 仍按预期失败（错误仍在） | 4 过 + 2 预期失败 | — |
| ⑩ vfs-index 常驻 worker（新） | 资源库“新建 › 导入资料…”导入 txt（主进程应答打开对话框），测试不调用任何索引命令：无嵌入模型时 worker 为 pending 资源建 `vfs_index_units` 且不发 embeddings 请求；配置 fake 嵌入模型（`/embeddings`，64 维确定性向量）后 worker 把资源索引到 `indexed`，写出 text segment，请求体含导入文本 | 2/2 过 | 362891fd、27abe826 |
| ⑪ 核心恢复启动（新） | 先正常首启，再把活动槽 `databases/vfs.db` 换成 8KB 非 SQLite 字节后重启：显示 `ComponentRecoveryShell`（vfs blocked、mistakes/chat_v2 依赖跳过、下一步页“重启并重试/导出诊断报告”）、不渲染桌面；维护状态、`notes_list` 的 MAINTENANCE_MODE、`llm_usage_summary` 可用、degraded 含 dstu.notes 且不含 storage/backup/shell。**损坏文件被删除**（#20）以 `test.fail` 固化，并加一例重启后果 | 2 过 + 2 预期失败 | f40b2ea5 |
| ⑫ Host 插件降级 → FeatureUnavailablePanel（新） | 数据根放有效的用户 profile，把 `dstu.anki` 换成 apply 抛错的夹具（`__fixtures__/degraded-anki-plugin.ts`）：status 报 dstu.anki degraded、其余插件不受影响、不回退官方 profile；经典壳闪卡视图显示面板（标题、暂不可用、原因、查看详情）；Workbench 闪卡应用不显示面板（#22）以 `test.fail` 固化 | 2 过 + 1 预期失败 | 362891fd、27abe826 |
| 工具 | `__tests__/support/wire-calls.ts`：按 webContents+callback 配对列出一次运行的 IPC 调用与结果（`--errors` 只看失败），排障用 | — | 1ebb039f |

### 第三轮性能复测（同口径：3 冷 + 5 热取中位数；机器同时有其他 lane 的重任务）

| 指标 | 冷启动 | 基线 | 热启动 |
|---|---|---|---|
| 首个窗口 | 0.85 s | 0.88 s | 0.89 s |
| Host ready | 3.66 s | 3.65 s | 3.09 s |
| 桌面就绪 | 10.3 s（含首启协议点击与 2.5s 静默等待，受机器负载影响大） | 7.4 s | 3.37 s |
| 空闲内存 主 / 渲染 / Host / GPU | 257 / 335 / 309 / 119 MB | 253 / 326 / 299 / 118 MB | 254 / 308 / 301 / 108 MB |
| 开聊天+笔记+设置后 | 260 / 408 / 359 / 135 MB | 263 / 397 / 338 / 144 MB | 263 / 400 / 349 / 125 MB |

首窗与 Host ready 持平；冷启动空闲内存 Host +10 MB、渲染 +9 MB，开应用后 Host +21 MB（本轮多装了 vfs-index 常驻 worker、W17 v2 UI 内核等），未见异常增长。

收尾全量复跑（branch tip，机器负载较低）中的 ⑨：冷启动首窗 0.57 s、Host ready 2.44 s、桌面就绪 6.2 s，空闲内存 258 / 337 / 307 MB；
热启动首窗 0.62 s、Host ready 2.05 s、桌面就绪 2.2 s，空闲 255 / 308 / 297 MB。时间受机器负载影响明显，内存两次一致。

收尾全量：46 例全部符合预期（40 过、6 个 `test.fail` 按预期失败：⑥ RF-W02 待合入、⑧ CSP ×2、⑪ #20 ×2、⑫ #22），0 意外、0 flaky，5.5 min。

### 第三轮新发现（按严重程度）

20. **[高][W07/W14（`host/platform/storage/migration/**`），Rust 同款] 单库恢复用了过期快照，删除了用户的核心库**。
    `backup.ts` `restoreDatabaseFromLatestCoreBackup`（Rust `coordinator.rs:965-1046`）取“最新”启动快照，快照里没有该库就当作
    “迁移前不存在”并 `unlinkSync` 掉当前库；但版本读不出时本次启动不会建新快照（`maybeBackupCoreDatabasesBeforeMigration`，Rust
    `coordinator.rs:686-699`，有意跳过），于是用的是更早启动的快照。复现：⑪——空数据根首启（生成 `copied_files: []` 的首启快照）→
    把 `slots/slotA/databases/vfs.db` 换成非 SQLite 内容 → 重启：恢复界面写着“数据文件仍在原位置，没有被当作空数据覆盖”，原因文本是
    “Restored this database from the startup snapshot.”，实际 vfs.db 已被删除；**再启动一次就退出维护模式、新建空 vfs.db，
    `notes_list` 返回 `[]`，用户看到的是一个空资料库**（⑪ 第 4 例注解 `{"mode":false,"blocked":[]}`）。
    若旧快照里有 vfs.db，则会被静默回滚到那次启动的内容。
    建议修法：只信任本次启动建立的快照（按 startup guard / pid 匹配），没有就保留原文件（或改名隔离）并如实写原因。
    建议登记 `RF-W07-restore-stale-snapshot-deletes-db`（kind rust-bug；g3 影响 fs `databases/vfs.db` 与维护状态 reason 字段）。
21. **[中][W07/W14，仅迁移版] 启动迁移协调器的日志全部丢失**：两次启动的 `deep-student.log` 里都没有任何 `dstu_storage::migration`
    行（连“🚀 开始执行所有数据库迁移”都没有），#20 的失败与删除在日志里不留痕迹。协调器在 worker 内运行，日志经
    `migration/worker-tasks.ts:15` → `worker-pool.ts:47` 转发；`logging.ts:2-4` 在 sink 未设置时直接丢弃。Rust 走 tracing 会落日志。
    复现：⑪ 任一数据根，`grep MigrationCoordinator data.os/home/Library/Logs/*/deep-student.log` 为空。
22. **[中][W17（FE-A3 设计），路径 W09] Workbench 卡片中心不感知 Host 降级**：`src/features/workbench/apps/system/register.tsx:236-272`
    直接渲染 `FlashcardsAppWindow`/`TemplatesAppWindow`/`TaskDashboardAppWindow`，只有经典壳视图经 `ctx.ui.pair` 换成面板
    （`src/ui-plugins/official/shell/index.ts:72-83`）。Workbench 是产品默认界面：dstu.anki 降级时闪卡窗口照常显示“卡片库还是空的”，
    所有 anki 命令返回 “Command not found”，用户会以为卡片丢了。复现：⑫ 第 2 例。Tauri 版没有插件降级概念，不适用。
23. **[低][W09（notes 前端）/W18（`CrepeEditor.tsx` 装配），Tauri 同款] 新建笔记后焦点竞态**：标题先被 `NotesEditorHeader.tsx:143-152`
    （autoFocusTitle）聚焦，约 80ms 后正文编辑器就绪时调用 milkdown `focus()`（生产包栈指向 NoteContentView 分块内的编辑器就绪路径，
    具体调用点未在源码定位），用户新建后立即输入的标题会进正文。本轮前端 notes 代码无改动，上轮通过属时序侥幸；前端代码与 Tauri 版相同。
24. **[低][W09，Tauri 同款] 恢复界面 Tabs 无障碍语义缺失**：`ComponentRecoveryShell.tsx:93-94` 的 TabsTrigger 渲染为普通 button
    （无 `role="tab"`/`aria-selected`），旁边却有 `role="tabpanel"`，读屏无法识别为标签页。

### 上轮问题复核

- 已修复并转正：#1 会话重启后加载失败（W10）、#2 生产包快捷助手（W09 `3592a356`，Tauri 版同款，建议补登记 RF）、#3 执行运行时 7 项能力中的
  标题/标签/用量（W02），② 新用例覆盖。
- 仍存在：`execution-runtime.ts:351,525`（record_used，memory 已有 `recordUsed()` 于 `memory/src/service.ts:1218`）、`:445`
  （record_injection_presence，memory 无此能力）、`:454`（learner profile 渲染函数未挂在 memory 服务上，函数在
  `memory/src/learner-profile.ts:216,270`）——06 每次启动都有这三条 “owner capability unavailable”；#13 压缩仍在 `llm` 上找
  `callAgentCompactionRawPrompt`（`execution-runtime.ts:303-307`，实际在 `llmRawPrompt`），本轮用例未触发压缩；#14 修复待合入；#15 CSP 仍在。

## 第五轮（集成 edf15754 之上）

全量（`bin/heavy … --rebuild`，6.8 min）：47 例中 46 符合预期，1 例意外失败（⑥ 超预算 load_skills），已定位为新缺陷 #25（非回归），
用例拆分后 ⑥ 定向复跑 7/7 符合预期。备份恢复（⑤）、代理（fake LLM 经 `HTTP(S)_PROXY` 黑洞 + `NO_PROXY` 直连）、zip（⑤ 导出/导入、⑦ 同步）
三条链路在 W05 代理 bypass、W08 zip 重写合入后全部通过；W02 新挂的 Subagent/SuperSession/Workspace 执行器使 ⑥ “无执行器不下发”
用例的 withheld 集合变化，用例按日志自校准，仍通过。

| 规格 | 本轮处理 | 结果 | 分类 |
|---|---|---|---|
| ①②②b③④⑤⑦⑩ | 无改动 | 全过 | — |
| ⑥ agent 工具 | 去掉 `test.fail`（W02 `c453fe6a` 已在集成）。全量中该例仍败：Host 侧已按预算前结果披露 56 个技能的 352 个工具（日志 “Progressive disclosure: added 352 tools”），但第二轮请求被 Host 以“上下文预算不足（估算 175464，上限 83808）”拒发——上限来自渲染层的模型缓存过期（#25）。拆成两例：RF-W02 守护例改为断言 Host 工具轮披露了全部已加载技能且工具数 ≥ 前端声明的 347 个（转正）；“下一轮请求带上这些工具”保留原断言，`test.fail` 引 #25。另：`configureFakeModel` 补发设置页保存后会发的 `api_configurations_changed`/`model_assignments_changed`（与 `useVendorModels.ts` 一致） | 6 过 + 1 预期失败 | #25 旧缺陷（前端既有，Tauri 同款） |
| ⑧ 旧数据 | CSP 仍在 | 4 过 + 2 预期失败 | 旧缺陷（W06） |
| ⑨ 性能 | 拆出“到协议页”与“到 dock 可见” | 过 | — |
| ⑨b compile cache（新） | 关/开各 3 冷 + 3 热，读 wire 的 Host ready 与 fork→ready，断言关时无缓存条目、开时有 | 过 | — |
| ⑪ | 未改（W20 负责） | 2 过 + 2 预期失败 | 旧缺陷（#20） |
| ⑫ | 未改 | 2 过 + 1 预期失败 | 旧缺陷（#22） |

### 第五轮性能（3 冷 + 5 热中位数）

| 指标 | 冷启动 | 上轮收尾 | 热启动 | 上轮收尾 |
|---|---|---|---|---|
| 首个窗口 | 0.59 s | 0.57 s | 0.51 s | 0.62 s |
| 到协议页 | 2.57 s | — | 无协议页 | — |
| 到 dock 可见 | 2.66 s（点同意后约 90 ms） | — | 1.70 s | — |
| Host ready | 2.43 s | 2.44 s | 1.57 s | 2.05 s |
| 桌面就绪（含关欢迎页） | 6.24 s | 6.2 s | 1.70 s | 2.2 s |
| 空闲内存 主 / 渲染 / Host / GPU | 258 / 341 / 335 / 126 MB | 258 / 337 / 307 | 255 / 306 / 343 / 118 MB | 255 / 308 / 297 |
| 开聊天+笔记+设置后 | 264 / 419 / 373 / 139 MB | — | 264 / 402 / 387 / 133 MB | — |

冷启动“dock 可见”到“桌面就绪”的 3.6 s 是关闭欢迎页的流程，用户可见的就绪点应以“到 dock 可见”为准。Host 空闲内存冷 +28 MB、
热 +46 MB（本期合入 W02 三个编排执行器、W05、W08 zip 等），开应用后 Host 373/387 MB，需在下轮继续观察是否为常驻增长。

W01 compile cache（Electron 内实测，每次冷启动用全新数据根与 `TMPDIR`，热启动复用最后一个根；中位数）：

| 模式 | 冷 Host ready | 冷 fork→ready | 热 Host ready | 热 fork→ready | 缓存条目 |
|---|---|---|---|---|---|
| 关（`NODE_DISABLE_COMPILE_CACHE=1`） | 2.16 s | 1.71 s | 1.90 s | 1.44 s | 0 |
| 开（默认） | 2.77 s | 2.23 s | 1.65 s | 1.19 s | 4013 |

热启动 fork→ready 快 0.25 s（−17%）；缓存为空的首次启动慢 0.52 s（+30%），即首次安装、升级后首启和系统清理 `$TMPDIR` 后的首启
会变慢。每组仅 3 次、机器有其他 lane 负载，绝对值有噪声，但两个方向在 6 次样本中一致。

### 第五轮新发现

25. **[中][W09（`src/features/chat`），Tauri 同款] 渲染层模型缓存过期，发送时按 100k 兜底窗口算输入预算**。
    `ensureModelMetadataReady`（`src/features/chat/adapters/tauri/modelSelection.ts:26-36`）用非强制的 `ensureModelsCacheLoaded()`，
    缓存 TTL 5 分钟（`useAvailableModels.ts:95`）；唯一的失效监听在 `useAvailableModels` hook 里，只有 `AdvancedPanel` 挂载时才存在。
    启动时缓存已加载（无新模型）→ 用户在设置页新增/修改模型 → 5 分钟内发送：`getModelInfoByConfigId` 找不到模型，
    `inferInputContextBudget` 落到 `DEFAULT_FALLBACK_CONTEXT_WINDOW` 100k，`contextLimit` = 83808。1M 窗口的模型被 Host 以
    “上下文预算不足”拒发（⑥ 实测 175k 估算被拒）；小窗口模型反过来被高估。复现：⑥ 第 7 例（wire 中 10 次 `chat_v2_send_message`
    的 `contextLimit` 都是 83808，而同一渲染进程 `get_api_configurations` 已返回 `contextWindow: 1048576`）。
    建议修法：模块级监听 `api_configurations_changed` 清缓存；`ensureModelMetadataReady` 在 `getModelInfoByConfigId(modelId)` 为空时强制刷新。
    前端代码与 Tauri 版相同，建议登记 `RF-W09-stale-model-cache-context-budget`（kind rust-bug 口径的前端既有缺陷；g3 影响
    `chat_v2_send_message` 请求体 `options.contextLimit`）。
23. 补充定位：抢焦点的调用点是 `NoteContentView.tsx:818-822` `handleEditorReady`——编辑器就绪且视图激活（`focusOnActive`）时
    `requestAnimationFrame(() => api.focus())`，未考虑 `NotesEditorHeader` 已对空新笔记 `autoFocusTitle`。建议：新建空笔记（与
    `autoFocusTitle` 同条件）或 `document.activeElement` 已在标题内时跳过正文聚焦。Owner 改为 W09。

### 上轮问题复核

- #13 已修（W02 `a7c67cab`，压缩走 `llmRawPrompt`），⑥ 日志可见自动压缩正常运行。
- 仍存在：`execution-runtime` 三项 memory 能力（record_used、record_injection_presence、learner profile），⑥ 每次启动各一条。
- #20/#21（W20）、#22（W17/W09）、#24（W09）、#15 CSP（W06）未变。
- Host tsc（`tsconfig.host.json`，含冒烟代码）0 错误。

## 第六轮（集成 361ba187 之上）

全量（`bin/heavy … --rebuild`）＋定向复跑（新加的 ⑩ 两例、⑥ qbank 例在全量开始后才写入；⑪ 复跑取恢复页文本）。无回归。

| 规格 | 本轮处理 | 结果 | 分类 |
|---|---|---|---|
| ①②②b③④⑤⑦⑨⑨b | 无改动 | 全过 | — |
| ⑥ agent 工具 | 新增：`docx_create` `output_target=workspace` 真实写入已配置的读写工作区（校验 receipt、文件存在、`PK` 头、sha256 与工具结果一致）；新增：qbank 拆分后 88 条冻结命令全部被运行中的 Host 路由（无 “Command not found”，`plugin:host|status` 无 qbank 降级） | 8 过 + 1 预期失败 | #25 旧缺陷（W09） |
| ⑧ 旧数据 | CSP 例去掉 `test.fail`（W06 `58cf4104` 改为 `webFrame.insertCSS`） | 6 过 | #15 已修 |
| ⑩ 索引 worker | fake LLM 增加 `/rerank`；新增：配置 reranker 并打开 `search.enable_reranking` 后 `vfs_rag_search` 经 W05 llm rerank 服务重排（请求体、Bearer、分数 0.9/0.45 逐项断言）；新增：聊天 `unified_search` 重排，`test.fail` 引 #27 | 3 过 + 1 预期失败 | #27 新缺陷；#26 新缺陷（绕过） |
| ⑪ 核心恢复 | W20 已去 `test.fail`；补守护：日志含协调器“没有可信快照，原文件保留在原位置”及库路径；重启后仍为维护态、恢复页标题可见、无 dock、损坏库哈希不变；恢复页文本记入 annotation（不断言） | 4 过 | #20/#21 已修 |
| ⑫ | 未改 | 2 过 + 1 预期失败 | #22 旧缺陷 |

⑪ 恢复页实际显示（首启与重启相同）：“部分数据库升级未能安全完成 / 应用已将影响限制在相关数据组件，并暂停打开核心业务数据库。
数据文件仍在原位置，没有被当作空数据覆盖。”组件表：vfs blocked（英文原因 “Database 'vfs' migration failed: Database error: file is
not a database. No snapshot was taken before this migration run, so nothing was restored; the database file was kept in place at
…/vfs.db (not deleted or overwritten). No earlier snapshot contains this database.”），mistakes、chat_v2 blocked（依赖 vfs），另 2 个正常。
本场景（未动文件）下固定文案属实；“已从快照恢复”等场景的文案由 W09 处理。组件原因是未本地化的英文。

### 第六轮内存（Host 空闲）

⑨：冷 336 MB（上轮 335）、热 343 MB（上轮 343），本轮持平；相对第三轮（307/297）仍 +29 / +46。

来源（新诊断 `diagnostics/host-heap.spec.ts`：打补丁 `utilityProcess.fork` 加 `--inspect`，SIGKILL Host 由 supervisor 重启，
CDP 取 `process.memoryUsage()` 与堆快照，`support/heap-summary.ts` 按插件归属汇总）：

- 同一构建 A/B：冷启动空闲 RSS 开 compile cache 336 MB、关 309 MB，JS 堆一致（heapUsed 78–79 MB）——冷 +27 MB 是 W01 compile
  cache 的原生内存。热 +46 推测同源（未做热 A/B）。
- 空闲构成：rss 340、heapTotal 151、heapUsed 79、external 9 MB；约 70 MB 已提交未使用的堆。
- 堆 87.5 MB：字符串 51.2（主要是保留的模块源码）、代码 11.6、native 9.4（含 pdfium wasm 3.4）、数组 6.3。
- 按归属：`node:*` 7.6；插件 llm 2.0、anki 1.9、media 1.9、qbank 1.8、agent-workspace 1.8、chat-pipeline 1.6、vfs-repos 1.5、
  agent-orchestration 1.4、vfs 1.3、agent-skills 1.3、storage 1.2、sync 1.2 等；空闲即被加载的库：docx 1.9、undici 1.5、
  apache-arrow 1.2、pdfium 0.6、`@smithy/core`（AWS SDK）0.5。
- 开应用后 JS 堆 +11 MB（主要是对象属性）。

### 第六轮性能（机器重载，中位数）

| 指标 | 冷启动 | 热启动 |
|---|---|---|
| 首个窗口 | 0.75 s | 0.59 s |
| 到协议页 / 到 dock | 3.15 / 3.31 s | — / 2.10 s |
| Host ready | 3.00 s | 1.90 s |
| 空闲 主 / 渲染 / Host / GPU | 254 / 339 / 336 / 125 MB | 255 / 304 / 343 / 121 MB |
| 开应用后 | 256 / 419 / 371 / 141 MB | 262 / 404 / 384 / 133 MB |

compile cache fork→ready：关-冷 1953、开-冷 2186、关-热 1533、开-热 1201 ms（方向与上轮一致）。

### 第六轮新发现

26. **[低][W04 vfs-index/vfs-handlers + W09 IndexStatusView，Rust 同款] `vfs_rag_search` 忽略请求里的 `enableReranking: true`**：
    `IndexStatusView.tsx:1248` 发送 `enableReranking: true`，但 `search-service.ts:248-250` 还要求 `search.enable_reranking` 为 true
    （默认 false，只能经 `vfs_set_indexing_config` 设置，无 UI 调用）。Rust `indexing.rs:5221-5223` 同样门控。建议登记
    `RF-W04-rag-search-rerank-flag`，或在索引设置 UI 暴露开关（W09）。
27. **[高][W04（vfs-index 提供 `retrieval`）/W10（`host/plugins/vfs/index.ts:231` 注入 `retrievalCancellable`），仅迁移版] 聊天检索工具全部不下发**：
    `BuiltinRetrievalExecutor` 依赖的 `retrievalCancellable`（`CancellableRetrievalPort`，带 `AbortSignal` 的 `search`/`searchMultimodal`）
    无人提供；vfs-index `RetrievalService.search(request)` 无 signal。结果 `unified_search`、`rag_search`、`multimodal_search`、
    `web_search` 在每次聊天请求中被 RF-W02 withheld——聊天中的知识库检索与联网搜索完全不可用。第五轮已存在（12 个 withheld），
    ⑥ 一致性例是自校准的，未报出。建议 vfs-index（或 vfs）提供 AbortSignal 感知的 `retrievalCancellable` 适配器。⑩ 第 4 例 `test.fail` 守护。
28. **[高][W10 chatanki，仅迁移版] ChatAnki 主流程工具无执行器**：`ChatAnkiToolExecutor.canHandle` 只认 `CHATANKI_IMPLEMENTED_TOOLS`
    （`chatanki-executor.ts:563`，6 个：analyze/list_templates/export/transform/review_stats/check_anki_connect）；`chatanki_run`、`start`、
    `wait`、`control`、`sync`、库卡片增删改/挂起等 10 个在 `tool-metadata.ts` 中声明但无执行体，⑥ 日志 “Withheld 10 tool schema(s)
    … builtin-chatanki_run …”。用户在聊天中制卡不可用。Rust `chatanki_executor.rs` 有完整实现。
29. **[低][W09/W20，Rust 待核] 恢复页组件原因为英文**：见上方 ⑪ 文本；中文界面中原样显示后端英文原因。

### 上轮问题复核

- #15（W06）、#20/#21（W20）已修，对应用例已转正。
- 仍存在：`execution-runtime` 三项 memory 能力（record_used、record_injection_presence、learner profile），⑥ 每次启动各一条。
- #22、#23、#24、#25 未变（W09/W17）。
- Host tsc：冒烟代码 0 错误；集成另有 1 处 `host/plugins/vfs/tests/paper-library.test.ts(64,58)` TS2345（W10 `6a422366`）。

### 第六轮工具改进（单独提交）

- `support/fake-llm.ts`：`/rerank` 路由、`rerankRequests()`、`rerankScore()`。
- `support/heap-summary.ts`（亦可 CLI）、`diagnostics/host-heap.spec.ts`、`playwright-diagnostics.config.ts`：
  `bin/heavy npx playwright test -c host/e2e/smoke/playwright-diagnostics.config.ts`，输出 `test-results/w12-heap/host-heap.json`
  （`W12_KEEP_HEAP=1` 保留快照）。

### 改进建议（deliberate + proposed，待审）

- W01：compile cache 冷启动 +0.2–0.5 s、常驻 +27 MB 原生内存，换热启动 −0.3 s——需要取舍；HostReady 后可考虑一次 GC/堆收缩（约 70 MB 已提交未用）。
- W02/W07/W08/W11 各插件：docx、AWS SDK（`@smithy/*`）、apache-arrow、pdfium 改为首次使用时懒加载，空闲可省约 6 MB 堆及对应原生内存。
- W09：索引设置暴露“重排”开关，或让 `IndexStatusView` 的请求开关直接生效（#26）。

## 第七轮（集成 f3439333 之上）

全量（`bin/heavy … --rebuild`，60 例，9.1 min）：52 例按预期，4 例意外——均为规格过时或夹具问题，非产品回归；修正后定向复跑
②b/③/③b/⑪/⑫/⑬ 共 21 例全部按预期（③ 固定用例改入口后单独复跑 4 例，按预期）。修正后全套共 62 例：56 过 + 6 预期失败。INT 前端（含 `550d9391` 修复）vite 构建通过，真实窗口启动到工作台桌面，各黄金路径经 UI 可用。

| 规格 | 本轮处理 | 结果 | 分类 |
|---|---|---|---|
| ①②④⑤⑦⑧⑨⑨b | 无改动 | 全过 | — |
| ②b 设置页配置模型 | 首轮后上游请求由 2 个改为 3 个：流式 1 + 会话元数据 1 + 记忆自动抽取 1（按提示词头识别；断言抽取请求带同一 key、提示词含用户消息） | 2 过 | 行为变化：W03 r7 接通决策角色后 auto-extractor 真正调模型（Rust `persistence.rs:1584` 同款，消息 ≥10 字触发） |
| ③ 笔记 | 新增 #23 固定用例（`test.fail`，经资源管理器“新建 → 新建笔记”）；首例加焦点时间线注解 | 3 过 + 1 预期失败 | #23 仍复现，RF-W09-new-note-title-focus 实际无效 |
| ③b 笔记树新建文件夹（新） | 右键行 → 新建文件夹 → 输入框挂载（过）；输入框关菜单后保持焦点、Enter 只发一次 `dstu_folder_create` 并出现新行（`test.fail`） | 1 过 + 1 预期失败 | #30（W26 修复中，修好后转正） |
| ⑥ agent 工具 | 无改动 | 8 过 + 1 预期失败 | #25 旧；withheld 仍 12/348（10 个 chatanki + `unified_search` + `web_search`，#27/#28） |
| ⑩ 索引 worker | 无改动 | 3 过 + 1 预期失败 | #27 旧 |
| ⑪ 核心恢复 | 改为断言 tablist（具名）/ tab `aria-selected` / tabpanel 归属，按钮限定在“下一步”面板内 | 4 过 | #24 已修（RF-W09-recovery-shell-tab-roles） |
| ⑫ 降级面板 | 工作台闪卡例去掉 `test.fail` | 3 过 | #22 已修（RF-W09-workbench-cards-host-degraded） |
| ⑬ 记忆角色（新） | 见下 | 4 过 + 2 预期失败 | W03 r7 已确认；W02 r6 部分确认；#31、#27 |

⑬（`fake-llm.ts` 新增 `complete` 钩子按提示词头扮演决策模型，`llm-config.ts` 新增 `configureFakeEmbedding`）：

- W02 r6：真实聊天轮次中不再有 `owner capability unavailable: memory…`；本轮所有数据根日志中 `owner capability unavailable` 为 0 条（上轮每次启动 3 条）。
- W02 r6 record_used：`memory_read` 经记忆 owner 使 `_used` +1 并写 `_last_hit:`（过）。回答引用 `[记忆-N]` 的路径只有 `unified_search` 产生
  该标签，受 #27 阻塞（`test.fail`，实测模型拿不到该工具）。
- W03 r7 决策角色：`memory_write_smart` 有相似记忆时恰好 1 次决策请求（提示词含 `[ID: <noteId>]`），按模型回复 UPDATE
  （`downgraded:false`），正文更新为新事实，日志无 “does not expose callMemoryDecisionRawPrompt”。`insight_recall` 原查询无命中时
  恰好 1 次改写请求、1 次唱反调核验（含卡片标题），返回 `[灵感-1]`，无 “LLM 改写失败”。
- #31 固定：写入后应有分类摘要请求与 `__cat_*` 成员标签（`test.fail`；注解记录三条 “skipped” 日志）。

### 第七轮内存（Host 空闲，3 冷 + 5 热中位数）

⑨：冷 339 MB（上轮 336）、热 344 MB（上轮 343），持平（+3 / +1，在机器负载噪声内）。

| 指标 | 冷启动 | 热启动 |
|---|---|---|
| 首个窗口 | 0.69 s | 0.77 s |
| 到协议页 / 到 dock | 3.40 / 3.56 s | — / 2.51 s |
| Host ready | 3.26 s | 2.22 s |
| 空闲 主 / 渲染 / Host / GPU | 255 / 327 / 339 / 121 MB | 255 / 316 / 344 / 122 MB |
| 开应用后 | 258 / 410 / 370 / 139 MB | 266 / 412 / 387 / 135 MB |

compile cache fork→ready：关-冷 2066、开-冷 2678、关-热 1704、开-热 1293 ms（方向与上轮一致）。

### 第七轮新发现

30. **[中][W26 修复中] 笔记树右键“新建文件夹”输入框一闪即关**：`NotesWorkspaceTree.tsx` `closeMenu` 经 `focusRowDom` 在 rAF 里把焦点
    还给树行，内联输入框 `onBlur` 时值为空而自行取消。实测关菜单两帧后焦点在 `DIV[data-nwt-id=note_…]`，输入框已卸载。③b 第 2 例固定。
31. **[中][W03，仅迁移版] 写入后分类刷新、提升、语义去重全部跳过**：`memory/src/service.ts:528-549` `runPostWriteMaintenance` 仍以
    “L02 LLM completion API is not published” 跳过三项；Rust 三项都走 `call_memory_decision_raw_prompt`（现已可经 `llmRawPrompt` 解析）。
    TS 侧没有分类刷新实现（`category_manager.rs:85-200` 未移植），新装用户永远没有 `__cat_*` 分类摘要，用户画像不注入系统提示。⑬ 第 2 例固定。
32. **[中][W02，读码发现，冒烟暂不可达] `record_injection_presence` 永不触发**：`chat-pipeline/src/execution-capabilities.ts:265` 从
    `listCategorySummaries()` 取 `memberIds`，而 `memory/src/service.ts:784-785` 该方法剥掉了 `memberIds`（带成员的是
    `listCategorySummariesWithMembers()`）。缺失能力日志已不再提示。目前影响带 `__cat_*` 的 Rust 迁移数据，#31 修好后影响所有用户。
    修法：改用 `listCategorySummariesWithMembers()`。#31 修好后可在 ⑬ 补用例。

### 上轮问题复核

- #22（⑫）、#24（⑪）已修，用例已转正。
- #23 **未修好**：RF-W09-new-note-title-focus 让标题等正文编辑器就绪后再聚焦，但真实窗口里标题从未拿到焦点——时间线
  “194ms 新建笔记按钮 → 398ms `.ProseMirror`”（资源管理器入口同样 “205ms 新建 → 373ms `.ProseMirror`”），随后
  `NotesEditorHeader.tsx:147` 看到焦点已在正文就直接返回。抢焦点的是正文侧（编辑器就绪/开标签时的聚焦），不在 autoFocusTitle 里。③ 第 4 例固定。
- #25、#26、#27、#28、#29 未变；#27 另一症状：不支持工具的模型走降级注入时日志 “[Fallback] web_search 返回错误: 未知工具: web_search”。
- Host tsc（`tsconfig.host.json`，含冒烟代码）0 错误（上轮的 paper-library 测试错误已消失）。boundaries 0 违规；rust-fixes 48 条全部 approved、0 错误。

## 第八轮（集成 6c491e6f 之上）

全量（`bin/heavy … --rebuild`，7.8 min）：list 输出 61 例（规格文件无增减；上轮报告写的 62 例以本表为准），59 例按预期（54 过 + 5 预期失败），
1 例意外：⑬ 引用 `[记忆-N]` 的 `test.fail` 意外通过（#27 已修）；1 例未跑（同一串行组内前一例“失败”后跳过）。翻转 #27 两例后定向复跑
⑩ + ⑬ 共 10 例全部按预期（含上次未跑的 insight_recall）。当前全套 61 例：57 过 + 4 预期失败（#23、#30、#25、#31）。无产品回归。

| 规格 | 本轮处理 | 结果 | 分类 |
|---|---|---|---|
| ①②②b④⑤⑦⑧⑨⑨b⑪⑫ | 无改动 | 全过 | — |
| ③ 笔记 | 无改动 | 3 过 + 1 预期失败 | #23 未修（时间线 192ms 新建 → 346ms `.ProseMirror`） |
| ③b 新建文件夹 | 无改动 | 1 过 + 1 预期失败 | #30：W26 `ff587a08` 未进 6c491e6f |
| ⑥ agent 工具 | 无改动 | 8 过 + 1 预期失败 | #25 未修；withheld 由 12/348 降到 4/348（#27 已修，#28 部分修复） |
| ⑩ 索引 worker | 聊天 `unified_search` 例去掉 `test.fail`；改读模型实际看到的 `sources[].resourceId` | 4 过 | #27 已修 |
| ⑬ 记忆角色 | 引用 `[记忆-N]` 例去掉 `test.fail` | 5 过 + 1 预期失败 | #27 已修；#31 未修 |

⑩ 的断言对象纠正（不是放宽）：原用例在 #27 期间写成 `sources[].metadata.resourceId`，工具从未下发所以从未执行过。模型看到的是
`build_numbered_sources`（Rust `builtin_retrieval_executor.rs:1082-1107`，TS `buildNumberedSources`），`resourceId` 在每个来源的顶层，
没有 `metadata`。重排的其余断言（`rerank` 为 requested/applied、一次 `/rerank` 请求、分数与 reranker 顺序一致）一字未改。

### 修复确认

- **#27 已修**（W24 `97d95303` vfs-index 发布 `retrievalCancellable`；`68b2ad7a` 检索执行器拆分注册并改用 `ctx.get`）：
  `unified_search`、`web_search` 不再被扣留；⑩ 聊天检索经 `/rerank` 重排；⑬ 回答引用 `[记忆-2]` 后该记忆 `_used` +1，
  W02 r6 的 record_used 两条路径（`memory_read`、引用）至此都确认。
- **#28 部分修复**（W22 r2 + W10 facade）：扣留的 chatanki 工具由 10 个降到 4 个，库卡增删改、复习入队/挂起/撤销、`wait` 已有执行器。剩余：
  - `chatanki_run`、`chatanki_start`：anki 侧没有生成管线（streaming/文档处理）facade，`host/plugins/chatanki/BLOCKERS.md:18`、
    `host/plugins/chatanki/index.ts:78`。负责：W10（anki facade）→ W22（执行器）。
  - `chatanki_control`、`chatanki_sync`：W10 已发布 facade（`9a895678`），W22 尚未接到执行器（`chatanki/src/chatanki-executor.ts:563-566`
    的 `CHATANKI_IMPLEMENTED_TOOLS`、`chatanki/src/executors.ts:35`），即第四批派单里的“control/sync 改走 `ctx.anki.pipeline`”。
- **#23 未修**：`NoteContentView.tsx:818-829`（`src/features/learning-hub/apps/views/`）编辑器就绪后 rAF 里 `api.focus()`，
  `NotesEditorHeader.tsx:143-152` 看到焦点已在 `.ProseMirror` 就放弃；f3439333 以来 notes 前端无提交。W09。
- **#25 未修**：⑥ 第 9 例第二轮 0 个工具，Host “上下文预算不足（估算 177528 tokens，上限 83808）”。W09。
- **#29 未变**：⑪ 恢复页组件原因仍为英文。W09/W20。
- **#31 未修**：`memory/src/service.ts:528-549` 三条 “L02 LLM completion API is not published” 照旧。W03。
- **#32 未修**（读码）：`chat-pipeline/src/execution-capabilities.ts:265` 仍从 `listCategorySummaries()` 取 `memberIds`，
  `memory/src/service.ts:784-785` 剥掉了它。W02。
- **#26 / #30**：RF-W04-rag-search-rerank-flag（W04 `8d63f281`）与 W26 `ff587a08` 都在第四批，开工时未进 INT，见下方“交付前合 INT”。

### 第八轮新发现

33. **[低][W09，Tauri 同款] 导入资料时 `extractSourceId` 误报“路径格式不合法”**：`src/dstu/api.ts:188` 的来源 id 白名单只有
    `note|tb|fld|exam|tr|essay|img|att|retrieval`，没有资源 `res_*` 和文件 `file_*`。⑩ 导入一个 txt 时控制台连续 6 条
    `[DSTU:API] 路径格式不合法，已消毒`。消毒后的值与原值相同，没有功能影响，只是生产包里的日志噪音。代码自基线快照未改。

另查了两条日志，均不是缺陷：⑪ 恢复启动时 `cannot register maintenance participant "vfs-worker" during maintenance`
（`storage/service.ts:226-227` 在维护态拒绝注册，vfs-repos 因此降级，正是 ⑪ 断言的隔离行为）；⑫ 的模板加载失败来自故意降级的 dstu.anki。

SEC-T04（W23 报告，`reviews/ELECTRON-SHELL-SECURITY.md:38`，CSP 的 `img-src https:` 与 `style-src 'unsafe-inline'`）：W12 不需要改代码。
CSP 违规在渲染层表现为 `console.error`，每个规格的健康检查都会因此失败（#15 就是这样抓到的），W06 收紧 CSP（`electron/shell/protocols.ts:52,118-131`
取自 `tauri.conf.json:38` 的 `app.security.csp`）后跑一次全量冒烟即可回归。

### 第八轮性能（⑨，3 冷 + 5 热中位数）

| 指标 | 冷启动 | 热启动 |
|---|---|---|
| 首个窗口 | 0.55 s | 0.54 s |
| 到协议页 / 到 dock | 2.63 / 2.75 s | — / 1.80 s |
| Host ready | 2.48 s | 1.66 s |
| 空闲 主 / 渲染 / Host / GPU | 256 / 331 / 339 / 127 MB | 253 / 302 / 345 / 117 MB |
| 开应用后 | 264 / 408 / 369 / 144 MB | 264 / 400 / 387 / 133 MB |

Host 空闲冷 339 / 热 345 MB，与上轮（339 / 344）持平。compile cache fork→ready：关-冷 1596、开-冷 2010、关-热 1532、开-热 1180 ms（方向同前）。

### 强制 GC 阶段（W01 交接，`diagnostics/memory-gc.spec.ts`）

```sh
bin/heavy npx playwright test -c host/e2e/smoke/playwright-diagnostics.config.ts memory-gc
W12_GC_VARIANTS=default-idle60 bin/heavy npx playwright test -c host/e2e/smoke/playwright-diagnostics.config.ts memory-gc
```

口径同 ⑨（工作集来自 `app.getAppMetrics()`，桌面就绪 3 s 后采样，开聊天/笔记/设置后再采一次），每个采样点之后做一次全量 GC 再采两次（GC 后
2 s、10 s）。Host 从第一次 fork 起就带 `--inspect`（`__fixtures__/window-main.mjs` 的 `W12_HOST_INSPECT_PORT`），所以冷、热都是原始 Host，
不是 supervisor 重启出来的；GC 用 CDP `HeapProfiler.collectGarbage`，渲染进程同样走 CDP，主进程用 `--js-flags=--expose-gc` 的 `gc()`。
“GC 前”在连上 inspector 之前采。默认 3 冷 + 3 热，关 compile cache 2 冷 + 2 热，中位数（MB）：

| 场景 | Host 前 → GC 后 10 s | Host heapTotal / heapUsed 前 → 后 | 渲染 前 → 后 | 主 前 → 后 |
|---|---|---|---|---|
| 冷启动空闲 | 339 → 268（−71） | 159 / 85 → 84 / 79 | 336 → 313（−23） | 258 → 259 |
| 热启动空闲 | 346 → 279（−67） | 156 / 86 → 83 / 78 | 312 → 295（−17） | 257 → 259 |
| 冷启动开应用后 | 360 → 304（−56） | 147 / 87 → 91 / 86 | 400 → 373（−27） | 248 → 244 |
| 热启动开应用后 | 356 → 315（−41） | 125 / 89 → 90 / 85 | 397 → 375（−22） | 265 → 246 |
| 关 compile cache，冷空闲 | 309 → 238（−71） | 159 / 83 → 84 / 78 | 329 → 307 | 258 → 243 |
| 关 compile cache，热空闲 | 301 → 235（−66） | 156 / 84 → 83 / 78 | 304 → 287 | 254 → 256 |

- Host 的降幅几乎全是 V8 已提交未使用的堆：heapTotal 约 −75 MB，heapUsed 只降 5–8 MB，不是泄漏也不是垃圾多，是启动期间堆长大后还没缩回来
  （下面的 60 s 对照显示 V8 自己会缩回）。GC 后 10 s 不回涨。10 个空闲采样的降幅全部在 −65～−72 MB（第一个冷启动采样整体偏低：269 → 204，降幅相同）。
- compile cache 的常驻成本：GC 后默认 268 / 279，关缓存 238 / 235，即冷 +30、热 +44 MB 原生内存，GC 收不回来（与第六轮 +27 MB 一致）。
- 热启动 GC 前 `external` 有 105–137 MB（冷启动 8–9 MB），GC 后都回到 8 MB；关缓存时同样存在，与 compile cache 无关，RSS 降幅冷热相近，
  说明这部分大多没有常驻。推测是热启动时有数据可处理的启动维护（如 Lance optimize）留下的原生缓冲，未逐项定位。
- 冷启动第一个采样另外记录了 Host 空闲时已加载的包（CDP `Debugger.scriptParsed` 回放，源码 KB）：apache-arrow 1273、undici 1047、
  docx 998、@smithy/core 476、@embedpdf/pdfium 291、@aws-sdk/client-s3 262、pako 210、ajv 207、@lancedb/lancedb 164、jszip 130、
  @aws-sdk/core 113 等；exceljs 不在其中。

60 s 空闲对照（`default-idle60`，2 冷 + 2 热，不开应用）：桌面就绪 3 s 后采一次，什么都不做等 60 s 再采一次，然后同样强制 GC。逐个采样（MB）：

| 采样 | Host 就绪 → 60 s → GC 后 10 s | Host heapTotal 60 s → GC 后 | 渲染 就绪 → 60 s → GC | 主 就绪 → 60 s → GC |
|---|---|---|---|---|
| 冷 1 | 338 → 273 → 244 | 95 → 84 | 332 → 301 → 268 | 259 → 211 → 201 |
| 冷 2 | 321 → 259 → 252 | 95 → 84 | 284 → 265 → 266 | 191 → 190 → 190 |
| 热 1 | 344 → 287 → 279 | 95 → 83 | 305 → 282 → 281 | 255 → 241 → 241 |
| 热 2 | 344 → 287 → 278 | 95 → 84 | 302 → 279 → 279 | 255 → 240 → 241 |

- 不做任何处理，Host 在 60 s 内自己降了 57–65 MB，heapTotal 从就绪时约 159 降到 95 MB（V8 的空闲堆收缩）；之后强制 GC 只再降 7–9 MB
  （冷 1 是 29 MB）。渲染进程和主进程也是 60 s 内自己降，GC 后基本不再变。
- 所以上表“GC 前 → GC 后”的 −70 MB 大部分是 V8 一分钟内本来就会收回的部分；⑨ 的“空闲”列（就绪后 3 s）比稳态 Host 高约 60 MB。

### 上轮三条内存改进建议：结论

1. **compile cache 取舍（W01，主要改动在 W06）：保留，但换到持久目录。** 本轮热启动 fork→ready −352 ms（−23%），缓存为空时 +414 ms（+26%），
   常驻 +30～44 MB 原生内存。热启动是常态，值得保留。问题在缓存放在 `os.tmpdir()/node-compile-cache`（`host/kernel/compile-cache.ts:3,23`），
   macOS 会定期清理 `$TMPDIR`，长时间没打开应用后又会遇到一次“缓存为空”的慢启动。`compile-cache.ts` 已经沿用 `NODE_COMPILE_CACHE`，
   建议 W06 在 `electron/shell/host.ts:110` fork Host 时把它设到 userData 下的缓存目录，W01 不用改代码；常驻内存无法回收，接受。
   另有一项成本见下文 #35：就绪 5 s 后的定时写盘每次启动都会阻塞 Host 主线程 0.4–3 s，应改为退出时写盘（W01）。
2. **HostReady 后一次 GC / 堆收缩：不做，没有负责 lane。** 60 s 对照里 V8 自己收回了 57–65 MB，主动 GC 在稳态只多收 7–9 MB；
   要拿到这点收益还得让 W06 给 Host fork 加 `--expose-gc`（`electron/shell/host.ts:110`），并在移动端做特性检测，不划算。
   对测量的影响：W01 若按内存定预算，应以就绪 60 s 后的稳定值为准（Host 约 260–290 MB），不要用 ⑨ 就绪后 3 s 的值；
   W12 下轮可给 ⑨ 加一次 60 s 稳定采样（每次启动多 1 分钟，所以只加在一冷一热上）。
3. **常用重型库懒加载：值得做，按库分给各自负责的 lane，各自一个小改动。** 纯 Node 下单独导入的增量（GC 后，进程各自独立，互有重叠，
   只作量级参考）：@aws-sdk/client-s3 RSS +29 MB / 堆 +5.9 MB / 80 ms，另 @smithy/node-http-handler +13 MB；docx +17 MB / 3.2 MB；
   apache-arrow +16 MB / 2.9 MB；@lancedb/lancedb（含 arrow）+21 MB / 3.4 MB / 174 ms；jszip +7.7 MB。按收益排序：
   - W08：`host/plugins/sync-providers/src/entry.ts:48` 静态导入 `./s3.ts`（`s3.ts:41-42` 引入 AWS SDK）。只有配置了 S3 同步的用户需要，
     改为首次使用 S3 时 `await import('./s3.ts')`，收益最大。
   - W01：`host/platform/native/office/docx.ts:4` 在空闲时就加载 docx；只在生成/读取 Word 时需要。
   - W03：`host/plugins/qbank/src/paper-docx.ts:14` 同样静态导入 docx，与上条一起改才能把 docx 移出空闲。
   - W10：notes 的 `repository/{export-common,export-archive,import-archive}.ts` 静态导入 jszip，导出/导入时才需要。
   - lancedb + apache-arrow（`host/platform/vector/service.ts:3-4`，§6 无归属，唯一使用方是 W04 的 vfs-index）：只对没配嵌入模型的用户有收益，
     且索引 worker 和启动 optimize 一有数据就会用到，优先级最低。
   - undici 是网络栈本身，不动；pdfium（W04 media）只有 0.3 MB 源码，可不做。

   改完后用 `memory-gc` 诊断的“空闲已加载包”列表验证对应库已从空闲移出。懒加载只改加载时机，失败时与原来一样在调用点报错，不改行为。

### 交付前合 INT fe5feb68（第四批合入后）

合入后为 `cbc02415`，INT 没有改冒烟路径。`--rebuild` 全量 61 例（8.8 min）：52 过 + 1 预期失败（#31）+ 2 意外失败 + 6 未跑
（两个串行组的首例失败后，组内其余用例跳过）。处理后定向复跑 ③ + ⑪ 两遍，共 16 例全部按预期。
当前全套 61 例：59 过 + 2 预期失败（#23、#31）。③ 首例会间歇失败，根因是 #34 + #35（见下）。

| 规格 | 本轮处理 | 结果 | 分类 |
|---|---|---|---|
| ③b 新建文件夹 | 第 2 例去掉 `test.fail` | 2 过 | #30 已修（W26 `ff587a08`；菜单关闭后焦点停在 INPUT） |
| ⑥ agent 工具 | 第 9 例去掉 `test.fail` | 9 过 | #25 已修；withheld 由 4 降到 2/348 |
| ⑩ 索引 worker | RF-W04-rag-search-rerank-flag：去掉写 `search.enable_reranking` 的绕行，改为断言该键仍是 `'false'`、`enableReranking: false` 不发 `/rerank` | 4 过 | #26 已修 |
| ⑪ 核心恢复 | 第 1 例的界面原因改为断言中文句子（`:58`，RF-W09-recovery-reason-localized）；IPC 原因（`:80`）仍断言英文 | 全量中意外失败；改后复跑 2×4 过 | 已批准 RF 带来的预期变化 |
| ③ 笔记 | 无改动 | 全量中首例意外失败（标题没保存）；复跑两遍都是 3 过 + 1 预期失败 | #34 + #35；#23 未修 |
| ⑬ 记忆角色 | 无改动 | 5 过 + 1 预期失败 | #31 未修 |
| 其余 | 无改动 | 全过 | — |

⑪：W09 的交接只说 IPC 原文（当时的 `:73`，现在是 `:80`）不受影响，但原 `:56`（现 `:58`）断言的是界面上的原因行。按 RF，这一行现在是
“数据库 vfs 升级失败：Database error: file is not a database。……”。新断言同样锚定句首，并原样包含底层错误，强度不变。

修复确认（fe5feb68）：
- **#30 已修**（W26 `ff587a08`）：`closeMenu` 只在焦点随菜单卸载落回 body 时才还给树节点。
- **#25 已修**（W09 `ebc1b936` / `6d88946c`，RF-W09-stale-model-cache-context-budget）：全部加载技能后的下一轮请求带上了已披露的工具。
- **#26 已修**（RF-W04-rag-search-rerank-flag）：不写开关，`vfs_rag_search` 也会重排，分数顺序与 reranker 一致。
- **#29 已修**（RF-W09-recovery-reason-localized）：中文界面的恢复页原因是中文。
- **#32 已修（读码）**：W02 `cc51bee4` 让 `record_injection_presence` 改走 `listCategorySummariesWithMembers`
  （`chat-pipeline/src/execution-capabilities.ts:257-259`）。冒烟里没有覆盖注入记录的断言。
- **#28 又修了一部分**：control/sync 已经接上（W22 `9107ece2`），扣留的只剩 `chatanki_run`、`chatanki_start`，仍卡在 anki 生成管线缺 start facade
  （`host/plugins/chatanki/BLOCKERS.md:18`）。负责：W10（facade）→ W22（执行器）。⑥ 的幻觉探针现在用 `chatanki_run`；这两个也接上后，
  `06-agent-tools.spec.ts:293` 的前置断言会失败，需要 W12 换一种探针方式（不是产品缺陷）。
- **#23 未修**：焦点时间线仍是 42ms BUTTON → 238ms `DIV.ProseMirror`。W18 报告说 W09 已在 `NotesCrepeEditor.tsx:2978-2979` 修好，
  但生产包里实测焦点仍落在正文。W09。
- **#31 未修**，同前。W03。**#33 未变**（`src/dstu/api.ts:189`）。W09。

### 交付前新发现

34. **[中][W09，Tauri 同款] 新笔记的标题保存与正文自动保存并发时，标题被 CONFLICT 拒绝并回滚。** 全量 ③ 首例的经过：
    - 正文 `dstu_update` 在 12.24 s 发出，13.47 s 才返回。
    - 标题 `dstu_set_metadata` 在 13.41 s 发出，`expectedUpdatedAt` 仍是创建时间。
    - Host 判定 `notes.conflict`，界面标题回到“无标题笔记”，main log 记下 `Failed to update title`。

    根因线索：`src/features/learning-hub/apps/views/NoteContentView.tsx:740-749` 的 `handleTitleChange` 读共享的 `lastKnownUpdatedAtRef`；
    正文保存还在途时，这个基线还没推进。正文保存一侧遇到元数据写入造成的冲突会用新基线重试（`:623-650`），标题和标签（`:792-799`）一侧
    没有对应的处理。标题不依赖正文基线，冲突时读一次最新 `updatedAt` 再重试即可，或者与正文保存串行。前端代码自基线快照未改，
    Rust `dstu_set_metadata`（`handlers.rs:3349-3352`）同样接受 `expected_updated_at`。只有正文保存慢到约 1 s 以上才会触发，也就是 #35。
35. **[中][W01，W06 配合] Host 就绪 5 s 后同步写编译缓存，主线程阻塞 0.35–0.74 s（空闲机器），机器负载高时 1–3.3 s。**
    `host/kernel/main.ts:88` 的 `setTimeout(flushCompileCache, 5_000)` 调用 `host/kernel/compile-cache.ts:32` 的 `module.flushCompileCache()`。
    - 新诊断 `diagnostics/host-stall.spec.ts`（Host CPU 采样，间隔 1 ms）4 次启动全部命中：最长忙段 0.74 / 0.67 / 0.69 / 0.40 s，
      其中 99% 的采样在 `flushCompileCache`，都出现在开始采样后 5.0–5.5 s。前一次启动已经写满缓存，下一次照样阻塞。
    - 全量 25 次启动里有 10 次，廉价命令（`get_setting`、`dstu_get`、`get_model_assignments` 等）晚了 1–3.3 s 才返回，时间都在就绪后 4–6 s，
      正是用户刚过协议页、打开第一个应用的时候。#34 就是这样被触发的。
    - 缓存目录是全机共享的 `$TMPDIR/node-compile-cache`（本机 172 MB、19281 个文件，各 worktree 的 Host 都往里写）。
    - 不是第四批引入的，W01 `0067d9ec` 起就有。
    - 建议：去掉 5 s 定时写盘，靠进程正常退出时 Node 自动写盘。Host 关闭本来就走 shutdown 请求（wire 里有 `host-shutdown-request` /
      `host-shutdown-complete`），只有被强杀时才丢一次缓存，可以接受。同时按建议 1 把缓存目录换到 userData（W06），目录小了，写盘也快。

### 交付前性能（⑨，3 冷 + 5 热中位数）

这次全量时机器负载高：同批 ⑨b 关缓存的冷启动也慢了约 0.8 s，所以冷启动变慢不归因于 INT。

| 指标 | 冷启动 | 热启动 |
|---|---|---|
| 首个窗口 | 0.52 s | 0.55 s |
| 到协议页 / 到 dock | 3.43 / 3.59 s | — / 1.82 s |
| Host ready | 3.26 s | 1.69 s |
| 空闲 主 / 渲染 / Host / GPU | 256 / 332 / 335 / 124 MB | 254 / 306 / 345 / 119 MB |
| 开应用后 | 258 / 405 / 375 / 140 MB | 263 / 398 / 388 / 135 MB |

⑨b fork→ready：关-冷 2435、开-冷 2629、关-热 2041、开-热 1690 ms，方向同前。

## 第九轮（集成 390f244b → 2be7ed80 之上）

### 开工全量（第五批 INT 390f244b，合入后 `dd3fedb6`）

`bin/heavy … --rebuild`，10.3 min：61 例全部按预期（59 过 + 2 预期失败），无意外、无未跑，规格文件无增减。与第八轮交付时一致。

| 规格 | 第八轮交付 | 第九轮开工 | 说明 |
|---|---|---|---|
| ①②②b③b④⑤⑦⑧⑨⑨b⑩⑪⑫ | 全过 | 全过 | — |
| ③ 笔记 | 3 过 + 1 预期失败（首例间歇失败） | 3 过 + 1 预期失败 | #23 未修：时间线 271ms 新建按钮 → 468ms `DIV.ProseMirror`；首例本次通过（#34、#35 代码未变，时序相关） |
| ⑥ agent 工具 | 9 过 | 9 过 | #28：`chatanki_run`/`chatanki_start` 仍未注册，`:293` 的幻觉探针前置条件仍成立，不用换探针 |
| ⑬ 记忆角色 | 5 过 + 1 预期失败 | 5 过 + 1 预期失败 | #31 未修：日志仍是三条 `Post-write … skipped: L02 LLM completion API is not published`（`memory/src/service.ts:528-549`） |

pin 核对：
- **#23 未修**。W18 已定位根因并把补丁交给 W09（W18 报告交接 35：`NoteContentView.tsx` 820 行 `handleEditorReady` 不再抢焦点），
  该补丁未进 INT；`NotesCrepeEditor.tsx:2979`、`NotesEditorHeader.tsx:143`、`NoteContentView.tsx` 自上轮交付未改，生产包实测焦点仍落在正文。W09。
- **#31 未修**，见上。W03。
- **#28 未变**：run/start 仍卡在 `host/plugins/chatanki/BLOCKERS.md:18` 的 facade。
- **#34 / #35 未修**：`NoteContentView.tsx:740-749` 未改；`host/kernel/main.ts:90`（行号随合并后移）仍是 `setTimeout(flushCompileCache, 5_000)`。
- **#33 未修**：`src/dstu/api.ts:189` 白名单仍缺 `res_`、`file_`。

### 台账验收用例（本轮重点）

已在 INT 的修复写成普通用例；不在 INT 的写成 `test.fail`，标题带台账号。三条 `test.fail` 都在本地临时套上对应 lane 的提交验证过“修好就转绿”，验证后已还原，未提交。

| 规格 | 台账 | 状态（INT 2be7ed80） | 观察点 | Rust 对应 |
|---|---|---|---|---|
| ⑭ `14-startup-recovery` 例 1 | V04-03/04 前置 | 过 | 文件应用“新建 › 导入资料…”导入 1 txt + 2 PDF；txt 资源 `index_state='indexed'`；两份 PDF `processing_status` 到 `completed*`、有 `preview_json`、`page_count=1` | — |
| ⑭ 例 2 | V04-03、V04-04（W29） | 过 | 关闭后把库改成“中途崩溃”的样子（PDF 停在 `ocr_processing`、清掉另一份的 `preview_json`、资源与 unit 停在 `indexing`），同库重启：PDF 回到首轮终态且 `vfs_get_pdf_processing_status` 一致；预览补齐；资源重新索引且嵌入请求带标记；无残留 `indexing`；四条日志 `Recovered 1 stuck media processing tasks…`、`Auto-resumed pipeline for recovered file: <id>`、`Recovered N stuck indexing records`（N = unit 数 + 1）、`Backfill: found 1 historical PDFs missing preview_json` | `lib.rs:3606-3644` 顺序：backfill → recover_stuck_tasks + 续跑 → recover_stuck_indexing |
| ⑮ `15-auto-backup` 例 1 | V04-01 前置 | 过 | 设置 › 数据治理 › 备份打开“定时自动创建备份”：toast“备份设置已保存”；`backup.config` = 开 / 24 h / 保留 5；显示“每 24 小时”；打开开关本身不产生 ZIP | `backup_config.rs` 默认值 |
| ⑮ 例 2 `[V04-01]` | V04-01（W30 `a6e4ccb7`） | 预期失败：没有 ZIP | 同库重启，测试钩子把调度器自己的两个延时缩成 8 s / 5 s：恰好 1 个 `auto-backup-YYYYmmdd-HHMMSS.zip`；`backup.last_auto_backup_time` 为 RFC3339 且落在本次窗口；`auto_backup_status` 无错误、`nextDueAt` 比本次晚 23 h 以上；ZIP 有 `manifest.json`、无 `crypto/`；再过两个检查周期仍只有 1 个 ZIP；日志 `[AutoBackup] 自动备份调度器已启动` | `lib.rs:1680-1694`、`backup_config.rs:278-628`（120 s 后首检、3600 s 一检、未到间隔不备份） |
| ⑯ `16-background-residency` 例 1 | V04-02 反例 | 过 | 三个驻留条件都不满足（默认心跳任务存在但未启用）：关主窗口后进程 20 s 内以 0 退出，wire 有 `host-shutdown-complete` 与 `host-exit 0` | `lib.rs:1774-1780` macOS 退出 |
| ⑯ 例 2 `[V04-02]` | V04-02（W06 `84dc82e8` + W23） | 预期失败：关窗即退出 | 建一个 once 提醒任务后关窗：进程与 Host 存活，窗口隐藏未销毁；恰好一条通知“Deep Student 正在后台运行 / 已启用的定时任务会继续按计划执行。”；隐藏期间任务到点运行，`chat_v2_automation_runs` 一条 `success`，提醒通知“自动化：<名称>”；窗口仍隐藏 | `lib.rs:1714-1783`、`automations.rs:4779-4792` |
| ⑯ 例 3 `[V04-02]` | V04-02 | 预期失败：前置（进程已退出） | 另建一个每日任务保持条件；`activate`（macOS Reopen）唤回窗口；再关窗后用生产入口 `electron/main.ts` 在同一 userData 上启动第二实例：窗口被唤回、第二实例自行退出；显式 `app.quit()` 不被拦截、以 0 退出 | `lib.rs:3270-3285`、`lib.rs:695-701`、`lib.rs:3249-3252` |
| ⑰ `17-super-inbox` 例 1 | V01-02 前置 | 过 | 设置 › 自动化 › “启用 Super-agent”：`super_session_get_state` 为 enabled 且有 sessionId；`super_agent.enabled='true'`；除投递调用外无错误 | — |
| ⑰ 例 2 `[V01-02]` | V01-02（W02） | 预期失败：`chat_v2_super_deliver_inbox not allowed. Command not found` | 常驻控制器的首次投递返回 `{status:'empty'}`；之后 15 s 内不再调用（空收件箱无退避重试） | `lib.rs:2580` 无条件注册 |
| ⑱ `18-migration-status-event` `[V03-02]` | V03-02 方案 A（W30 交接 AL-05） | 预期失败：第 1 次启动约 4.6 s 时 Host 推送了事件（`startup-events.ts:80`） | 同库连续启动 3 次：渲染进程收到 0 条 `data-governance-migration-status`；页面无迁移提示；Host 不向 shell 推送该事件（确定性观察点；页面能否收到是竞态，本机 3 次都没收到） | `lib.rs:1117,1133,1181,1212,1284` 在 setup 内同步发出，页面监听还不存在 |
| ⑬ 新例 #32 | #32（W02 `cc51bee4` 已修） | 预期失败：前置 #31 | #31 之后的下一轮请求带上分类摘要，成员记忆被打上 `_last_injected:` | `prompt.rs:236` |

修好转绿验证（本地临时改动，验证后还原，未提交）：
- ⑮：`git diff assault/integration...assault/W30-auto-backup -- host/` 套上后，`[V04-01]` 报“Expected to fail, but passed”；`[w12-timer-scale]` 只缩了 `auto-backup-scheduler.ts:105` 的 120000 / 3600000 两个延时。
- ⑯：`84dc82e8` 的 `electron/main.ts` + `electron/app-lifecycle.ts` 用 `patch -F3` 套上后，例 2 报“Expected to fail, but passed”；再临时去掉例 2 的 `test.fail` 跑一遍，例 3 也报“Expected to fail, but passed”。

测试钩子 `__fixtures__/host-timer-scale.mjs`（`W12_HOST_TIMER_SCALE=file=<片段>&delays=<原>:<新>,…`）：Electron 的 utilityProcess 会收下 execArgv 里的 `--import` / `--require`，但不执行（本机最小复现确认），所以 `window-main.mjs` 改为 fork 这个包装入口：先替换 `setTimeout`，再原样 import 真正的 Host 入口（`W12_HOST_ENTRY`）。只有调用栈上一帧在指定文件、且延时恰好等于所列值的调用才被缩短，其他计时器不变，产品默认值不改。

### 用例纠正

- ⑬ 引用 `[记忆-N]`：合 INT 2be7ed80 后两次失败（`unified_search` 0 个来源）。原因在用例：上一例 `memory_write_smart` 的 UPDATE 把笔记绑定到新资源，
  该路径不做即时索引，要等索引 worker 下一拍（Rust `memory_executor.rs:1173-1175` 同样只做 post-write maintenance，`memory_write` / `update_by_id`
  才即时索引）。旧 INT 上 worker 恰好在引用轮之前跑完，新 INT 整体快了约 1 s 就赶不上。补了前置等待：该笔记当前资源 `index_state='indexed'`
  （上限 60 s，与同文件已有的“可检索”等待一致）。断言本身未改，不是产品回归。
- ⑯ 编写中自查出的两处断言错误（都在套上 W06 提交后发现，INT 上被 `test.fail` 掩盖）：notify 任务的提醒标题是“自动化：<名称>”（`automation-runtime.ts:340-350`），
  不是 agent 回合完成的“自动化完成：<名称>”；once 任务跑完会自我停用，第二次关窗已无驻留条件、按 Rust 正确退出，所以例 3 先建一个每日任务。

### 薄弱用户路径

| 规格 | 路径 | 观察点 | Rust 对应 |
|---|---|---|---|
| ⑲ `19-translation` 例 1 | 全部应用 › 翻译 › 新建翻译 › 输入英文 › 翻译 | 新建即生成一条 `translations` 资源；一次流式请求，模型为 model2（翻译模型回退），提示词含原文；结果区显示模型流式返回的译文；资源正文恰为 `{source, translated, meta:{schemaVersion:2, srcLang:'en'（按原文自动识别）, tgtLang:'zh-CN', formality:'auto', domain:'general'}}`；无错误 | `translate_text_stream`（`engine.rs:88-215`）只发事件不写库；前端经 `dstu_update` 原样落到 `resources.data`（`content_helpers.rs:640-676`） |
| ⑲ 例 2 | 同库重启 › 翻译 › 选中历史条目 | 列表恰 1 条；原文框与译文恢复；数据库行不变；重开不再请求模型 | — |

其余薄弱路径本轮已有覆盖：设置（⑮ 备份开关、⑰ Super-agent 开关）、导入（⑭ 文件应用导入 txt/PDF）、备份恢复（⑤ 既有）。错题本与媒体本轮未写，原因见交付报告。

### 第九轮性能（⑨，合 2be7ed80 后，3 冷 + 5 热中位数）

新增“桌面就绪 60 s 后、未开任何应用”的稳定值（最后一次冷启动与最后一次热启动各一个样本），回应 W01 的“内存预算按就绪 60 s 后的稳定值”。

| 指标 | 冷启动 | 热启动 |
|---|---|---|
| 首个窗口 | 0.82 s | 0.78 s |
| 到协议页 / 到 dock | 3.97 / 4.11 s | — / 2.91 s |
| Host ready | 3.78 s | 2.45 s |
| 空闲 主 / 渲染 / Host / GPU | 258 / 344 / 340 / 125 MB | 257 / 320 / 347 / 110 MB |
| 就绪 60 s 后 | 242 / 303 / 276 / 121 MB | 244 / 297 / 288 / 110 MB |
| 开应用后 | 246 / 389 / 361 / 137 MB | 250 / 394 / 361 / 127 MB |

Host 在就绪 60 s 后比空闲采样低 60 MB 左右，渲染进程低 20–40 MB。按空闲采样定预算会偏高。

交付前全量里的 ⑨（同一 INT，`--rebuild`）：冷启动 首窗 0.84 s、dock 4.04 s、Host ready 3.72 s，稳定值 240 / 304 / 276 / 122 MB，与上表一致；
热启动 dock 4.16 s、Host ready 3.87 s，比上表慢约 1.3 s，稳定值 185 / 228 / 261 / 96 MB 明显偏低。两次之间产品代码未变（只合了测试），
同时段 gui 槽有其他 lane 的测量任务在排队，原因未定位，不作回归判断，下轮复测。

### 交付前全量（INT 2be7ed80，W12 `af07bf77`）

`bin/heavy … --rebuild`，12.6 min：74 例全部按预期（66 过 + 8 预期失败），无意外、无未跑、无 flaky。

| 规格 | 开工（61 例） | 交付（74 例） | 说明 |
|---|---|---|---|
| ①②②b③b④⑤⑦⑧⑨⑨b⑩⑪⑫ | 全过 | 全过 | ⑥ withheld 2/348（`chatanki_run`、`chatanki_start`，#28 未变） |
| ③ 笔记 | 3 过 + 1 预期失败 | 3 过 + 1 预期失败 | #23：183ms 新建 → 332ms `DIV.ProseMirror` |
| ⑬ 记忆角色 | 5 过 + 1 预期失败 | 5 过 + 2 预期失败 | 新增 #32（被 #31 挡住）；引用例补了索引前置等待 |
| ⑭ 启动恢复 | — | 2 过 | V04-03/04 已在 INT |
| ⑮ 自动备份 | — | 1 过 + 1 预期失败 | `[V04-01]` |
| ⑯ 后台驻留 | — | 1 过 + 2 预期失败 | `[V04-02]` ×2 |
| ⑰ Super 收件箱 | — | 1 过 + 1 预期失败 | `[V01-02]` |
| ⑱ 迁移状态事件 | — | 1 预期失败 | `[V03-02]`：本次第 1 次启动 3.6 s 推送 |
| ⑲ 翻译 | — | 2 过 | 新薄弱路径 |

### 合并 INT 1d1fdb78 后（D 批：W30 `6c3e1770`、W07、W05、W18、W19、W27、W32、S01）

全量后 INT 前进到 1d1fdb78，W30 的 V04-01 调度器与 V03-02 方案 A（`41bdba3a`）进 INT。合并后翻转两条 pin（去掉 `test.fail`，标题保留台账号，断言一字未改）：
- ⑮ `[V04-01]`：转为普通用例。本次 ZIP `data/recovery/backups/auto-backup-20261107-075746.zip`，`lastError=null`。
- ⑱ `[V03-02]`：转为普通用例。三次启动 `pushedAt` 都是空。

本轮两次全量已用完，合并后只跑与 D 批相关的规格（`--rebuild`）：①②②b⑤⑦⑭⑮⑱⑲ 共 25 例全过；⑮⑱ 再单跑一次也过。
其余规格的结果以上面的交付前全量（2be7ed80）为准。W06 `84dc82e8` 与 W02 `chat.send@1` 仍未进 INT，⑯ ⑰ 的 pin 不变。

### 交接收集

- AL-05（W30 → W12，V03-02 方案 A 端到端）：写成 ⑱ `[V03-02]`，见上。AL-05 原话是“进 INT 后再写”，W30 未进 INT，所以先以 `test.fail` 固化，进 INT 后应自动转绿。
- R01 复核（`.reports/reviews/R01-C-batch-W03-W04-W06-W08-W12.md`）：W12 `12a23235` 可合、无问题；L3 指出上轮交付报告末尾混入英文过程文字，本轮报告注意。
- W04 / W10 / W26 交给 W12 的 #27、#30 翻转与 ⑩ 改读顶层 `resourceId`：上一轮已处理，本轮复核 ⑩ ⑬ 现状一致。

## 下一步（交给主代理）

- 第九轮交接（INT 1d1fdb78）：
  - W06：交付 `84dc82e8`（V04-02 接线），⑯ 两例 `[V04-02]` 会转绿，去掉 `test.fail`。
  - W30：已进 INT，⑮ `[V04-01]` 与 ⑱ `[V03-02]` 已翻转，无待办。
  - W02：发布 `chat.send@1`，⑰ `[V01-02]` 转绿。
  - W03：#31 修好后，⑬ 的 #31 与 #32 两例一起转绿。

- 第八轮交接（INT fe5feb68）：
  - W01：#35，编译缓存定时写盘（`host/kernel/main.ts:88`）；内存预算按就绪 60 s 后的稳定值。
  - W09：#34，标题与正文并发保存（`NoteContentView.tsx:740-749`）；#23；#33。
  - W10 → W22：#28 剩下的 run/start，需要生成管线 facade。
  - W03：#31。
  - W06：compile cache 目录；Host 正常关闭，保证退出时写盘。
  - W08 / W01 / W03 / W10：懒加载。
  - 空闲 GC 经 60 s 对照，不做。

- 第七轮交接：W26（#30，修好后去掉 ③b 第 2 例 `test.fail`）、W09（#23 重开）、W03（#31）、W02（#32）、W04/W10（#27，高，
  也阻塞 ⑬ 引用 record_used 用例）、W10（#28，高）、W09（#25、#26、#29）。

- 第六轮交接：W04/W10（#27，高）、W10（#28 chatanki，高；vfs paper-library 测试 tsc 错）、W04/W09（#26）、W09（`data.json:543` 文案、
  #29、#22–#25）、W01（compile cache 内存与冷启动取舍、堆收缩）、W02/W03（execution-runtime 三项 memory 能力）。

- 第五轮交接：W09（#25、#23 已定位、#24）、W01（compile cache 冷启动 +0.5 s 的取舍）、W02/W03（execution-runtime 三项 memory 能力）、
  W20（⑪）、W17+W09（#22）、W06（#15）。

- 第三轮交接：W07/W14（#20、#21）、W17+W09（#22）、W09/W18（#23）、W09（#24）、W02（#13、execution-runtime 三项 memory 能力，或由 W03 在
  MemoryService 上暴露）、W06（#15）。

- 交接：W10（#1）、W09（#2、#5、#6、#7）、W02（#3、#13、#14）、W06（#15）、W03（#16）。修好后对应 `test.fail` 会转红提示转正。
- 旧数据：WP-043 有历史发行版真实产物后，换掉 `build-old-data.ts` 的数据源即可复用 08。

## 发现（按严重程度）

1. **[高（开发态）/低（打包态）][W10] 重启后无法重新打开对话**：前端 `chat_v2_save_session` 的 `chatParams` 带
   `modelIdPinnedByUser`（`src/features/chat/core/types/common.ts:126`）；Rust `ChatParams`（`dstu-agent/src/chat_v2/types.rs:2651`）
   无此字段，serde 反序列化时丢弃；TS `host/plugins/chat/src/register.ts:379` `saveSessionAction` 原样存储，
   `chat_v2_load_session` 返回后被 debug Host 的结果契约拒绝（`must NOT have additional properties at /state/chatParams`）。
   真窗口复现：发一条消息 → 重启（同数据目录）→ 打开对话 → “会话加载失败 已自动创建新会话”，历史不显示。
   打包态 `debug=false` 不做结果校验，不受影响；所有 `npm run dev:electron` / 冒烟运行都受影响。
   修法：保存（及读取已存脏数据）时按 Rust `ChatParams` 字段集投影。另：Rust 也丢 `modelIdPinnedByUser`，“手动固定模型”
   跨重启不保留，属 Rust 原有缺陷，可同时在契约里补字段。冒烟以 `test.fail` 固化（02 最后一个用例）。
2. **[中][W09] 生产包里快捷助手初始化必失败**：`src/quick-assistant/window.ts:90`
   `const { enabled } = await import('./config').then((m) => m.getQuickAssistantConfig())`。Vite 的动态 import 解构摇树
   把模块对象裁成只含 `enabled`，`.then` 里拿不到 `getQuickAssistantConfig`（dist `window-*.js` 可见）。
   控制台：`[QuickAssistant] initialization failed: TypeError: o.getQuickAssistantConfig is not a function`；全局快捷键
   `CommandOrControl+Shift+Space` 永不注册（Tauri 生产包同样受影响）。修法：
   `const { getQuickAssistantConfig } = await import('./config'); const { enabled } = await getQuickAssistantConfig();`。
   冒烟以 `test.fail` 固化（01 最后一个用例）。
3. **[中][W02/W05 或第二阶段] chat-pipeline 装配缺口**：`host/plugins/chat-pipeline/src/execution-runtime.ts` 每轮对话记 7 条
   `owner capability unavailable`：会话标题/标签不生成（:373，会话一直叫“未命名会话”）、用量不写账本（:389）、
   自动记忆抽取跳过（:328）、用户画像/学习者画像/AGENTS.md/目标摘要不注入系统提示（:399、:404 及附近）。
4. **[已修复，W06 `8455179`] `DS_APP_DATA_DIR` 不隔离日志与 sync 目录**：`host/platform/paths/index.ts:200` 的 `appLogDir`
   在 macOS 取 `$HOME/Library/Logs/<identifier>`，sync 状态库取 dataLocal。只设 `DS_APP_DATA_DIR` 的冒烟会写进真实用户目录。
   W07→W06 交接已列，W06 第二轮在做；冒烟侧同时重定向 HOME 规避。覆盖时 identifier 取了数据目录名（日志在 `Library/Logs/data/`）。
5. **[低][W09] 停止后界面与存档差一个片段**：点停止时前端立即停止渲染，Host 处理 `chat_v2_cancel_stream` 之前已发出的
   chunk 仍会落库（wire 实测：取消请求后 28ms 又发出一个 chunk，DB 比界面多 1 个片段）。Host 侧取消是同步的
   （`tool-loop.ts:444-452` 撤钩子并中止传输），属延迟竞态；前端可在 `stream_cancelled` 后按存档对齐内容。冒烟断言“存档 ⊇ 界面，至多多 2 个片段”。
6. **[低][W09] 事件序号**：后端在 content start（seq 1）前发 `skill_injection_audit`（phase end，seq 0，与 Rust
   `tool_loop.rs:737` 一致）；前端 `eventBridge.ts` 只以 start 为锚，seq 0 进缓冲后靠超时冲刷，并告警
   “No handler registered for event type skill_injection_audit”。
7. **[低][W09] 启动告警**：4 条快捷键冲突（`mod+n` 等 chat 与 notes 同名注册）；`[DSTU] 命名空间 "chat-v2" 未注册处理器`。
8. **[信息] 启动即访问外网**：前端更新检查经 `plugin:http|fetch_send` 请求 `download.deepstudent.cn` 与 GitHub；冒烟用黑洞代理挡住。
9. **[信息] Agent 模式入口**：桌面前端所有上下文类型 `tools: []`，`schemaToolIds` 永远为空；`attempt_completion` 只在
   后端收到 `schemaToolIds` 时自动注入（`chat-pipeline/src/tool-loop.ts:346-353`，与 Rust 相同）。冒烟用 UI 实际发出的
   请求加 `schemaToolIds` 经真实 IPC 发送覆盖。
10. **[信息] 备份快照屏障期间设置读取失败**：导出时 `mistakes.db` 进入维护态，`get_setting` 返回
    “Database mistakes is in maintenance mode”（与 Rust `get_conn_safe` 一致，`dstu-storage/src/database/mod.rs:730,4122`）。
    设置页还在加载时点导出会在控制台报“保存配置失败”。冒烟等页面 IPC 静默后再导出。
11. **[信息] 闪卡评分 280ms 防误触**：`ReviewSessionScreen.tsx:65` 翻面后 280ms 内的指针评分被忽略（有意设计）。
12. **[环境] vite build 默认堆 OOM**：需 `--max-old-space-size=8192`；建议在 `package.json` 的 `build` 脚本固化（未改，避免与他人冲突）。
