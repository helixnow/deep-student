# F2-shell：v2 接手盘点（2026-11-04）

## WP-199（2026-11-06）：Started 启动诊断桥

- 开工 `cf01cbe44` 正常 merge main `df2cd30a1`（Already up to date）；090/134/194 依赖均在 main，137 的停机前置阻断及四文档原样保留。20分钟内检查点已通过 coord 发给 C1（`WP-199-checkpoint.md`）。
- 生产：`preload/boot-diagnostics.ts` 逐分支迁移 `lib.rs:494-556`；`preload/preload.ts:85-86` 在正式 Tauri bridge 之后同步 executeInMainWorld。四类事件、原8000ms空root、八字段payload、invoke拒绝best-effort、旧cleanup先行/clearTimer/三个capture监听/delete全部保持。
- 真实验证 `20261105233750-4b763f`：2 files / 3 passed / 0 failed / 0 skipped / Errors0 / exit0。`boot-diagnostics-host.test.ts` 复用生产 main、正式 preload、官方 Host/profile/原ACL；HTTP响应使用 tauri.conf.json 原CSP，允许外部首脚本并真实阻断inline。原50秒报告/60秒用例预算未扩大。
- 原件 `/tmp/opencode/f2-boot-53vSXO/{reports.json,wire.jsonl,electron.log}`：首脚本看到cleanup并立即抛错，window/resource/Error与string rejection/CSP均到正式F4日志；8000ms空root上报；前端未改的 installGlobalErrorReporter 清理同一函数，实测clear id1+三个capture remove，后续仅正式reporter上报；两次reload正确重装。
- quick-assistant 的非空root不报空屏，main cleanup后仍捕获自己的错误；真实 `browser_open_session` 创建 browser-content，缺root依原timer尝试上报，但原ACL逐条拒绝，callbacks=0且无递归rejection；不开放日志权限。不同webview各自cleanup仍存在。Linux detached已验，mac/Win embedded未实跑。
- `boot-diagnostics.test.ts` 是补充边界证据：测生产installer的旧cleanup先于新安装、精确8000、清timer/监听、已捕获旧回调active抑制、root三分支、资源src/href/tagName、缺invoke/拒绝，不替代真实页面事件验证。
- 基线typecheck `20261105232951-360189` exit0；修后 `20261105233407-b78a20` exit0。修前 `20261105233237-4b2b21` 1 failed（cleanup未安装）；中间 `20261105233407-e5d17b` 1 passed/1 failed（测试在日志回执未清空前reload），失败原件保留。原090 lifecycle在后一job实际通过。
- TESTMAP 10 ported / 4 merged / 1 obsolete / **3 pending → 3 pending**；无Rust测试去向变化，不消费L10租约/修改L19接管，不新增B/C资格。全目录、最终tip/base与官方gate见交付报告。

## WP-137（2026-11-06）：Linux localStorage 停机前置阻断

- 正常 merge main 到 `df2cd30a1`；D-054 已批准，不再等待 target wins/失败策略裁定。
- 当前正式入口缺少旧应用及 WebKit writer 已停止、复制期间保持停止的可靠核验。Electron userData 单实例与 Tauri session D-Bus 不互锁；旧插件没有 writer 退出回执。详细源码和停机观察边界见 `storage-migration/WP-137.md`，阻断交 C1。
- 当前树无 dist，IndexedDB 传递依赖静态和产品运行均未验；WP-045 下面“只有 localStorage”是旧范围过度结论，以修正后的 DESIGN 为准。browser profile 登录态仍未迁，不批准丢弃。
- 本包修正 DESIGN/BLOCKERS 的过时等待裁定、skipped、hash 清单和快照一致性说法；生产迁移未接入，不改主窗/CSP/sandbox/ACL。TESTMAP 3 pending → 3 pending。

## WP-194（2026-11-05）：browser typed error → F1 ShellError.data

- 起点正常 merge main `fd9d654d7dddee26913a1f8ab2b064445ff99dc0`，193 公共面与 134 入站原文均在 main。
  基线 typecheck `20261105220508-8aab33` exit0；browser surface/真实 main/Host readiness
  `20261105220508-ae6e37`：22 passed/0 failed/0 skipped/无 Errors/exit0。
- 真实密码 DOM + 当前 L19 生产 bridge → executeJavaScript → main shellRequest/HostSupervisor →
  MessagePort → 真实 F1 公共 ShellError 的窄反证 `20261105220753-84936d`：1 failed/exit1，
  缺少 data，但原 Display 和失败 settle 仍存在。raw `/tmp/opencode/f2-browser-error-YzD9n5/{report.json,wire.jsonl}`。
- 最小修复：`shell/browser-protocol.ts` 仅有效 body 抛内部 BrowserBridgeError，data 使用 F1 公共类型；
  `shell/host.ts` 仅此品牌附既有 errorData 字段。普通 Error/string/对象、非法 JSON、原超时均不升级。
  details 缺省/null→无 details，其他值保留；显示仍 `bridge error CODE: message`。
- 修复后定向 `20261105220902-29c329`：9 passed/0 failed/0 skipped/无 Errors/exit0。
  新测试的密码场景名 PASSWORD_INPUT_BLOCKED 对应真实 code BLOCKED（Rust 与生产脚本一致）；不造码。
  null/嵌套是测试页 body 变体，原密码/STALE_REF/成功/无窗口失败为未改的生产路径。
- 真实测试源为 main 本地窗口，额外断言 wire、公共 instanceof、source、独立 Display、pending=0、
  callback=0、唯一 settle；不是 L19 业务恢复/官方 profile 全链签收。WP-195 继续等本供方正常集成。
- 其它既有 decoder 差异登记 BLOCKERS 后继；TESTMAP 仍 10 ported/4 merged/1 obsolete/3 pending，
  无新 B/C 资格。最终固定 tip/base/gate/jobs 与原输出以 WP-194 交付报告为准。
- 完整回归 `20261105221120-a717bc`：F2 全目录 + F1 shell-error-wire，44 files passed/1 既有平台 skipped，
  209 passed/0 failed/6 既有 macOS skipped/无 Errors/exit0（其中 F2 202 passed，F1 7 passed）。
  WP-134 原入参/ACL、raw JSON 出口、真实官方 Host、启动 watchdog 与 F1 超时/断连/重复回复清理原断言均通过。
  修复后 typecheck `20261105220902-2dd8f8` exit0；修复后实际页面报告
  `/tmp/opencode/f2-browser-error-8twLwM/{report.json,wire.jsonl}`。自动检查点 `67c26f27b` 保存了部分本包修改，
  后继责任提交补齐 parser 与规格，不把中间检查点单独当作可集成候选。
- 首次固定 tip `39a4e5369` 的正式 gate：boundaries 两项通过，typecheck
  `20261105221317-adb251` exit2，报本包最后新增 `host-shell-error.test.ts:41` 的解构参数隐式 any。
  仅为记录调用的测试回调补 `unknown[]` 类型，不改变用例/断言/生产行为，后继提交再 gate。

## WP-090（2026-11-06）：真实页面加载发送 `page-load-started`

- Rust `lib.rs:484-491` 的 `PageLoadEvent::Started` 在 wry 三平台都是主框架新文档提交。Electron 用 `did-navigate`：应用窗口在
  `shell/windows.ts` `wire()`，browser-content 在 `main.ts` `registerWebview`（已注销不发）。既有 `did-start-navigation` 的 abandon 不变。
- Electron 45.2.1 探针（作业 `20261105191040-91f7ff`）：初次加载、reload、302 各一次 `did-navigate`；hash、pushState、iframe、204、下载、错误页都没有。
- Host 未 ready 时沿用 `HostSupervisor` 队列；Host 不可用后丢弃，与其余生命周期相同。语义细节与差异见 `migration/spec/F2-shell.md`「页面开始加载生命周期」。
- 证据：修复后 `20261105191555-4c7dca` 2 files / 5 passed / exit 0；typecheck `20261105191555-b7cffa` exit 0；
  HEAD 隔离副本去掉两处 `did-navigate` 后 `20261105192731-9705a8` exit 1（browser-content 初次页面加载等待超时）。
- WP-090 当时未做：L10 租约清理消费、启动诊断桥 eval、macOS/Windows embedded 实跑；诊断桥由后继 WP-199 补齐，另两项仍保留。TESTMAP 不变（3 pending）。

## WP-045（2026-11-05）：W6b WebView 存储迁移设计

- 交付 `electron/storage-migration/DESIGN.md`（交 C1 裁定）与只读盘点 `webview-storage-inventory.json`
  （生成脚本 `electron/scripts/webview-storage-inventory.mjs`，作业 `20261105160155-d6398b`）。迁移**未实现**。
- WP-045 当时仅排查 src 直接使用；WP-137 更正：localStorage 必须迁移、sessionStorage 不持久，IndexedDB/Cookie/CacheStorage 不能据此外推传递依赖及浏览器 profile 无迁移需求。
- Linux 隔离取证：`electron/tests/fixtures/webview-storage/`。WebKitGTK 2.50.6 的 `tauri_localhost_0.localstorage`
  为 SQLite `ItemTable`，值是 UTF-16LE 码元（作业 `20261105153605-3a27bc`）。可复跑场景 `run-scenario.sh`
  （作业 `20261105155237-c7af9a`，SCENARIO PASS）：node:sqlite 读副本 → sandbox preload 写入 → flush → SIGKILL → 读回逐键一致，
  目标已有键保留，源文件指纹不变。夹具不是生产实现。
- 发现：Linux 上 Tauri app data 与 WebView 数据同目录，F3 启动恢复会把 WebKit 目录当旧版根条目隔离；
  快照必须在 Host 启动前完成。mac/Win 未实测（U-001）。未改 TESTMAP 去向。

## WP-006（2026-11-05）：版本无 Shell 依赖与桌面桥证据

- 工作包范围限定为版本、Shell request 与真实桌面已有用例；完成后按 WORKER.md `wp-done WP-006` 结束，本文件历史自动续派条款不适用于本会话。
- Rust `commands.rs:500-507` 版本只读构建常量，无 AppHandle/Err。Host 命令改为安装时取得完整字符串；main `app.fullVersion` 共用 build-info 来源，保留版本、Build、8 位 commit。
- 复用 `shell-real-host.test.ts` 的官方 profile/ACL/HostReady、PDF/filestream 与两 restart hooks 覆盖，仅补缺失的版本断言；协议 fixture/main 用例另补旧版本 op 断言。新增无 Shell debug/release 入口回归，不伪造业务成功/错误。
- F3 restart 与 L13b filestream 的 headless 缺桥错误归属交 C1/C2，详见 BLOCKERS 顶节及 SPEC 的逐分支表。原 Rust 无相应 headless 分支；不把 X1 panic 证据外推为 GUI 损坏。
- TESTMAP 起点为 10 ported / 4 merged / 1 obsolete / 3 pending（generated 表头为历史数值）；本包没有改 Rust 测试去向，3 条 mobile helper pending 保留。
- 起点 typecheck `20261105140100-8f6205` exit 0；版本/命令/真实 Host 基线 `20261105140101-321aea` 16 passed/exit 0。
- 无 Shell 新回归先红 `20261105140500-15945a`：debug/release 两条均 HandlerPanic，cause 为 `test host has no shell handler for "app.fullVersion" (pass options.shell)`。修复后 Node 全目录 `20261105141054-47f5ee`：186 passed / 1 failed / 6 既有 macOS skipped，exit 1；新版本两条与真实 Host、真实 main 桥均通过，唯一失败是旧 `commands.test.ts:39` 硬编码 Shell 替身值。
- 该旧测试不是 Rust TESTMAP 移植项。依据 `commands.rs:500-507` 将其期望改为实际构建元数据的精确完整字符串，仍保留替身哨兵值，并增补零 Shell 请求断言；vibrancy 返回值与调用窗口断言不变。不是放宽数值/正则匹配，也不改任何 Rust 断言。
- 修复后 typecheck `20261105141054-24685c` exit 0；最终固定提交与复验作业汇总以 WP-006 交付报告为准。

## F1-RAWJSON-01 后继受理（2026-11-05）

- 已读 Rust `commands.rs:1168-1187` 的 Value 事件发射、F1 当前 JSON 出口及 F2 最终二次
  stringify。F1 候选修复有限 raw atom 变对象；F2 的极值 raw 后继仍待来源保真协议。
- 通用 Infinity/-0 replacer 的本地实现虽曾使 `20261105103842-8bc921` 11 passed，
  但漏区分 typed 非有限应 null，已在提交前撤回生产改动；不以该green签收。
  最初 red 两轮及实验作业均保留，详见 BLOCKERS 顶节。
- `projected-json.test.ts` / `projected-json-host.test.ts` 现只测普通来源：生产 encodeBody、
  真实 Electron main/MessagePort/preload/renderer 上的 typed 非有限/负零归一、有限数字、
  普通 rawJSON 属性、特殊 own key 与二进制不回归；没有原生品牌来源就不能断言 raw 极值。
  本轮新测试纠正了初始错误 oracle，非修改既有 Rust 移植测试，提交信息如实注明。
- 普通消息的修正 oracle 作业 `20261105104248-beed3f`：3 files / 10 passed，
  exit 0，无 Errors；这是来源不可混淆的非回归保证，不是 raw 极值闭环成功。
- 已给 F1/C1/C2 请求原始 raw 品牌处生成可选 JSON 文本的最小协议；F1 明确须联签，
  未发布前不在 electron 猜字段/加一般 serializer，不改 frozen kernel 或消费者。
- 再次 merge 已得到正式 main 的 F4 Value/IgnoredAny/endArray，旧“F4 尚未发布”已更正于
  BLOCKERS；本轮所缺为 F1 raw 出口正式集成及其极值原文协议，不把它继续归给 F4。
- C1/C2 已批准，F1 已确认精确可选字段 payloadJson / json；F2 已接实际 main 事件、
  HostSupervisor 的成功/错误结果与 runtime ResponseBody，存在文本时原样透传、无文本原路径。
  真正双方链路测试 `raw-json-renderer.test.ts` 使用真实 serveHost/插件/F4 raw 品牌，
  初始 `20261105105035-43f218` 1 failed/exit 1；待 F1 生成端正式候选合树后复验。
- 已正常 merge F1 `d2592fecb`，联合树 `e843cfee6`（含 F4 完整 Value 与 F3/L20 527 祖先）。
  原“F5 `1df7ba29e` 冻结文档已为 main 祖先”判断错误；按 C1 纠正已正常 merge 该完整 owner
  祖先纳入后继候选，不再称此前主线已有文档。生产净改动仅三处文本消费，不残留一般 serializer。
  `20261105110555-1783b2`：4 files / 11 passed / exit 0 / 无 Errors。
  真实 kernel/fixture插件/F4品牌→MessagePort→main/preload→renderer 验证混合 raw ±1e400、
  -1e-400、Value整数-0→0、小数-0.0→负零、大整数/小数，以及 typed Infinity/NaN→null、
  typed-0→0、普通 lookalike、success/error/定向event、ordinary event与binary；原 red 断言未改。
  该证据为完整双方候选树，不冒充官方 profile 全业务或 main 独立验收。
- 同一联合源码非增量 host typecheck `20261105110556-66e3a1` exit 0、无诊断。
- `1c6aebf05` 的共享 gate 五项通过，但额外 ledger `20261105110739-97508b` exit 1，
  orphan registrations 4：新增测试插件在普通 `fixtures/` 被生产注册扫描收录。
  按既有 isTestFile 规则移至 `tests/__fixtures__/` 并更新真实测试 profile 的模块路径，
  不改注册逻辑/任何原值断言或生产源码；不是绕过生产扫描，而是纠正测试专属文件落点。
- 修正目录后的单链路 `20261105111800-efda9d` 1 passed/exit 0、无 Errors；ledger
  `20261105111800-c8faeb` exit 0，commands/tests/orphan problems 均 0。

## 已撤回错误 root 序推断：electron 方案无效（2026-11-05）

- 旧派发依据的 `20261105081608-6a1e98`（固定 `0a51a244c`、TS 5.6.3、3033 roots、
  incremental=false）确实报告 1057→10，但使用了 git ls-tree 的根文件顺序，
  并非 tsconfig include 的实际枚举；因此不能据此归因 electron 类型导入修复了 Context 分裂。
- F1 更正为 TypeScript matchFiles/parseJsonConfigFileContent 的实际 root 顺序后，
  `20261105082335-f12744` 仅加 electron 导入仍为 1057 diagnostics，两个 Context 声明数 59/6；
  `20261105082803-954876` 的 native 入口、最终 `20261105083337-7f70f5` 的 F4 secrets
  既有 Context 导入移到顶部才降至 10。剩余为独立 Value 9 条和旧 native 测试缺参 1 条，
  不称整树通过；实际入口修复归对应 owner，F2 不修改 native/secrets。
- 保留真实历史结果：main `50269f70d` 加 electron 导入时，本树非增量
  `20261105082612-3b5f0c` exit 0、无诊断；`fb4666ee6` 的共享 gate 三项通过。
  这些不是固定 0a/F4 联合树的因果证明，不把历史成功改成失败。
- C2 于 08:39:39Z 正式撤回 electron 改动保留依据。本轮仅逐 hunk 删除 `747d76a90`
  在 `electron/api.ts` 新增的注释、具名 Context 类型导入及空行，恢复原处原样，
  保留全部原接口/声明；`747d76a90` / `fb4666ee6` 不再作为 Context 修复交付。
  不 reset/rebase/整批 revert，不扩展探针矩阵或重跑无关业务；新前向提交正常 merge main 后 gate。

## 自动续派收尾：已完成当前可执行工作（2026-11-05）

本轮续派先合并 main：Already up to date（main `a9683a43b`，候选 `9609ca27c`）。
没有新增集成失败或未处理复核 finding。**当前可执行工作已完成，无新增自有待修项**；
这不是整 lane 的 B 级签收，也不把外部阻塞标为已实现。

- C2 已亲核 `9609ca27c` 的 gate 原记录（00:47:30，base a968，ok true），并接受
  `20261105002147-238899` 的 180 passed/6 既有 macOS skipped/exit 0。
  `20261105003355-550652` 的 mode 补充最小集 16 passed/exit 0；
  `20261105003216-339d20` 的 Electron ABI 真实 Host 1 passed/exit 0，均无 Errors。
- 本地 gate 回执与共享旧回执的路径问题已由 C2 确认交架构处理；F2 不复制/修改 `.oc-runs`，
  不重跑相同候选。后续新 tip 在本 cwd 调共享绝对入口
  `node /home/dsdev/dev/deep-student/scripts/electron-migration/lane-gate.mjs`。
- 本次阻塞复查没有解锁：main 仍无 F4 arbitrary_precision Value/IgnoredAny 联合出口，
  3 个 Android helper 仍无精确批准；目标平台/Sentry/setup 事件依赖保留。
  已有 API 到位时先更正 BLOCKERS 的过时结论，再做接线。

本次按 v2 八类复查的是文件/桌面 mode/启动 watchdog 及其入口，不声称替代全 lane 独立审读：

1. 生产接线：`index.ts:83-146` 的 23 个注册及三个 provide 仍在；新增测试走 kernel invoke，
   watchdog 测生产 supervisor。Android helpers 未在桌面生产接线，继续 pending。
2. 所有权：本切片文件 IO 只写调用者目标与自有 WebView 设置；settings 经平台服务，无跨表 SQL。
3. 数据边界：`checkInteger` 当前只接受 number，未向 handler 转换 bigint；
   `read_file_bytes` 的 number 上限截断没有 BigInt 混算，不能凭类型猜测制造新缺陷。
   Rust White_Space 修复由已通过的 NEL/BOM 入口断言覆盖；原文 Value 差异仍列阻塞。
4. 日志/错误：`write_text_file` 的 write_all/flush 文案分别是“写入文件失败”/“刷新文件失败”
   （Rust unified_file_manager.rs:375-383），TS `file-ops.ts:276-285` 对应；该路径无 Rust 日志。
5. 测试真实性：未删除、skip 或弱化既有断言；新增 mode 断言保留非法 mode 先于平台拒绝的顺序。
6. 分支：Rust external_file_opener.rs:68-72,182,239-245 的缺省/合法/非法 mode 和桌面拒绝仍对应；
   审批只批 content_uri，不能推断另外三条也已 obsolete。
7. 运行时：文件 fd 在错误路径清理、复制回读校验不丢；串行 power 状态保留；watchdog 仍有界，
   120s 常量来自既有 startup budget，不扩大原真实 Host 测试期限。
8. 闭环：候选通过及 C2 核验已记录；候选尚未 main、三项 gate 不含 Electron tests 的边界不变。

剩余事项全部有外部证据，详见 BLOCKERS 顶节；恢复本 lane 的触发条件是相关接口正式进入 main、
架构精确批准或目标平台/依赖能力到位，不再对同一候选重复自检或无变化全套。

## 2026-11-05 续作：main-red / F2-v2-10

- 恢复历史、SPEC/TESTMAP/BLOCKERS 后合并 main `e9df01a3c`；没有重做既有外壳。
  main 后续仅工具变更再次合并（`oc-dispatch.mjs` / `pipeline-check.mjs`），不修改其他 lane。
- **main-red 根因**：`shell/host.ts` 的 30 秒 watchdog 早于 Rust 明确容许的 120 秒慢启动
  预算（`startup_gate.rs:22-24`），官方 profile 的迁移/插件启动尚未完成就被终止。
  使用已发布的 `STARTUP_READY_WAIT` 对齐生产 watchdog；不改真实 Host 用例的 50 秒报告
  期限、60 秒测试超时、restart/PDF/filestream/purge 任何断言，不绕过官方 profile/ACL。
  `host-readiness.test.ts` 直接测生产 supervisor，只替换最终 Electron process/port：
  31 秒不误杀、ready 后不误杀、120 秒仍未 ready 则终止。先红 `20261105001927-db1d84`。
- **F2-v2-10 自有路径语义**：Rust `unified_file_manager.rs:40-50,73-75` 用 Unicode
  White_Space；JS trim 会漏 U+0085、误去 U+FEFF。先经真实 kernel 文件命令复现
  （`20261105001316-a4341d` 3 passed/1 failed，exit 1），再改调 F4 `rustTrim/rustTrimStart`；
  不加新库或 lexer。`20261105001637-240911` 4 passed/exit 0。
  同类桌面 mode 入口（Rust `external_file_opener.rs:68-72,182`）也改用 rustTrim；
  `20261105003308-d52bd8` 先红，`20261105003355-550652` 两文件 16 passed/exit 0，
  精确保留“非法 mode 先于桌面拒绝”的错误顺序。
- **修复后本目录全套**：`20261105002147-238899`，
  `npx vitest run -c vitest.host.config.ts electron/tests --maxWorkers=2`：
  `Test Files 33 passed | 1 skipped (34)` / `Tests 180 passed | 6 skipped (186)`，
  无 Errors，exit 0；指定真实 Host 用例 23.42 秒通过。macOS 6 条原 cfg 跳过不变。
  不将该分支作业外推为 main 已集成或目标平台独立签收。
  Electron ABI 复验 `20261105003216-339d20`：指定真实 Host 1 passed/exit 0、无 Errors。
- 静态自检：typecheck `20261105002148-72d8f1` exit 0；ledger
  `20261105001339-83e5ed` exit 0（commands/tests/orphan problems 全 0）；
  strict `20261105001339-f39d75` exit 0（2950 files、0 violations）；importable
  `20261105001339-b62fe4` exit 0。wiring `20261105001339-6000da` exit 0，但该工具
  对 `--lane electron` 显示 ported 0，未扫描 migration 下的 F2 TESTMAP；不冒充 18 条已证明可达。
- 首轮不限制 forks 的套件 `20261105000218-1ac390`：312 passed/1 failed/6 skipped，
  Errors 1，exit 1（路径过滤还匹配了 migration scripts），原日志保留；
  限两 worker 的旧实现仍在 30 秒杀 Host（`20261105001130-e20656`），不是仅靠限 worker 过测。
- 已通知架构师 `2026-11-05T001946228Z-F2-shell.md`。剩余真实阻塞仍是：3 条 mobile helper
  精确 obsolete 审批；F4 arbitrary_precision Value + IgnoredAny 出口；L21 两条 setup 事件；
  Sentry SDK 依赖安装及目标平台实测。F1 原文 capability 入口已发布，但缺上述 F4 原语，
  不能把合法 scope Value 改成拒绝。MCP 事件 main 已接，不再沿用旧“没有订阅”阻塞。

基线 `5250ffcdf`；`git merge --no-edit main` 返回 Already up to date。只写 `electron/`、
`migration/spec/F2-shell.md`、`migration/testmap/F2-shell.md`。本树原无 F2 的 LANE/BLOCKERS/ACCEPTANCE；
不创建或代写复核人的 ACCEPTANCE。行为规格与测试账本仍以 migration 下两份 F2 文件为准。

## 八类自查

类别：1 生产接线；2 所有权；3 数据边界；4 日志/错误；5 测试真实性；6 分支；7 运行时；8 复验闭环。
下表是接手审读结果，不是 v2 完成签收。共同事实：23 条入口确在 `index.ts:80-143` 注册（1）；
文件命令无 SQL，settings 写入经 F4（2）；IPC 参数校验依赖真实 kernel 契约层（3），不能把 handler 内的
类型断言当作解码器。所有条目的 8 均为待独立复验；本 lane 没有未勾选 finding 清单。

| 命令/模块 | 问题类型与接手结论 | 证据（相对 electron/，除 Rust 引用） |
|---|---|---|
| copy_file | 1 接线；2 无表；3 路径分类；4/6 错误分支需补；5 尚缺入口失败清理测试；7 目标打开失败泄漏源 fd 已修（F2-v2-01，tests/file-entry-regressions.test.ts）；同步复制阻塞已改为 FileHandle 异步 IO，复制失败时不再用 close 错误覆盖原错误（F2-v2-05）；8 待验 | index.ts:111；file-ops.ts:324-361；Rust unified_file_manager.rs:267-276（RAII） |
| export_unified_backup_data | 1 接线；2 只经 settings/llm；3 Value；4/6 三段前缀；5 单测依赖替身不证明真实 L02；7 已改用 `host/platform/time` 的 `toRfc3339`（F2-v2-06）；8 待验 | index.ts:138-142；backup-export.ts:58-79,98-122 |
| get_app_data_dir | 1 接线；2 无表；3 string；4 无业务 Err；5/6 只读握手值；7 无清理；8 待验 | index.ts:81 |
| get_app_version | 1 经 shell op；2 无表；3 string；4/5/6 待真实 main 链；7 构建常量；8 待验 | index.ts:80；main.ts:471-474 |
| get_file_size | 1 接线；2 无表；3/7 已改 `statSync(..., { bigint: true })`，线上仍按 D3 输出 JSON number（F2-v2-07）；4/6 隐藏路径先行；5 需生产入口精确值测试；8 待验 | index.ts:109；file-ops.ts:235-243 |
| get_prevent_sleep | 1 接线；2 无表；3 bool；4/6 子进程状态；5 需验证 Rust try_wait 的退出回收日志；7 单实例 child；8 待验 | index.ts:94；power.ts:8,34 |
| hash_file | 1 接线；2 无表；3 路径；4/6 读取错误；5 需核入口；7 流式 IO 但 hash 在 Host；8 待验 | index.ts:110；file-ops.ts:246-255 |
| install_apk | 1 接线；2 无表；3 String 经契约；4/6 桌面 Unknown；5 入口测试需对应桌面 cfg；7 无副作用；8 待验 | index.ts:82；src-tauri/src/commands.rs:556-559 |
| load_webview_settings | 1 接线；2 自有文件；3/4 非法 UTF-8 已改为 fail（F2-v2-03，入口测试已补）；**JSON.parse 诊断文本仍不同于 serde_json，待记录为歧义**；6 exists 分支已在；7 异步 IO；8 待验 | index.ts:127；webview-settings.ts:43-63；src-tauri/src/commands.rs:7527-7535 |
| open_file_externally | 1 接线；2 无表；3 mode Option；4/6 先解析 mode 再桌面拒绝；5 **移动端 helper 测试在桌面未接线，不能当生产入口证据**；7 桌面无 IO；8 待验 | index.ts:83-86；external-file.ts；tests/platform.test.ts；src-tauri/src/external_file_opener.rs:239-245 |
| open_system_permission_settings | 1 接线；2 无表；3 枚举由 kernel；4/6 平台错误；5 需核实际 launcher 边界；7 子进程等待；8 待验 | index.ts:89-93；system-permissions.ts |
| pdfstream_check_access | 1 接线；2 无表；3/4 返回三字段；5 **现 main harness 是协议替身，不是实际 Host**；6 canonicalize→白名单→扩展→文件；7 同步 metadata；8 待验 | index.ts:128-137；pdfstream-access.ts；tests/shell-restart-host.test.ts:1-4 |
| read_file_bytes | 1 接线；2 无表；3 u64 maxBytes 需核 bigint；4/6 两次上限；5 测试需入口；7 聚合缓冲 Host；8 待验 | index.ts:105-108；file-ops.ts:194-216,229-233 |
| read_file_text | 1 接线；2 无表；3/6 BOM 保留已修（F2-v2-02，入口测试已补）；4 UTF-8 错误；7 异步 read；8 待验 | index.ts:104；file-ops.ts:219-226；Rust unified_file_manager.rs:247-249 |
| save_text_to_file | 1 接线；2 自有目标；3 String；4/6 错误映射；5 需核入口；7 已改异步写（F2-v2-05）；8 待验 | index.ts:112；file-ops.ts:279-298 |
| save_webview_settings | 1 接线；2 自有文件；3 Value 已核：入参已被前端/kernel JSON 解析，`JSON.stringify(v,null,2)` 与 `to_string_pretty` 缩进、`": "`、空容器、非 ASCII 不转义均一致；f64 写法差异在入参层已不可区分；4 错误前缀；5 helper 不代表入口；6 直写非原子对齐 Rust；7 异步 IO；8 待验 | index.ts:126；webview-settings.ts:23-40 |
| set_android_immersive_mode | 1 接线；2 无表；3 bool 由 kernel；4 无 Err；5/6 桌面 cfg no-op 正确；7 无副作用；8 待验 | index.ts:87；src-tauri/src/system_bars.rs:75-78 |
| set_backend_sentry_enabled | 1 接线；2 F4 settings.save；3 bool；4 warn 路径需核 SDK；5 替身测试不证明真实 SDK；6 禁用/启用；7 串行队列；8 待验 | index.ts:68-79,143；backend-sentry.ts |
| set_prevent_sleep | 1 接线；2 无表；3 bool；4 spawn Err；5 需核日志；6 Win 恒 false；7 串行开关/kill+wait；8 待验 | index.ts:95-98；power.ts:9-38 |
| set_sidebar_vibrancy | 1 接线；2 无表；3 bool；4 Unknown；5 macOS 实机未验；6 非 mac false；7 main 同步 API；8 待验 | index.ts:99-103；main.ts:484-490 |
| set_window_appearance | 1 接线；2 无表；3 bool；4 Unknown；5 macOS 实机未验；6 非 mac no-op；7 原生主线程；8 待验 | index.ts:113-119；shell/native-window.ts |
| sync_titlebar_sidebar_material | 1 接线；2 无表；3 width f64；4 原生错误；5 macOS 实机未验；6 非 mac no-op；7 视图替换清理需实机；8 待验 | index.ts:120-125；shell/native-window.ts |
| updater_install_supported | 1 接线；2 无表；3 bool；4 无 Err；5/6 APPIMAGE 存在性；7 只读环境；8 待验 | index.ts:88；src-tauri/src/commands.rs:516-528 |
| startupGate | 1 provide；2 无表；3 公开接口；4 超时；5 既有 gate 测试；6/7 F1 finishStartup 已接 gate；8 不重复已签 D2 | index.ts:35-36；../host/kernel/connection.ts:111-127 |
| systemNotification | 1 provide；2 settings 只读；3 policy 解码；4 活跃查询失败显式错误；5 当前测试需逐条核；6/7 shell 调用；8 待验 | index.ts:39-44；system-notification.ts |
| runInstallCommand | 1 **桌面入口不可达，已有 ported 不能证明生产接线**；2 无表；3 command String；4 失败/超时；5 需协调者核死代码归属；6/7 kill+reap；8 待裁定 | package-manager.ts:5；tests/platform.test.ts；src-tauri/crates/dstu-platform/src/package_manager.rs |
| main shell-request | 1 真实 HostSupervisor；2 不写业务表；3 ShellRequest；4 保留 ShellCommandError 文本；5 两 restart/PDF 已经真实 Host 验证（见 BLOCKERS.md，作业 20261104104945-974e13）；6 process:restart 别名；7 最终 hooks 可注入；8 待 C2 签收 | main.ts:204-210,259,465-533；shell/host.ts:186-191；tests/shell-real-host.test.ts |

## 处理顺序与边界

1. 无复核未勾选项，不虚构 finding ID。先续 C2 指定的两 restart 别名/PDF 白名单实际 Host 接缝；
   只替换不可逆 OS hooks，不运行真实 relaunch，不触碰用户数据，不再重复 159 全套。
2. 自查项使用 `F2-v2-*` 本地编号，逐类补生产入口回归再修。以上未核/缺证据项不因为旧账本为 A 就签收。
3. TESTMAP 当前机械统计 18 ported / 0 pending，不等于 v2 真实性已通过；移动端 helper 与
   package-manager 生产可达性需按 Rust cfg/调用者核实后上报审批，不能擅自 obsolete。
4. 跨 lane 的真实阻塞写 `BLOCKERS.md`；实际 Host 若被 F3 启动/能力依赖阻断，按 C2 指令记录具体原因并停该组合验证，
   不新增测试环境开关绕生产分支。其余自有缺陷不是依赖阻塞。

## 接手基线作业

- `20261104093535-c04383`：`npm run typecheck:host` exit 0。
- `20261104095252-6e21f2`：shell-ops/host-profile/shell-commands 共 22 passed，exit 0，无 Errors 行。
- `20261104095252-5888ff`：ledger exit 0（旧机械指标，不是独立验收）。

## 语义歧义（申请写入 decisions.md）

- `load_webview_settings` 解析失败的 `{e}`：Rust 是 serde_json 的 Display（如 `expected value at line 1 column 3`），
  TS 是 V8 `JSON.parse` 的消息。错误类型 `Validation` 与前缀 `解析 WebView 设置失败: ` 一致，细节文本不同。
  要逐字一致需要 kernel 提供 serde_json 兼容解析器的错误 Display（F1 `host/kernel/serde.ts` 目前只覆盖 IPC 参数）；
  前端只展示该消息，无分支依赖。

## 本轮结束状态（2026-11-04）

自检 `lane-gate.mjs` 在 `1afb212ed`（基线 main `d84e29565`）全部通过：typecheck、boundaries、boundaries-strict(changed)。
F2 自有的剩余项都在等外部处理，本 lane 没有可以继续做的工作：

- TESTMAP 4 条 pending（external_file_opener 的 Android 专属 helper）：已按 decisions.md「移动端专属测试」
  申请 `obsolete:mobile-only`，证据 `src-tauri/src/external_file_opener.rs:183-245`；等协调者批准。
- C2 签收：真实 Host 的 restart 别名 / PDF 白名单验证（`4ace003d6`，作业 `20261104105934-ec6fc0`）。
- 待目标平台实测（Linux 环境做不了）：macOS 原生窗口效果，以及 macOS/Windows 打包。
- 已完成（原为“待协调者安装依赖 `@sentry/node`”）：W06 第十轮 `9ed330ec` 声明 `@sentry/node` 8.55.2，`04a04488` 在 Host 里真正初始化与上报（FM-11），见 `electron/W06-PROGRESS.md` 第十轮。
- `load_webview_settings` 的 JSON 解析细节文本：C2 不予豁免。缺 F4 的 serde_json 兼容解码器，接口需求见 BLOCKERS.md。
- obsolete 申请：1 条 C2 已批（分片进 main 后落 TESTMAP），3 条等架构师裁定。

## 任务清单：C2 v2 补充（F2-DECODE-*，2026-11-04 受理）

| ID | 位置 | 问题 | 状态 |
|---|---|---|---|
| F2-DECODE-01 | `shell/capabilities.ts:105` | `JSON.parse as Capability` 后直接使用 permissions/platforms；需按 tauri-utils `Capability` 结构解码 | 值级结构校验及共享面收敛已完成：`shell/capability-file.ts` 消费 `host/kernel/api.ts` 的 `decodeCapabilityFile`；本地 Identifier/Target/字段 decoder 已删除。文件装载与 duplicate-id 仍归 F2；插件 scope 条目保持 `unknown[]` 后派生。保留原入口断言，新增公共 decoder/file 包装回归。原始文本 typed-list/from_str 的词法/重复键/错误次序仍未闭合，不称整项签收 |
| F2-DECODE-02 | `shell/tauri-config.ts:139` | `app.windows as unknown as TauriWindowConfig[]`，元素没有校验；需按 `WindowConfig` 的字段、default、枚举边界解码 | 值级元素校验已修：`shell/window-config.ts`；同一 decoder 用于 window create。`unexpectedOf` 已改由 `host/kernel/api.ts` 引入，私有导入余项已解除。default 在映射层；焦点接线另见 F2-v2-08；原始文本精确语义仍不外推 |
| F2-DECODE-03 | `build-info.ts:10` | 打包产物 `version.json` 直接 `as BuildInfo`，绕过 buildNumber 14638..2100000000 的范围检查 | 已修：`decodeBundledBuildInfo` 要求 version 等于应用版本、buildNumber 为整数且 >14638 且 ≤2100000000（build.rs:161-173）、gitHash 为 8 位小写 hex 或 `unknown`；严格 UTF-8 且保留 BOM 交 JSON 拒绝。开发路径 gitHash 改按 `resolve_git_revision`（40/64 hex、小写）。测试 `tests/build-info.test.ts` |

约束：只改 `electron/`；与 F1-DECODE-01 共用同一公开读取面，不复制通用 JSON parser；Rust 允许未知字段的地方保持允许；
入口测试只做最小集，最终 OS hooks 测试隔离。

## 自动续派自查（2026-11-04 15:00Z）

- 合并 main 后首次自检：`2c448a6ae`（main `879e0a56b`），typecheck/boundaries/changed-strict 全过。
- 已处理可落地余项：C2 的精确 approval 已在 main，TESTMAP 只将
  `content_uri_detection_is_case_insensitive` 改为 `obsolete:mobile-only`；其余 3 条保持 pending。
- 八类复核以本轮触及的窗口配置为切片：生产入口 `loadTauriConfig`/window create →
  `decodeWindowConfig` → `mapWindowConfig` → `WindowManager.create`，不写业务表；既有配置拒绝测试不改；
  有效 `focusable:false` 的分支漏接原生构造器，记为 **F2-v2-08**，已贯通该链。
  Rust `tauri-utils/config.rs:2017-2019` 为 default true 的 bool，Tauri `window/mod.rs:882-885`
  提供 native builder；Electron 显式传入 `focusable`。无新增日志、时钟、后台任务或 OS hooks。
  回归：`tests/tauri-config-windows.test.ts` + `tests/window-focusable.test.ts`，作业
  `20261104150701-f55f7c`，真实 Electron/xvfb，5 passed/exit 0，默认 true 和显式 false 均断言。
- 不是全 lane 已签收：F1 公共 capability 出口、JSON Value 精确读取、F3 默认配置回归、目标平台实测仍见 BLOCKERS。

### 本轮已完成与未关闭项

- **已完成本轮可执行单元**：F2-v2-08 的配置→原生窗口接线（实现由自动检查点 `6127f8a8f`
  保存，finding/测试证据提交 `b54e7abff`）；没有改既有测试的断言、跳过条件或 OS hooks。
- 作业 `20261104150915-21a5d3` typecheck exit 0；`20261104150915-0c3be1`
  ledger check/no-write exit 0，commands/tests/orphan registrations problems 均为 0。
- F4 原语已到 main，但 `parseJsonDocument` 尚非 arbitrary_precision Value 的完整出口，
  按 BLOCKERS 新证据上报 `2026-11-04T151413805Z-F2-shell.md`，不贸然替换而拒绝合法设置。
- F1 候选仍未在 main，继续保留切换任务，不以“已完成”关闭 F2-DECODE-01 的共享面收敛。

## 自动续派：F1 共享面收敛已完成（2026-11-04 15:38Z）

- main `4525e11ac` 已包含 F1 正式公共面，合并点 `f7bb4e306` 自检三项全过。
- `shell/capability-file.ts` 仅保留 UTF-8 fatal + ignoreBOM、目录排序、重复 identifier 检查和
  错误前缀；领域校验唯一来源为 `host/kernel/api.ts`。捕获 `CapabilityDecodeError` 时只包装 `.detail`，
  文件路径不会重复；`window-config.ts` 的 `unexpectedOf` 同样走公共 api。
- 原 `e8815ad0b` 的入口测试与失败证据保留，不放宽或删除旧断言。
  新回归验证 Target map、Rust `'58'` 消息、单文件前缀、非法 UTF-8/BOM、跨文件 duplicate-id。
  作业 `20261104153516-8de19d`：opener-scope + tauri-config-windows 共 10 passed，exit 0；
  `20261104153516-ab2876`：typecheck exit 0。未重跑无变化的全 Shell/真实 Host。
- 该小单元不关闭 `JSON.parse` 的重复键、数字及 typed-list 原文错误顺序差异；F1/F4 词法接入与
  WebView settings Value 读取仍按 BLOCKERS 保留，不把领域复用当作完整 serde 等价。

## 自查小单元 F2-v2-09（2026-11-04 16:04Z）

- `power.rs:46,51,58,66` 的 INFO/WARN 在 TS 缺失，现由 `index.ts` 的
  `ctx.logger('deep_student_lib::cmd::power')` 传给 `createPowerGuard`；消息、级别、PID 一致。
- `get_prevent_sleep` 发现子进程已退出时清空引用，对齐 Rust `power.rs:85-89`，后续禁用不再误记 disabled。
- `tests/power-entry.test.ts` 走真实 kernel 命令、Cordis exporter 与真实 spawn/wait；
  最终 inhibitor 可执行文件隔离，不会实际影响机器睡眠。四分支加既有 commands 共 9 passed
  （`20261104160417-9f1ca0`），typecheck exit 0（`20261104160417-0118e6`）。
- 首次新测试失败 `20261104160104-86e489` / tsc `fbb921` 是测试误读 Cordis Message.content；
  按正式 Message.type/args 修正采集，并非修改实现绕过断言；不影响任何既有移植测试。

## 架构师最高优先级：窗口枚举（2026-11-04 16:17Z）

- 已发布 `electron/api.ts` 的 `ShellWindowsService`：`ctx.shellWindows.listWindows()`、
  `getMainWindow()`，返回 `{label,isMain,focused}` 快照。由 `dstu.shell` provide，
  main op `window.listWindows` / `window.getMainWindow` → `WindowManager` 当前存活窗口集。
- 不从 Host created/destroyed 事件构建缓存，故插件晚启动仍看到已有 main；`getMainWindow` 仅 main，
  无 main 返回 null。Rust `goal/runtime.rs:435-440` 的 main 优先/否则任意窗口在消费者按同快照选择，
  不引入聚焦优先或固定排序。无数据库写入、无 OS restart/exit 操作。
- 公共使用方法与错误边界：`electron/API.md`。Host 端响应逐字段校验，传输失败直接 reject。
- 作业 `20261104161512-cd95c5`：真实 Electron/main+F2 Host 服务与边界测试 4 passed，exit 0。
  断言晚启动 main、focus 与原生查询一致、main 销毁后 fallback、空集/无 main、坏响应/传输错误。
  `20261104161512-9bbc6f`：typecheck exit 0。
- 初轮 `20261104161130-5a112d`/`88b84c` 失败因编辑 api.ts 时误去掉既有通知/startup 导出，
  已完整恢复，现为纯增量契约；没有删原测试或弱化断言。

## main-red：677f6727c 的 Electron 显示环境（2026-11-04 16:37Z）

- fulltest `677f6727c`/`16:25:29.172Z` 的 5 条堆栈全为 `Missing X server or $DISPLAY`，
  不记为已进入业务断言；原失败 JSON 不动。已上报 `2026-11-04T163133940Z-F2-shell.md`。
- `tests/electron-process.ts` 统一启动真实 Electron：Linux 无 DISPLAY 时用 Xvfb 的
  `-displayfd` 分配独立显示，有 DISPLAY 时复用；返回的仍是 Electron child，退出后清理显示服务。
  仅改 7 个测试的 import/spawn 调用，不修改任何既有 expect/skip/超时/最终 OS hooks。
- `20261104163327-de2317`（env -u DISPLAY，无外层 xvfb）：6 passed，1 failed。
  六个通过项包括本次四个协议 Host 测试和两个新窗口测试；剩余 `shell-real-host` 已越过 X11，
  暴露 F3 `storage/index.ts:120 config.migrationsDir` 未设默认值的真实失败，原 status=[] 断言保留。
- C2 要求的显式 xvfb 队列复验 `20261104163555-5e7dd9`：本次 5 个入口 4 passed/1 failed，
  剩余仍是同一 F3 启动错误；不是整组业务通过。typecheck `20261104163555-aad0f0` exit 0。
- 初轮新 helper 的 stdio 类型交叉导致 tsc `20261104163327-5b8ab1` 失败，已用 Omit 移除原
  stdio 类型后再约束支持的测试选项，无运行时降级。
- 检查到 main 最新已含 F3 `04e6c7ef7`（apply(config = {})），提交本单元后合并再仅复验受影响真实 Host。

### 合并 F3 修复后的闭环证据（2026-11-04 16:40Z）

- `99839395d` 是 `fix(main-red)` 责任提交（测试 helper 主体由检查点 `c50c8accb` 保存，
  类型修正由 `1accfd16c` 保存）。仅测试显示环境自给，不绕业务失败。
- 合并包含 F3 默认配置修复的 main 后，`20261104163928-932c32`：
  `env -u DISPLAY ... shell-real-host.test.ts` 1 passed/exit 0，无 Errors 汇总，原 status=[]、
  两次 restart/零次 exit、PDF/filestream 白名单、purge 拒绝文案全部仍按既有断言通过。
- 因此本次五条环境失败都已有进入真实测试的复验：四条协议 Host 在 `163555-5e7dd9` 通过，
  真实 Host 在合并 F3 后 `163928-932c32` 通过；并非同一轮全量测试通过，仍待协调者 main 集成复验。
- 按 C2 16:35Z 提示，L04 处于 parked，窗口消费后续缺陷/回执转架构师/C2，不再向停放队列送执行消息。

## C2 收尾集成边界核对（2026-11-04 16:54Z）

- 合并 main `fb463060d`，F2 合并点为 `56980fcff`，已包含窗口接口及显示 helper。
  `git diff main HEAD -- electron` 的代码差异仅为 `browser-surface-host.test.ts`
  import `spawnElectron` 与 `await spawnElectron(...)` 两处（原 expect/skip 不动）。
- `99839395d` 和 `fe8a17554` 仍在分支待正常集成；不以窗口 API 已主线推导显示修复全主线。
- 只运行此新组合：`20261104165418-486d72`，无 DISPLAY 的 browser-surface-host 1 passed/exit 0，
  未重跑相同候选的其余已过入口。主线独立复验仍待 C2 正常集成剩余提交后执行。
