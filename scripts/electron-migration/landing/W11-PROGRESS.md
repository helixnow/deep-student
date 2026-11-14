# W11 第七轮：落地工具按 ser-38 实况修订

起点 `assault/integration` `4384a313`（快进）。只在本机改脚本与 RUNBOOK，未连接服务器、未 push。

| 任务 | 做了什么 |
|---|---|
| 1. 属主问题给最小修复命令 | `land-apply` 列出 `.git` 本身、objects/refs/logs/worktrees 下的目录、logs/worktrees 下的文件中不归当前用户的，按属主分组输出 `sudo chown -h -P --from=<owner> dsdev:<group> -- <路径…>`（40 个一行，含控制字符的路径不进命令），不递归、不写清单文件。RUNBOOK 新增一节解释每个选项 |
| 2. land-simulate 不套 heavy | 只有 `--test-filter` 的 land-test 那一步经 `bin/heavy`（`--heavy` / `$LAND_HEAVY` / `--no-heavy`）；RUNBOOK 写明原因 |
| 3. 旁路分支 | landing-map 按分支记账（`entries[].branch`、新增 `branches`），同一个 `$LH` 可多条落地分支；`land-pack --branch` 写进 MANIFEST，`land-apply --branch` 不一致拒绝，`--from auto` 按分支取最后一次。RUNBOOK 新增视觉基线式的配方 |
| 4. `--deps auto` 选 ci | 依赖（lock、.npmrc、patches/、package.json 依赖字段）与主仓库 HEAD 不同 → `npm ci`，装完写指纹 `.land-deps.json`，同指纹复用本工作树或软链兄弟工作树；决定写入 summary.deps。`--npm` 可注入 |
| 5. land-status | 新脚本：刷新 `.landing/landing-map.json`（服务器为准，本机有多余记录不覆盖）、unit 状态（ActiveState/Result/退出码/MemoryPeak，unit 已回收时从日志补）+ 日志尾、tar 经 ssh 拉回报告与回执到 `.reports/server/<id>/`，`--wait` 轮询；land-apply 成功后提示跑 `--map-only` |
| 6. 遗留 | 测试不再在临时目录留下夹具（之前累计 138 个、85 MB，已删）；第六轮那次不明失败：全量 3 次、单例 20 次均未复现 |

验证：
- `landing.test.mjs`：13 个用例 13/13，连续 3 次通过。
- 带 lock 变化的增量模拟 `base → edf15754 → 4384a313 --server-sim --test-filter host/platform/time/tests/time.test.ts`：检出模拟 2/2，服务器模拟 23/23，其中：
  - `--deps auto` 的决定是 ci，原因是 package-lock.json 和 package.json 依赖字段变了；
  - 桩 npm 在测试工作树里被调用一次，装完写了指纹；
  - 重跑时复用已装的依赖，没有再 npm ci。
- 模拟用的包和临时目录已删除。

风险：
- `land-status` 只在假 ssh/systemctl/journalctl 上测过；
- `npm ci` 在服务器上要联网并跑 postinstall（patch-package），未实测；
- 第七轮之前的 `assault/visual-base` 若用了单独的 `--home`，之后要继续用它。

# W11 第六轮：回服务器落地工具包

分支 `assault/W11-orchestrator`，起点为 `assault/integration` `9818178e`（快进），中途快进到 `68d37526`，收尾时合并 `f3c866d7`。只在本机写脚本与文档，未连接服务器。

## 交付

| 文件 | 说明 |
|---|---|
| `land-pack.mjs` | 本机打包：diff --binary → 核对 → 临时索引自证 → zstd → 分片 → 树清单 → MANIFEST / SHA256SUMS |
| `land-send.mjs` | 本机 N 路并行 scp（独立 TCP 连接）、退避重试、远端 sha256sum -c 与重传、`--resume`、`--dry-run` |
| `land-apply.mjs` | 服务器：前置检查、包校验、临时索引干跑与精确树比对、独立工作树里 apply + 提交、landing-map、回滚 |
| `land-test.mjs` | 服务器：version.ts + host 全量 vitest（作业队列 8 分片 / 直接运行），结果写 reports/<本机12>/ |
| `land-simulate.mjs` | 本机：检出模拟 + `--server-sim` 假服务器端到端 |
| `lib.mjs` | 共用（只依赖 Node 内置模块，随包上传） |
| `landing.test.mjs` | `node --test`：7 个用例 |
| `docs/dev/electron-migration/LANDING-RUNBOOK.md` | 每步命令、预期输出、失败处理、增量流程、风险 |

## 关键事实（实测）

- 本机快照源码包 `.transfer/ds-main-ae4efdf9e.tar.zst` = `base-ae4efdf9e` 的树 + `ignored-tracked-files.txt` 的 28 个文件，一个不多一个不少。所以服务器 main = 本机基线 + 28 + 未传输区。
- 这 28 个文件不在本机基线，也不在 INT；INT 里被 .gitignore 匹配但跟踪的只有 `host/platform/zip/tests/__fixtures__/rust-{deflated,stored}.zip` 两个（W08），都在补丁里。
- X7 的 48 个 `fixtures/differential/**` 文件只在 INT（源码包里没有），在补丁里是新增，其中 23 个 `.gz`/`.xz` 为二进制。
- `base..INT` 不触及 example/、src-tauri/resources/、字体、bundle、pdfium 二进制。依赖文件只改了 package.json 的 npm scripts（lock 与 patches 不变），`land-test` 可以软链服务器 node_modules。
- `fulltest.mjs` 不能直接复用：固定测 main、覆盖 `latest.json`（看板 main 指标）、往 lane 分派红灯。`land-test` 复用其作业队列提交方式与 `lib/fulltest-result.mjs` 判定（服务器 main 上存在；加载失败用内置同款）。

## 本机模拟结果（最终工具，INT `f3c866d7`）

真实包在 `.landing/f3c866d7f6d0/`（不提交），之前用旧工具打的 `.landing/68d37526d8d4/` 已删除。

- `land-pack --from base-ae4efdf9e --to f3c866d7`：1404 个文件（新增 864、修改 532、删除 8），二进制 73，被忽略但跟踪 2，[INT] merge 49 个（first-parent 60 个）；补丁 30,610,883 B（29.19 MiB）→ zstd -19 9,934,782 B（9.47 MiB），8 片 × 1,241,848 B；待传 15 个文件共 10.24 MiB。
- 检出模拟：`base-ae4efdf9e` 检出到临时工作树，用分片重拼补丁 → `git apply --index --binary`（2.0 秒）→ `git diff --stat f3c866d7`（排除 src/version.ts）为空，`--cached` 为空，未跟踪文件 0。
- 服务器模拟（假服务器 = 源码包）12/12：inbox `sha256sum -c`、坏分片被拒、`--check-only` 干跑、落地 27.6 秒（含建工作树）、结果树 = 本机树 + 28 个服务器独有文件（缺 0、不同 0）、父提交、提交信息带 from/to、幂等、映射链、main 未动、主工作树干净、`land-test` 冒烟（`host/platform/zip`，16/16，报告目录 5 个小文件）。
- 增量链模拟 `base → 68d37526 → f3c866d7`：检出 2/2、服务器 19/19；增量包 33 个文件，0.19 MiB → 0.04 MiB，1 片，整包 0.81 MiB；乱序包被拒；第二步 0.9 秒，父提交为第一步。更早一次 `base → 912f6ceb → 68d37526`（增量 121 个文件，3 片）同样全过。
- `landing.test.mjs`：首轮全量出现过一次第 1 个用例失败（输出被我的过滤丢掉，未能取证），之后全量 12 次、单例 30 次均 7/7 通过，未复现。

## 过程中修掉的问题

- 入口判断用 `path.resolve(argv[1]) === fileURLToPath(import.meta.url)`：macOS 临时目录 `/var` 是 `/private/var` 的链接，两边不等，脚本**静默什么都不做并以 0 退出**。改为两边都取 realpath（`lib.isEntry`）。服务器上若上传目录经过符号链接也会中招。
- `revParse` 对不存在的 rev 抛异常而不是返回空，`|| fail(...)` 失效。
- 工作树里若已有补丁要新增的被忽略文件，旧回滚会把它当补丁产物删掉；改为应用前直接拒绝。
- dry-run 结尾误报“远端 sha256 全部一致”。
- 模拟清理时假服务器仓库后台 gc 仍在写，`rmSync` 报 ENOTEMPTY；加重试。

## 风险（详见 RUNBOOK 末节）

- 服务器独有路径靠清单 + 规则识别；真实服务器的“服务器独有 N 个路径”会大于 28（含未传输区），模拟只能覆盖 28。
- 服务器 git、systemd、pgrep、sha256sum 的行为未实测（本机是 macOS）；`land-apply` 用到的都是长期稳定的 git 子命令（apply --cached/--index --binary、ls-files -s -z、ls-tree -r -z、worktree add）。
- ssh 登录用户若不是 dsdev，上传目录属主不同；`$LH`、`$LH/inbox` 必须先由 dsdev 建好。
