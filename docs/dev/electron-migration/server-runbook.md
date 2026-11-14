# 迁移调度：Linux 服务器部署手册

把 opencode lane 并行迁移从本机搬到 Linux 服务器时的完整步骤与踩过的坑（2026-11-04，德国 16 vCPU / 15 GB 机器实测）。

## 选型

- **Debian 12 bookworm x86_64**（或 Ubuntu 24.04 LTS x86_64）。不要 ARM：better-sqlite3 / LanceDB / Electron / pdfium 等原生模块按 x86_64 预编译验证过。
- 内存决定并行度：每条 lane 峰值约 2–2.5 GB（全量 `tsc -p tsconfig.host.json` ≈1.2 GB + vitest worker）。
  16 GB → 6 条；32 GB → 12–14 条；64 GB → 25–30 条。CPU 16 核足够（大部分时间在等模型）。
- 硬盘 150 GB：30 个工作树约 11–15 GB，opencode 会话数据一天可涨到 10–20 GB，再加 swap。

## 部署步骤（root）

1. swap：在原有基础上加到 RAM 的一半以上（`fallocate -l 16G /swapfile2` … 写入 fstab）。
2. 依赖：`build-essential python3 git ripgrep jq xz-utils sqlite3 xvfb xauth libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libsecret-1-0`。
3. 用户 `dsdev`；Node **26.5.0** 解压到 `/opt/node26`（只进 dsdev 的 PATH，不动系统 node）。
4. opencode **2.2.5**：npm 上没有 2.x，从 GitHub `anomalyco/opencode` release 下载 `opencode-linux-x64.tar.gz` 到 `~/.local/bin`。
5. opencode 配置：复制 `~/.config/opencode/{opencode.json,opencode.jsonc,AGENTS.md,agents,skills,commands,package.json,package-lock.json,tui.json}`（排除 `*.bak*`、node_modules），再 `npm i`。
6. **凭据不只在 auth.json**：OpenCode Console 多账号等存在 `~/.local/share/opencode/opencode.db` 的 `credential` 表。
   `sqlite3 -readonly opencode.db ".mode insert credential" "select * from credential"` 导出，导入服务器同名表；`opencode auth list` 核对与本机一致。
7. 仓库：本机 `git bundle create x.bundle --all`（不要拷 `src-tauri/target`，86 GB 无用）→ 服务器 clone，`git fetch bundle "refs/heads/*:refs/heads/*" --update-head-ok`。
8. `npm ci` 后：**npm 11 默认不跑未列入 allowScripts 的安装脚本**——执行
   `npm rebuild better-sqlite3 koffi sharp esbuild @swc/core --foreground-scripts` 与 `node node_modules/electron/install.js`。
   验证：better-sqlite3 `select sqlite_version()` = 3.53.4；`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron -e ...` = 45.2.1 / ABI 150。
9. `.oc-runs/sessions.json` 改写：`worktree` 改为新路径，删除 `pid`（旧机器的 pid 在新机器上可能指向无关进程，被误判为运行中）。
   若同时恢复了 opencode.db，可保留 `session` 让 lane 在原会话续做；否则删除 `session`，用 `oc-dispatch.mjs relaunch` 开新会话。

## systemd（资源隔离是关键）

- `dsdev.slice`：`MemoryHigh` ≈ RAM×0.65、`MemoryMax` ≈ RAM×0.8、`MemorySwapMax`、`CPUWeight=50`（低于同机其他服务）。
- **`ds-opencode.service`（`opencode serve --service`，Slice=dsdev.slice）必须由 systemd 托管**：opencode v2 的 `opencode run`
  只是客户端，tsc / vitest 等工具全由后台 serve 进程执行。若 serve 是某次手动 `opencode run` 顺带拉起的，它会落在 user.slice，
  资源限制完全无效（实测 user.slice 占 13 GB）。不要在 dsdev 用户下随手跑 `opencode run/api`，会再拉起一个游离 serve。
- serve 的环境：`TMPDIR=/tmp`（Linux 默认不设，部分测试写死 `process.env.TMPDIR!`）、`VITEST_MAX_FORKS=3`、`VITEST_MAX_THREADS=3`
  （vitest 默认按核数开 worker，16 核 × 每条 lane = 内存抖动的主因；`full` 内存压力曾达 84%）。
- `ds-migration.service`：`oc-dispatch.mjs watch --interval 300 --max-retries 3 --stagger 20 --integrate-every 3 --max-running N`，
  `KillMode=process`（重启守护进程不杀 lane），集成门禁 `VITEST_MAX_FORKS=6`。
- 观察：`/sys/fs/cgroup/dsdev.slice/memory.pressure` 的 `full avg10` 持续 >20% 就降 `--max-running`。

## 运维要点

- 重启 opencode serve 会让所有在跑的 lane 客户端 ECONNRESET 退出（code 1），守护进程会在原会话恢复；事后把 `retries` 清零，免得占重试额度。
- 要让某条 lane 让出空位：结束其客户端进程组即可（`opencode api session.abort` 在 2.2.5 不可用）。
- 守护进程空位分配按优先级（astra 复杂 lane 优先），并每轮回收父进程为 1 的孤儿 vitest worker。
- **不要在集成运行期间往 main 提交**：集成最后以 `merge --ff-only` 推进 main，main 被抢先移动会失败。
- 每次重启守护进程都会把自动集成的轮数计数清零；频繁重启时手动跑 `integrate --gate`（用 `systemd-run --slice=dsdev.slice --uid=dsdev` 放进资源组）。

## 迁移过程中发现的代码层问题（已修或待修）

- macOS 大小写不敏感：`.gitignore` 的 `**/LOG.*`、`**/MANIFEST-*` 曾吞掉 `log.ts`、`manifest-upload.ts`（已加源码豁免）。
- 跨 lane 服务改名：消费方在别的 lane，各自单独合入必然失败，需协调者合入时同步改消费方（L11 vfsRepo、L23 backup/syncProvider 已处理）。
  字符串形式的旧名（`inject: ['notes@1']`、`ctx.get('notes@1')`）类型检查发现不了，只在运行时报 "required services not available"。
- **待修**：L10 `notes@1 → notes` 已进 main，但 `notes` 注入 `vfsRepo`、`vfs-repos` 注入 `notes`，改名后形成循环注入，vfs-repos 无法启动（main 上 11+ 测试失败）。
  消费方同步在分支 `coord/notes-rename-sweep`；修法：vfs-repos 对 notes 改为可选依赖、调用时获取（仅笔记软删除/恢复/清除用到）。
- 集成门禁按目录前缀过滤测试：`host/plugins/llm` 会匹配到 `llm-providers`，平台相关测试（system OCR）需按 Rust 的平台条件 `skipIf`。

## 多账号额度调度（OpenCode Go）

- 配置 `.oc-runs/accounts.json`：`{ "integration": "OpenCode Console", "accounts": ["Default", "Personal", ...], "cooldownMinutes": 10, "quotaWindowMinutes": 300 }`，守护进程每次读取，改后不用重启。
- 加账号：在服务器上以 dsdev 执行 `opencode auth login`（选 OpenCode Console，起一个标签），再把标签加进 `accounts`。凭据存在 `opencode.db` 的 `credential` 表。
- 规则（`lib/accounts.mjs`，有单测）：按账号名记录耗尽时间；只切到从未耗尽或已过窗口的账号；全部耗尽时不切换，lane 按供应商故障流程等待、不计重试；
  当前账号耗尽而有账号恢复时每个 tick 主动切回；两次切换至少间隔 cooldownMinutes；只有 opencode-go 模型的 lane 触发换号（xhh 的 429 与之无关）。
