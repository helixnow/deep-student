# 回服务器落地操作手册（LANDING-RUNBOOK）

> 状态：工具已在本机实测（打包、检出模拟、假服务器端到端模拟、`land-test` 冒烟）。主 agent 已在 ser-38 上用过两次：首次落地本机 `edf15754` → 服务器 `assault/landing` `007c1af5`；视觉基线 `560d7169` → `assault/visual-base`（`--branch`/`--worktree`）。W11 不 SSH，以下服务器步骤由主 agent 执行。
> 约定：`REPO=/home/dsdev/dev/deep-student`；`LH=/home/dsdev/dev/landing`（落地状态目录）；`AS_DSDEV="sudo -u dsdev env HOME=/home/dsdev PATH=/opt/node26/bin:/usr/local/bin:/usr/bin:/bin"`；
> 仓库里的命令一律以 dsdev 执行（以 root 跑 git 会制造 root 属主文件）。本机命令在 `wt/INT`（或任一含 `scripts/electron-migration/landing/` 的工作树）里执行，`L=scripts/electron-migration/landing`。

## 为什么是补丁而不是 bundle

本机基线 `base-ae4efdf9e`（提交 `21c9d80`）是服务器 main `ae4efdf9e` 的**快照提交**，服务器上没有这个对象，git bundle 接不上，只能传 `git diff --binary` 补丁。

服务器 main 的树 = 本机基线 + 28 个“被 .gitignore 忽略但被跟踪”的文件（`.transfer/ignored-tracked-files.txt`）+ 快照没带过来的区域（`example/`、`src-tauri/resources/`、字体、历史 bundle、pdfium 二进制）。本机快照源码包 `.transfer/ds-main-ae4efdf9e.tar.zst` 实测正好是“本机基线 + 那 28 个文件”。补丁不能碰这些服务器独有的路径：`land-pack` 会拒绝，`land-apply` 在应用前后核对它们原样不变。

## 布局

| 位置 | 内容 |
|---|---|
| 本机 `.landing/<to 前 12 位>/` | 落地包：`land.patch`（不传）、`land.patch.zst.000…`、`from.tree.zst`、`to.tree.zst`、`MANIFEST.json`、`SHA256SUMS`、`land-apply.mjs`、`land-test.mjs`、`lib.mjs`、`send-*.json`（传输记录） |
| 本机 `.landing/landing-map.json` | `land-status` 从服务器拉回的映射副本（旧的留 `.bak`），`land-pack --from auto` 读它。不要手工维护 |
| 本机 `.reports/server/<本机 12 位>/` | `land-status` 拉回的服务器测试结果 + `apply.json`（落地回执）+ `status.json`（unit 状态与日志尾） |
| 服务器 `$LH/inbox/<to12>/` | 上传目录；`land-apply` / `land-test` 就从这里运行（首次落地前仓库里还没有这些脚本） |
| 服务器 `/home/dsdev/dev/ds-landing` | `assault/landing` 分支的独立工作树。主工作树 `$REPO` 永远停在 main（服务进程从主工作树加载脚本，不能切分支） |
| 服务器 `$LH/landing-map.json` | 本机 SHA ↔ 服务器 SHA；`entries` 按落地顺序（每条带 `branch`），`branches` 记每条落地分支的起点与最后一次落地，`byLocal` / `byServer` 两向索引。同一个 `$LH` 可以有多条落地分支，各自接续 |
| 服务器 `$LH/applied/<to12>/` | 每次落地的 `MANIFEST.json` 与 `apply.json`（含服务器独有路径清单） |
| 服务器 `$LH/reports/<本机12>/` | `land-test` 的小结果（本机 `land-status <本机12>` 拉回）；分片原件在 `$LH/test-raw/`，测试工作树在 `$LH/test-worktrees/` |

## 工具

| 脚本 | 在哪跑 | 作用 |
|---|---|---|
| `land-pack.mjs` | 本机 | `git diff --binary --full-index --no-renames base..to`（排除 `src/version.ts`）→ 核对（补丁路径 = `git diff` 路径、每个二进制文件都有 `GIT binary patch`、被忽略但跟踪的文件在补丁里、不碰服务器独有路径与未传输区）→ **临时索引自证** from 树 + 补丁 = to 树 → zstd -19 → 分片 → 树清单 → `MANIFEST.json` / `SHA256SUMS` |
| `land-simulate.mjs` | 本机 | 检出模拟（`git apply --index --binary` 后 `git diff --stat <to>` 为空）；`--server-sim` 用快照源码包建假服务器仓库，用包里的 `land-apply.mjs` 端到端落地 |
| `land-send.mjs` | 本机 | N 路并行 scp（每个文件独立 TCP 连接）、按文件退避重试、远端 `sha256sum -c`、不一致的重传；`--resume` 续传 |
| `land-apply.mjs` | 服务器 | 前置检查 → 包校验 → 干跑（临时索引，精确比对树）→ `git apply --index --binary` → 提交 → `landing-map.json` → `SERVER_SHA=`；失败回滚；永不改 main |
| `land-test.mjs` | 服务器 | 生成 `src/version.ts`（`DEEP_STUDENT_BUILD_NUMBER`），按依赖是否变化软链或 `npm ci`，host 全量 vitest 8 分片经作业队列（ds-fulltest 同款），结果写 `$LH/reports/<本机12>/` |
| `land-status.mjs` | 本机（ssh 只读） | 刷新 `.landing/landing-map.json`；查 unit 的 ActiveState / Result / 退出码 / MemoryPeak 和日志尾；把报告目录与落地回执拉回 `.reports/server/<id>/` |

每个脚本 `--help` 打印完整选项。工具自身的回归：`node --test scripts/electron-migration/landing/landing.test.mjs`（小仓库上覆盖打包、首次/增量/幂等落地、旁路分支、属主检查的修复命令、各种拒绝、两种回滚、带故障注入的并行传输、依赖决定、`land-status` 的各种 unit 状态与映射合并；用假的 ssh/systemctl/journalctl，不连服务器）。

## 第 0 步：一次性准备（服务器，root）

```bash
sudo -u dsdev mkdir -p /home/dsdev/dev/landing/inbox
/opt/node26/bin/node -e 'require("zlib").zstdDecompressSync; console.log(process.version)'   # 需要 ≥ 22.15（node:zlib 带 zstd），服务器上不需要 zstd 命令
command -v sha256sum git
```

`land-send` 用 `ssh ser-38` 的登录用户建 `$LH/inbox/<to12>/` 并写文件。若该用户不是 dsdev，上传目录归它所有，dsdev 只需能读（默认 umask 022 即可）；`land-apply` 只读上传目录，写的都在 `$LH/work/`、`$LH/applied/` 等 dsdev 自己的目录。**父目录 `$LH`、`$LH/inbox` 必须先由 dsdev 建好**，否则会被 root 建成 root 属主，dsdev 之后建不了 `work/`。

## 第 1 步：打包（本机）

```bash
cd /Users/heli/der/tmp-58068a80b38aa6d0/wt/INT
test -f "$(git rev-parse --git-dir)/MERGE_HEAD" && echo "INT 合并进行中：只会打包已提交的 HEAD"
node $L/land-pack.mjs --from base-ae4efdf9e --to assault/integration        # 首次
node $L/land-pack.mjs --from auto --to assault/integration                  # 之后（见“增量落地”）
```

预期（2026-11-07 以 INT `f3c866d7` 实测，约 10 秒）：

```
核对通过：1404 个文件（二进制 73，被忽略但跟踪 2），临时索引自证 from + 补丁 = to
补丁 29.19 MiB → zstd -19 9.47 MiB，8 片 × ≤1.18 MiB；待传 15 个文件（含 SHA256SUMS）
包含 [INT] merge 49 个（first-parent 提交 60 个）
```

| 报错 | 含义与处理 |
|---|---|
| `补丁路径与 git diff 不一致` / `二进制补丁不完整` / `自证失败` | 补丁生成有问题（git 配置或 bug），**不要传**；保留 `.landing/<to12>/` 报给 W11 |
| `补丁触及服务器上“被忽略但跟踪”的文件` | 本机改了服务器独有的 28 个文件之一。补丁是相对本机基线（没有这个文件）生成的，在服务器上会冲突；需要单独决定（通常从本机分支撤掉该改动） |
| `补丁触及快照未传输的区域` | 服务器上那里可能已有文件。先在服务器 `$AS_DSDEV git -C $REPO ls-tree -r --name-only main -- <路径>` 确认没有同名文件，再加 `--allow-zone`；真有冲突 `land-apply` 也会在干跑阶段拒绝 |
| `… 不是 … 的祖先` | INT 历史被改写（reset/rebase）。补丁仍是两棵树的差异，加 `--allow-non-ancestor` 可以打包；`land-apply` 按树精确核对，安全性不变 |
| `… 已存在（加 --force 重建）` | 同一个 to 已经打过包（目录按 to 命名）。换了 from 重打要加 `--force` |

## 第 2 步：本机模拟（本机）

```bash
node $L/land-simulate.mjs --pack ../../.landing/<to12>                  # 每次必做，约 10 秒
node $L/land-simulate.mjs --pack ../../.landing/<上一包> --pack ../../.landing/<to12> --server-sim \
  --test-filter host/platform/time/tests/time.test.ts                   # 首次落地、工具改过、或依赖变了时；约 2 分钟、临时占 ~1.3 GB
```

**不要再在外面套 `bin/heavy`。** 检出模拟、拼分片、`git apply`、树比对都是几秒到几十秒的 git I/O，CPU 占用低；套上 heavy 会排在别的代理的全量 tsc/vitest 后面（第七轮实测排队超过 6 分钟），而它本身只占一个核几秒。真正吃 CPU/内存的只有 `--test-filter` 触发的 `land-test`（vitest），`land-simulate` 只把这一步经 `bin/heavy` 排队（自动找 `<工作区>/bin/heavy`，或 `--heavy <path>` / `$LAND_HEAVY`；`--no-heavy` 不排队）。

`--server-sim` 带 `--test-filter` 时默认 `--deps auto`，并核对 `land-test` 的依赖决定：最后一个包的 to 与假服务器 main 的依赖（`package-lock.json`、`.npmrc`、`patches/`、package.json 依赖字段）不同 → 必须选 `ci`，相同 → 必须选 `link`。模拟里 npm 是桩：它把主仓库 `node_modules` 的顶层条目逐个软链进测试工作树里的一个实体 `node_modules` 目录，不联网、不写共享的 `node_modules`；验证 `npm ci` 在测试工作树里只调用一次、装完写指纹、同一提交重跑复用（不再 `npm ci`）。要跑真的 `npm ci` 加 `--real-npm`（联网、几 GB，慎用）。

预期（2026-11-07 第七轮，`base → edf15754 → 4384a313` 增量链，第二包改了 package.json 与 lock，约 2 分 10 秒）：

```
[检出模拟] 21c9d8086fe6 → edf15754c540：git apply --index --binary 1128ms；git diff --stat edf15754c 为空，--cached 为空，未跟踪文件 0 个
[检出模拟] edf15754c540 → 4384a3136d12：git apply --index --binary 217ms；git diff --stat 4384a3136 为空，--cached 为空，未跟踪文件 0 个
[服务器模拟] 假服务器 main …：与本机基线 一致，多出 28 个路径（正是被忽略但跟踪的清单）
…
[服务器模拟] land-test（经 …/bin/heavy 排队）：--deps auto，npm 用桩
[服务器模拟] ✓ land-test 冒烟（host/platform/time/tests/time.test.ts）：用例 17，失败 0，54s；…
[服务器模拟] ✓ --deps auto 的决定是 ci：ci：依赖与主仓库 HEAD 不同：package-lock.json、package.json（依赖字段） → npm ci
[服务器模拟] ✓ npm ci 在测试工作树里调用一次，装完写指纹：…/test-worktrees/00478636cea6|ci --no-audit --no-fund
[服务器模拟] ✓ 同一提交重跑复用已装的 node_modules（不再 npm ci）：…
模拟全部通过：检出模拟 2/2，服务器模拟 23/23
```

（单包时 12 项起：inbox sha256sum -c、坏分片被拒、--check-only、落地、结果树、父提交、提交信息、幂等、映射链、main 未动、主工作树干净、land-test 冒烟，再加依赖决定的 1–3 项。）有任何 `✗` 或 `非空` 都不要传。临时目录在结束时自动删除（`--keep` 才保留，用完手动删）。

## 第 3 步：传输（本机）

```bash
node $L/land-send.mjs --pack ../../.landing/<to12> --host ser-38 --dry-run     # 先看命令
node $L/land-send.mjs --pack ../../.landing/<to12> --host ser-38               # 8 路并行，传完远端 sha256sum -c
```

首包 10.24 MiB（8 片各 1.18 MiB + 两份树清单约 0.7 MiB + 工具与清单）：8 路 × 约 13 KB/s ≈ 100 KB/s，约 2 分钟（加每个连接的握手）。每个 scp 都是独立 TCP 连接（`ControlMaster=no`，否则复用一条连接就失去并行的意义）。预期结尾：

```
✓ land.patch.zst.003 1210.0 KiB，95s，12.7 KiB/s
…
完成：10466.8 KiB，…s，合计 …/s，远端 sha256 全部一致
服务器下一步（dsdev）：/opt/node26/bin/node /home/dsdev/dev/landing/inbox/<to12>/land-apply.mjs --pack … --check-only，通过后去掉 --check-only
```

| 情况 | 处理 |
|---|---|
| 个别文件重试后仍失败 | 稍后 `--resume`（先传 SHA256SUMS、远端校验，只传不一致或缺失的） |
| `远端 sha256 校验未通过` | 已自动重传两轮仍不一致；`ssh ser-38 'cd $LH/inbox/<to12> && sha256sum -c SHA256SUMS'` 看是哪个，`--only <文件>` 补传 |
| `Permission denied (publickey)` 之类 | `BatchMode=yes` 不会交互要密码；检查本机 ssh 配置/agent |
| 只想传、由主 agent 自己校验 | `--no-verify`，然后执行它打印的 `sha256sum -c` 命令 |

## 第 4 步：落地前置条件（服务器，root）

`land-apply` 会逐项检查，不满足就拒绝；先手工看一遍：

```bash
systemctl is-active ds-migration ds-opencode                    # 都应为 inactive 或 failed
pgrep -af 'oc-dispatch\.mjs watch|opencode serve'                # 应无输出
ls -l $REPO/.oc-runs/dispatch.paused.json $REPO/.oc-runs/maintenance.json /home/dsdev/ops-night/maintenance /home/dsdev/ops-night/hold/ds-migration 2>/dev/null   # 至少一个
stat -c '%y' $REPO/.oc-runs/scheduler-heartbeat.json             # 应超过 10 分钟前
systemctl stop ds-backup.timer; systemctl is-active ds-backup.service   # 旧 ds-backup 以 root 在仓库里跑 git；应 inactive
```

都没有暂停标记时写一个 hold（与 ops README 的约定一致；用了 `DS_HOLD_DIR` 则写到 `/etc/ds-ops/hold/`）：

```bash
sudo -u dsdev sh -c 'echo "回服务器落地 by 主agent" > /home/dsdev/ops-night/hold/ds-migration'
```

## 第 5 步：应用（服务器，dsdev）

```bash
IN=/home/dsdev/dev/landing/inbox/<to12>
$AS_DSDEV node $IN/land-apply.mjs --pack $IN --check-only      # 不改任何东西
$AS_DSDEV node $IN/land-apply.mjs --pack $IN
```

预期（首次约 15 秒，主要是建工作树；增量约 2 秒）：

```
[检查] 调度已暂停（hold/ds-migration），ds-migration / ds-opencode 未运行
[检查] 包完整：8 片，补丁 30610883 字节，本机 21c9d8086fe6 → f3c866d7f6d0
[检查] 干跑通过：起点 ae4efdf9e… 在本机 from 树 11890 个路径上一致，应用后与本机 to 树 12746 个路径一致；服务器独有 N 个路径不变
建落地分支 assault/landing（起点 ae4efdf9e…），工作树 /home/dsdev/dev/ds-landing
落地完成：本机 f3c866d7f6d0 → 服务器 <sha>（assault/landing），main 仍为 ae4efdf9e…
LOCAL_SHA=f3c866d7f6d0b64ba9d28a0723da4911db4cb82e
SERVER_SHA=<40 位>
```

“服务器独有 N 个路径”在真实服务器上 = 28 + 未传输区的文件数（模拟里只有 28，因为源码包里没有未传输区）。main 若已不是 `ae4efdf9e` 只打印注意，落地分支仍从 `ae4efdf9e` 建。

落地后在本机刷新映射（`--from auto` 用；`land-apply` 结束时也会打印这一行）：

```bash
node $L/land-status.mjs --map-only          # 拉 $LH/landing-map.json → .landing/landing-map.json（旧的留 .bak）
```

本机映射里有服务器没有的记录（例如手工加过、或另一个 `--home` 的落地）时不会覆盖：服务器那份另存为 `.landing/landing-map.ser-38.json`，退出码 2，核对后手工替换。

| 报错（退出码 1，已回滚或未改动） | 处理 |
|---|---|
| `前置检查未通过：…` | 按第 4 步处理后重跑 |
| `分片校验失败：…` | 本机 `land-send … --only <分片>` 或 `--resume` |
| `起点 … 与本机 from 树不一致` | 服务器起点不是本机认为的那个状态（快照不精确，或有人动过 landing 分支）。**不要绕过**；列出的路径报给 W11 |
| `补丁新增的路径在服务器上已存在（本机基线没有）` | 服务器独有文件与本机新增撞名；逐个决定，通常改本机 |
| `这个包的 from 是本机 X，但最后一次落地的是本机 Y` | 本机用 `land-pack --from Y`（或拉回 landing-map 后 `--from auto`）重新打包 |
| `assault/landing 现在是 …，不是最后一次落地记录的 …` | landing 分支上有未经 land-apply 的提交，先查清，**不要自动 reset** |
| `首次落地的包必须从 base-ae4efdf9e 开始` | 分支还不存在却来了增量包：先落首包 |
| `落地工作树 … 不干净` / `已有补丁要新增的文件` | `$AS_DSDEV git -C /home/dsdev/dev/ds-landing status --ignored`，移走杂物后重跑 |
| `… 里有 N 个路径不归 dsdev` | 输出里已列出这些路径和只针对它们的 `chown` 命令；以 root 照抄执行后重跑 `--check-only`。见下一节 |
| `这个包是为 X 打的（land-pack --branch）` | 包里记的目标分支与这里的 `--branch` 不符；用对的 `--branch`，或本机按目标分支重新打包 |
| `X 已存在但 … 没有它的落地记录` | 分支不是本工具建的，或首次落地用了别的 `--home`；后续增量必须用同一个 `--home` |
| `必须以 dsdev 运行` / `不要以 root 运行` | 用 `$AS_DSDEV` |
| `本机 … 已落地为服务器 …，不重复应用`（退出码 0） | 幂等：同一个包重跑只打印已有的 `SERVER_SHA` |

**退出码 2（回滚本身失败）**：`landing-map.json` 只在全部成功后才写，所以以它为准恢复：

```bash
# 首次落地失败：删掉本次建的分支与工作树
$AS_DSDEV git -C $REPO worktree remove --force /home/dsdev/dev/ds-landing
$AS_DSDEV git -C $REPO branch -D assault/landing
$AS_DSDEV git -C $REPO worktree prune
# 增量落地失败：回到 landing-map.json 最后一条的 serverSha
$AS_DSDEV git -C /home/dsdev/dev/ds-landing reset --hard <最后一条 serverSha>
$AS_DSDEV git -C /home/dsdev/dev/ds-landing status --ignored    # 清掉补丁新增、仍残留的文件
```

### `.git` 里有不归 dsdev 的路径（`--check-only` 拒绝）

第七轮实况：`.git/refs/heads/ops` 和 `.git/logs/refs/heads/ops` 被 root 建成了 root 属主（以 root 跑过 git 的进程留下的，例如旧版 ds-backup），dsdev 建不了 `ops/` 下的引用和 reflog。`land-apply` 在第 1 步检查这些位置：

- `.git` 目录本身；
- `objects/`、`refs/`、`logs/`、`worktrees/` 下的所有目录（建对象、建引用要目录写权限）；
- `logs/`、`worktrees/` 下的普通文件（reflog 是原地追加，worktree 的 index 原地改写）。

有不归当前用户的，就拒绝并给出**只针对这些路径**的命令，例如：

```
land-apply 失败：/home/dsdev/dev/deep-student/.git 里有 2 个路径不归 dsdev（属主 root；建对象、改引用、追加 reflog 会失败）：
    目录 /home/dsdev/dev/deep-student/.git/refs/heads/ops
    目录 /home/dsdev/dev/deep-student/.git/logs/refs/heads/ops
  以 root 执行（只改上面这些路径本身：不递归，-h 不跟随符号链接，--from 只改属主仍是 root 的）：
    sudo chown -h -P --from=root dsdev:dsdev -- '/home/dsdev/dev/deep-student/.git/refs/heads/ops' '/home/dsdev/dev/deep-student/.git/logs/refs/heads/ops'
  修完重跑 --check-only。不要对整个 .git 或仓库 chown -R。
```

照抄执行，再跑一次 `--check-only`。命令里每个选项的用意：

| 选项 | 为什么 |
|---|---|
| 只列出的路径，不加 `-R` | 检查时已经逐个列出了所有不对的目录和文件。递归会顺带改到检查之后才放进去的东西；整树 `chown -R` 会把 root 有意持有的文件也改掉 |
| `-h` | 以 root 执行，而路径在 dsdev 可写的目录里。dsdev 的进程可以在检查和修复之间把某个目录换成指向 `/etc/…` 的符号链接；不加 `-h` 时 chown 会跟过去改目标。加了 `-h` 改的是链接本身 |
| `--from=root` | 只改属主**仍是** root 的。与 `-h` 合起来：被换成的链接归 dsdev，不匹配，什么都不改。别的 uid（例如 1001）按 `--from=1001` 单独成一行 |
| `-P` | 不递归时没有作用，保留是为了和 ops 约定的写法一致；即使有人手工加上 `-R`，也不跟随遍历中遇到的链接 |

- **目录里 root 属主的引用文件不用改**：git 改引用是写 `<ref>.lock` 再 rename，只要目录可写就行；所以 `refs/` 下只查目录。
- **路径多时**：比如 root 跑过 `git gc` 留下几百个 `objects/xx`，命令按 40 个路径一行拆开，逐行执行即可。
- **刻意不写清单文件**：清单若写在 dsdev 可写的位置，root 执行前可能被改。
- **路径名含控制字符的**：不进命令，单独列出，人工核对。

## 第 6 步：服务器测试（服务器）

时间长，用 `systemd-run` 放到 dsdev.slice 里跑，断开 ssh 不受影响（root 执行）：

```bash
systemd-run --unit=ds-land-test-<to12> --uid=dsdev --gid=dsdev --slice=dsdev.slice \
  -p WorkingDirectory=/home/dsdev -E HOME=/home/dsdev -E PATH=/opt/node26/bin:/home/dsdev/.local/bin:/usr/local/bin:/usr/bin:/bin \
  /opt/node26/bin/node $IN/land-test.mjs --sha <SERVER_SHA>
journalctl -u ds-land-test-<to12> -f
```

unit 名固定用 `ds-land-test-<本机 to12>`：本机 `land-status <to12>` 靠它找 unit，报告目录也是同一个 id。本机查进度和结果（只读 ssh，三次连接）：

```bash
node $L/land-status.mjs <to12>            # 状态 + 日志最后 40 行 + 拉回报告；退出码 0 成功、1 失败或有失败用例、2 ssh/参数错误、3 还在跑
node $L/land-status.mjs <to12> --wait     # 还在跑就每 60 秒查一次，结束后拉报告
```

预期输出：

```
映射：…/.landing/landing-map.json 无变化，共 N 条；assault/landing 最后 本机 … → 服务器 …
落地：本机 4384a3136d12 → 服务器 …（assault/landing，…，… 个文件）
unit ds-land-test-4384a3136d12.service：failed (failed)，Result=exit-code，退出码 1，MemoryPeak 2.00 GiB，CPU 754s，开始 …，结束 …（来源 systemctl）
—— journalctl -u ds-land-test-4384a3136d12.service 最后 40 行 ——
…
报告：…/.reports/server/4384a3136d12/（apply.json failures.txt land-test.log summary.json version.ts vitest-host.json.zst）；有失败，host 用例 …、失败 …、失败套件 …，依赖 ci
```

- **unit 已被回收**：`systemd-run` 的 unit 成功结束后会被回收，显示“已回收（not-found）”。这时结果和 MemoryPeak 从日志尾部的 `Deactivated successfully` / `Failed with result '…'` / `Consumed … CPU time, … memory peak` 补出（来源 `journal`）；失败的 unit 会留着，直到 `systemctl reset-failed`。
- **ssh 用户读不到日志**：不在 systemd-journal 组时，日志尾是一行提示。这时看拉回的 `land-test.log`，退出码按 `summary.json` 判定。
- **不是 `ds-land-test-*` 的 unit**：`land-status ds-fulltest.service` 只查状态和日志，不拉报告。

没有 root 时：`$AS_DSDEV nohup node $IN/land-test.mjs --sha <SERVER_SHA> > $LH/land-test-<to12>.out 2>&1 &`。

- **执行方式**：`ds-jobs` 在跑就走作业队列（与 ds-fulltest 同款：8 片，每片 `VITEST_MAX_FORKS=2`，受 test 类并发上限约束，单作业 30 分钟上限）；否则直接运行，`--parallel 2`。ds-fulltest 同时在跑会争用队列，日志会提示。
- **与 fulltest.mjs 的区别**：测指定提交而不是 main；不写 `.oc-runs/fulltest/latest.json`（看板的 main 指标）；不往 lane 分派红灯。
- **版本文件**：默认 `DEEP_STUDENT_BUILD_NUMBER=20000`（与本机测试一致，便于对比），同时传给版本生成和每个 vitest 分片；`--build-number auto` 改为由服务器 git 历史计算。
- **依赖（`--deps auto`，默认）**：比较 `package-lock.json`、`.npmrc`、`patches/` 和 package.json 的依赖字段（`dependencies`、`devDependencies`、`optionalDependencies`、`peerDependencies`、`overrides`；只改 npm scripts 不算）与主仓库 HEAD 是否相同。
  - 都相同：软链 `$REPO/node_modules`。
  - 有任何不同：在测试工作树里 `npm ci`，上限 40 分钟，日志在 `$LH/test-raw/<id>/<run>/npm-ci.log`。装完在 `node_modules/.land-deps.json` 写依赖指纹。同一提交重跑时复用；别的测试工作树里有同一指纹的，直接软链过去，不再装。
  - 软链主仓库前，会先拆掉指向主仓库 `node_modules` 的旧软链：`npm ci` 会清空 `node_modules`，经软链清的就是主仓库那份。
  - 决定和原因写进 `summary.json` 的 `deps`（`action`：`link` / `ci` / `reuse` / `link-sibling`；`changed`：哪些变了），`land-status` 会显示。
  - 下一次 `4384a313` 的增量改了 package.json 与 lock，auto 会自动选 `ci`（本机模拟已验证），也可以显式写 `--deps ci`。
  - `--deps link` 是强行复用（依赖不同时日志里会写明）。
  - 每个 `ci` 过的测试工作树都带一份完整的 `node_modules`（几 GB），确认不再需要时加 `--remove-worktree` 或手工 `git worktree remove`。
- **前端套件**：`--suite fe` 或 `--suite all`。软链 `node_modules` 曾让 `katexSandboxCssData.test.ts` 触发 Vite `fs.allow` 失败（ORCHESTRATION-LOG 05:20 条）；INT `f3c866d7` 起 `vitest.config.ts` 放行 node_modules 的真实路径，更早的提交仍会失败。

预期结尾与退出码（0 全绿；1 有失败用例或套件；2 分片缺失、源码漂移或环境错误）：

```
host：用例 …，通过 …，失败 …，pending …，失败套件 …；完整 true，稳定 true
完成：全绿|有失败|不完整；本机拉回：node scripts/electron-migration/landing/land-status.mjs <本机12>
```

报告目录只有小文件：`summary.json`（计数、判定、失败文件与用例清单、环境）、`failures.txt`、`version.ts`、`vitest-host.json.zst`（合并后的完整 JSON，约 0.5 MiB）、`land-test.log`。

## 第 7 步：拉回结果（本机）

`land-status <to12>` 已经把报告拉回 `.reports/server/<to12>/`（整体替换：服务器上没有的旧文件不会残留）。之后的比对：

```bash
cd /Users/heli/der/tmp-58068a80b38aa6d0
node -e 'const s=require("./.reports/server/<本机12>/summary.json");console.log(s.ok,s.suites.host.numTotalTests,s.suites.host.numFailedTests,s.suites.host.numFailedTestSuites)'
zstd -dc .reports/server/<本机12>/vitest-host.json.zst > /tmp/server-host.json
# 与本机同一提交的报告比对失败文件
node -e '
const f=(p)=>new Set(require(p).testResults.filter(t=>t.status==="failed").map(t=>t.name.replace(/^.*?\/(host|electron|scripts)\//,"$1/")));
const a=f(process.argv[1]),b=f(process.argv[2]);
console.log("只在服务器失败:",[...b].filter(x=>!a.has(x)));console.log("只在本机失败:",[...a].filter(x=>!b.has(x)));
' ./.reports/int-<本机短sha>-host.json /tmp/server-host.json
```

## 增量落地（每 60～90 分钟一个新 INT 版本）

只传与上一次**成功落地**的本机提交之间的差异（以服务器 `landing-map.json` 为准，不是上一次打的包）：

```bash
# 本机
node $L/land-status.mjs --map-only                                   # 映射以服务器为准
node $L/land-pack.mjs --from auto --to assault/integration           # from = assault/landing 最后一次落地的本机提交
node $L/land-simulate.mjs --pack ../../.landing/<新 to12>             # 不套 heavy
node $L/land-send.mjs --pack ../../.landing/<新 to12> --host ser-38
# 服务器
IN=/home/dsdev/dev/landing/inbox/<新 to12>
$AS_DSDEV node $IN/land-apply.mjs --pack $IN --check-only && $AS_DSDEV node $IN/land-apply.mjs --pack $IN
# 本机
node $L/land-status.mjs --map-only
# 之后第 6、7 步照旧（依赖变了 --deps auto 自动 npm ci）
```

下一次（INT `4384a313`，W06 改了 package.json 与 lock）具体是：

```bash
node $L/land-status.mjs --map-only
node $L/land-pack.mjs --from auto --to 4384a313                       # 应打印 --from auto → edf15754…
node $L/land-simulate.mjs --pack ../../.landing/4384a3136d12
node $L/land-send.mjs --pack ../../.landing/4384a3136d12 --host ser-38
# 服务器：IN=/home/dsdev/dev/landing/inbox/4384a3136d12，第 5 步 check-only → apply，然后
systemctl reset-failed ds-land-test-4384a3136d12 2>/dev/null   # 同名 unit 失败过才需要
systemd-run --unit=ds-land-test-4384a3136d12 … /opt/node26/bin/node $IN/land-test.mjs --sha <SERVER_SHA> --deps auto
# 本机
node $L/land-status.mjs 4384a3136d12 --wait
```

`systemd-run` 同名 unit 失败后还留着（`failed`），重跑前要 `systemctl reset-failed <unit>`，否则报 `Unit … already exists`。

实测规模（本机模拟）：`912f6ceb → 68d37526`（三个合并 + 收尾修复，121 个文件）补丁 2.90 MiB → 0.14 MiB，3 片；`68d37526 → f3c866d7`（一个合并，33 个文件）补丁 0.19 MiB → 0.04 MiB，1 片，假服务器上应用 0.9 秒。每个包另带两份树清单（每份约 0.35 MiB，固定开销），所以一次增量传输约 0.8–0.9 MiB，8 路约 10 秒。服务器上新提交的父提交是上一次落地的服务器提交，landing 分支保持线性。

- 两次落地之间 INT 被 reset/rebase：`land-pack` 提示不是祖先，加 `--allow-non-ancestor`（仍以上一次落地的本机提交为 from）。
- 某个包没落成功：下一包仍从最后一次成功落地的本机提交打（`--from auto` 自动如此）。
- 同一个 to 换 from 重打：加 `--force`。

## 旁路分支：把非 INT 的提交落到单独的分支（例如视觉基线）

用途：把某个不在 INT 主线上的本机提交（例如改动前的视觉基线 `560d7169`）放到服务器上一条独立的分支，供对照测试。

- **互不影响**：它和 `assault/landing` 共用同一个 `$LH`、同一份 `landing-map.json`，但按分支各自记账——各自的“首次落地”和“最后一次落地”互不影响。
- **永不改 main**：与主线一样。

```bash
# 本机：首次从快照基线打，包里记下目标分支
node $L/land-pack.mjs --from base-ae4efdf9e --to 560d7169 --branch assault/visual-base     # 本机已有 .landing/560d71697e3a 时加 --force
node $L/land-simulate.mjs --pack ../../.landing/560d71697e3a
node $L/land-send.mjs --pack ../../.landing/560d71697e3a --host ser-38
# 服务器：--branch 与 --worktree 都要给（默认工作树 ds-landing 是主线的）
IN=/home/dsdev/dev/landing/inbox/560d71697e3a
$AS_DSDEV node $IN/land-apply.mjs --pack $IN --branch assault/visual-base --worktree /home/dsdev/dev/ds-visual-base --check-only
$AS_DSDEV node $IN/land-apply.mjs --pack $IN --branch assault/visual-base --worktree /home/dsdev/dev/ds-visual-base
# 测试：报告目录按本机 to12 命名，和主线不会撞；unit 名照样用 ds-land-test-<to12>
systemd-run --unit=ds-land-test-560d71697e3a … /opt/node26/bin/node $IN/land-test.mjs --sha assault/visual-base
# 本机
node $L/land-status.mjs 560d71697e3a --wait
```

- **之后在旁路分支上增量**：`land-pack --from auto --to <新提交> --branch assault/visual-base`（from 取这条分支最后一次落地），服务器同样带 `--branch` / `--worktree`。
- **`--branch` 写进 MANIFEST**：服务器上 `--branch` 不一致会拒绝，防止把旁路包落到主线上（反之亦然）。
- **测非落地提交**：只想测某个服务器提交而不落地时，`land-test --sha <rev> --label <名字>`。
- **第七轮之前用旧工具落的 `assault/visual-base`**：旧工具在同一个 `$LH` 里不允许第二条分支，所以那次多半用了单独的 `--home`。之后在它上面的增量要继续用**同一个** `--home`（本机 `land-status --home <那个目录> --map-only --map ../../.landing/landing-map.visual-base.json`）。不确定时 `ls -d /home/dsdev/dev/*/applied/560d71697e3a` 找回执所在目录。
  - 若那次用的就是默认 `$LH`、靠手工改过 `landing-map.json`：映射里 `assault/visual-base` 的记录有没有 `branch` 字段都行（没有时按顶层 `branch` 归属）。但若它被记成了 `assault/landing`，要手工改成 `"branch": "assault/visual-base"`，否则主线的“最后一次落地”会算错。

## 合入 main（不在本工具范围）

`land-apply` 永不改 main。测试通过后是否合入、何时合入由主 agent 按编排计划决定。main 仍是 `ae4efdf9e` 时 `assault/landing` 是它的后代，可以快进：

```bash
$AS_DSDEV git -C $REPO merge --ff-only assault/landing    # 会更新主工作树文件，服务进程从这里加载脚本，按部署流程在维护窗口内做
```

之后的增量照旧落在 `assault/landing` 上，再次快进 main。

## 风险与限制

- **服务器独有路径靠清单和规则识别**：28 个文件来自 `.transfer/ignored-tracked-files.txt`；未传输区按路径规则（`example/`、`src-tauri/resources/`、字体扩展名、`*.bundle`/`bundles/`、pdfium 动态库）判断。规则漏掉的服务器独有文件不会被补丁误删（补丁只含本机两棵树之间的差异），但若本机新增同名文件，`land-apply` 干跑阶段会以“新增路径已存在”拒绝。
- **`src/version.ts` 不在补丁里**：它在本机和服务器都不被跟踪，由 `land-test`（或 `npm run version:generate`）生成。
- **树清单是固定开销**：每个包带完整的 from/to 树清单（各约 0.35 MiB），换来服务器端对每个路径的精确比对。
- **服务器 main 已移动**：落地分支仍从 `ae4efdf9e` 建，合入 main 需要真正的合并而非快进。
- **作业队列**：`land-test` 依赖 ds-jobs 时受其 30 分钟单作业上限；分片超时会判为不完整（退出码 2），可加 `--shards 12` 重跑。
- **上传用户**：若 ssh 登录用户不是 dsdev，上传目录归该用户所有；`land-apply` 只读它，不受影响，但清理时需要相应权限。
- **`land-status` 只在本机用假的 ssh/systemctl/journalctl 测过**：真实服务器上 `systemctl show -p MemoryPeak` 需要较新的 systemd（老版本显示 `[not set]`，此时从日志的 `memory peak` 补）；ssh 用户需能读日志（systemd-journal 组）才有日志尾。
- **`npm ci` 走网络与 postinstall**：服务器上首次 `ci` 要下载依赖并跑 postinstall（`patches/` 由 patch-package 应用），时间取决于 npm 缓存；超过 40 分钟按失败处理，日志在 `npm-ci.log`。
