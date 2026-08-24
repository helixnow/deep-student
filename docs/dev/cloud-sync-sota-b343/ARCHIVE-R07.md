# ARCHIVE-R07：「Rust Tests · Build Archive」exit 143 诊断与止血

- 代理：R07-archive
- 对象：run [32679534026](https://github.com/helixnow/deep-student/actions/runs/32679534026) · job 97293649629（步骤 `Build and archive all test binaries`，exit 143 / SIGTERM）
- 结论：**不是编译错误，是 OOM 把 runner 打死**。且是仓库级旧病，不是 cloud-sync 分支引入。

## 一、证据链

1. **日志里零编译错误。** 完整 job 日志（3295 行）中没有任何 `error[...]` / rustc error，只有 warning
   （`dead_code`、`unused_must_use` 等）。最后一条正常输出在 02:53:15，随后 **94 秒完全静默**，接着：

   ```text
   02:54:49 ##[error]The runner has received a shutdown signal. This can happen when
            the runner service is stopped, or a manually started runner is canceled.
   02:54:49 ##[error]Process completed with exit code 143.
   ```

2. **排除 concurrency 取消。** 同分支下一次 push（4296437a）在 02:58:34 才触发新 run 并取消旧 run——
   被取消的 job（Vitest 1/4、3/4）结论是 `cancelled` 且都终止于 02:58:49。而本 job 在 **02:54:50** 就
   已终止，结论是 `failure` 而非 `cancelled`，与取消事件相差近 4 分钟。runner 是自己死的。

3. **排除超时。** job 限时 60 分钟，实际只跑了约 16 分钟（02:38:52 → 02:54:50）。

4. **跨 run、跨分支稳定复现同一签名：**

   | run | 分支 | Build Archive 结局 | 存活时长 |
   |---|---|---|---|
   | 32679534026（本案） | cloud-sync-sota-b343 | failure，shutdown + 143 | ~16 min |
   | 32677324933 | 同分支（c93fda72） | failure，shutdown + 143 | ~26 min |
   | 32674865289 | 同分支（40dd34d5） | failure，shutdown + 143 | ~16 min |
   | 31294033393 | **main**（8 月 9 日） | failure，shutdown + 143 | ~17 min |
   | 31266235109 | **main**（8 月 8 日） | failure | ~18 min |

   main 上 8 月上旬就已经是同样死法 ⇒ 非本分支回归；本分支新增的大量 sync 测试代码只是让病情更重。

5. **死因画像。** `cargo nextest archive` 要为全 workspace 构建所有测试二进制：`src-tauri/src` 约 23MB
   源码、8 个 `[[test]]` 独立 target + 20 余个 tests/*.rs，每个集成测试二进制都要把巨型
   `deep_student_lib`（dev profile `debug = true` 全量调试信息）整体链接一遍。标准 `ubuntu-latest`
   只有 4 vCPU / 16GB RAM / 默认 4GB swap；编译尾声进入链接阶段后，cargo 默认 4 路并行意味着最多
   4 个 GNU ld 同时各吃数 GB，物理内存 + swap 一起耗尽 → 内核 OOM killer 波及 Runner.Listener →
   GitHub 侧表现为「runner 收到 shutdown 信号」、步骤 exit 143（SIGTERM）。日志尾部 94 秒静默
   （无 rustc 输出、无心跳）正是内存重度换页/冻结的典型表象。

## 二、已做的最小止血（本分支，ci.yml 仅动 `rust-test-build` 一个 job）

1. **swap 4GB → 12GB**（新增 `Expand swap to survive linker memory peaks` 步骤）：
   链接峰值溢出到 /mnt 临时盘的 swap，慢但能活，OOM killer 不再碰 runner agent。
2. **`CARGO_BUILD_JOBS: '3'`**：并行链接从 4 路降到 3 路，直接削峰约 1/4。

刻意**不做**的事及理由：

- 不改 `RUSTFLAGS` / profile / `Cargo.toml`：任何指纹变化都会打碎与 migration-gate、
  migration-nightly 共享的 `shared-key: tests` 编译缓存（ci.yml 里 F8 审查特意指出的共享点），
  引发跨 job 缓存互踩。
- 不拆分 archive job、不换 runner 规格：属于结构性改动，超出本轮「最小修复」授权。

预期代价：链接阶段变慢（swap 换页 + 少一路并行），但 job 之前死在 16~26 分钟，限时 60 分钟，
余量充足。

## 三、若止血不够，按性价比排序的后续选项（供后续轮次决策）

1. **改用 lld 链接**：`sudo apt install lld` + `RUSTFLAGS=-Clink-arg=-fuse-ld=lld`。内存和耗时都大降，
   但改了指纹 ⇒ 需要同步应用到共享 `tests` 缓存的所有 job（migration-gate / nightly）。
2. **压缩测试调试信息**：`CARGO_PROFILE_DEV_DEBUG=line-tables-only`（回溯仍有文件:行号）。
   链接内存与 archive 体积双降，同样有缓存指纹联动问题。
3. **升级 runner**（`runs-on: ubuntu-latest-8-cores` 等大内存规格）：花钱换稳，零代码风险。
4. **合并/裁剪 `[[test]]` target**：8 个 e2e target 每个都全量链接一次 lib；合并可数倍降低总链接
   负载，但涉及测试组织结构，属大动作。

## 四、验证方式

推送本分支后观察 CI 中「Rust Tests · Build Archive」：
- 成功标准：步骤跑完并产出 `nextest-archive` artifact，后续 8 路分区测试能领到 archive。
- 若仍 143：查看新增 swap 步骤输出的 `free -h` 基线，按第三节升级手段。
