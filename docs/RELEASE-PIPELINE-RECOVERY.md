# 发布流水线：可恢复构建与运行手册

## 设计目标

成功工作必须留在 artifact 中，而不是只留在即将销毁的 runner 上：

- 某个平台失败：恢复其他平台的成功产物，只补失败平台。
- Rust 已编译、DMG/NSIS/AppImage 打包失败：恢复原生二进制，只做打包。
- 发布上传失败：重跑发布 job，复用所有构建产物。
- Android 失败：桌面发布已经完成，独立补发 Android。
- 格式、测试、凭据、元数据或限时发布要求不满足：尽早失败，不先烧几个小时编译。

## 入口与执行图

```text
main push ── Release PR（release-please + 锁文件/notices 准备）
         └─ CI（每个 main SHA 保留自己的验证，不被后续 push 取消）
                  │ successful push CI / exact source SHA
                  ▼
             Release（workflow_run）
                  │ release commit / tag 身份一致
                  ▼
Rebuild Release → reusable-release-pipeline
                  ├─ verify：源码、版本、锁文件、凭据、限时要求
                  ├─ source-ci：已有的 exact-SHA push CI 证据
                  ├─ plan：查找可恢复的成功检查点
                  ├─ frontend + migration（并行：构建或恢复）
                  ├─ macOS ARM / Intel / Windows / Linux（各自构建或恢复）
                  ├─ publish：完整桌面产物 → draft / R2 → 公开 → latest
                  └─ dispatch Android 补发（独立 workflow）
```

`release-please.yml` 是轻量版本 PR 维护入口，不再和几小时的发布共享锁。
`release.yml` 只接受本仓库 main 上成功的 **push** CI；普通功能提交不会扫描旧 draft
并反复补建。发布失败后用失败 job 重试或 Rebuild Release 恢复。

主发布和完整重建共用 `release-desktop-<repo>`；资产修改入口共用
`release-assets-<repo>`。GitHub concurrency **不是 FIFO 队列**：只有一个 pending，
新 pending 可替换旧 pending。不要连续点击多个完整重建。

## 两级恢复检查点

### 平台/阶段完成检查点

`release-complete-<stage>` 只有在该阶段所有验证通过、所有产物上传完成后才生成。
支持 frontend、migration、macos-arm、macos-intel、windows、linux。

恢复必须匹配：

- 完整源码 SHA；
- 完整工作流 revision SHA；
- 签名/迁移豁免策略；
- 同一份前端 dist 身份（复用已有 digest，不再次创建另一套内容哈希）；
- 所需 artifact 都存在且未过期。

默认从 Release / Rebuild Release 最近各 30 次运行中选择匹配阶段；一个运行的
Linux 失败不妨碍取回其中的 macOS/Windows。不同阶段可来自不同运行，但必须是
相同候选/工具链 revision/前端。publish 仍校验实际安装包字节与 provenance。

恢复后重新上传到当前 run，因此当前 run 本身又成为完整的下一次恢复入口。

### 原生编译检查点

桌面构建先执行 `tauri build --no-bundle`，立即上传 `native-<target>`，再执行
`tauri bundle`。原生检查点绑定源码、工作流、前端和 release profile/RUSTFLAGS。

同一 job 中打包最多尝试 3 次，只清理生成的 `bundle/`，保留原生二进制和 Rust
target。打包持续失败后，下一次运行可下载原生检查点，跳过 Rust 编译。macOS
重新执行签名/公证；Windows 保留既有 Authenticode 后重新生成 updater 签名的顺序。

发布下载只允许平台发布 artifact 和 provenance。`native-*`、调试符号、
资源诊断、检查点 JSON、前端 dist 都不会被当作安装包上传到公开 Release。

阶段检查点、平台产物和原生检查点保留 **30 天**。中途被杀、尚未产生成功原生
二进制的编译依赖 sccache / rust-cache 复用已完成依赖；不是 rustc 进程快照。

## 如何恢复

### 首选：同一次运行的失败 job

```bash
gh run rerun <RUN_ID> --failed
```

GitHub 保留本次运行的成功 job/产物。编译已经完成的失败平台会进一步使用
`native-<target>`。单独 publish 失败时可以只重跑该 job。

### 新运行恢复

在 **相同工作流 revision** 的分支/ref 上运行：

```bash
gh workflow run rebuild-release.yml --ref <WORKFLOW_REF> \
  -f tag_name=vX.Y.Z -f resume_run_id=<RUN_ID>
```

不填写 `resume_run_id` 时自动发现匹配的成功阶段；填写时仅从指定运行恢复。
显式指定的运行如果没有任何可用检查点会直接报错，避免误触发全量重建。

更换工作流 revision 会使旧检查点失效，这是明确的恢复边界：修改编译工具和
打包逻辑后需要重新验证对应工具链产物。旧流水线没有这些检查点，不能把历史
安装包伪装成新链路的已验证产物。

### 明确从头构建

```bash
gh workflow run rebuild-release.yml --ref <WORKFLOW_REF> \
  -f tag_name=vX.Y.Z -f force_rebuild=true
```

更新嵌入式配置/凭据或外部 fixture 后，使用此入口使所有阶段及原生检查点失效。
不能同时指定 `force_rebuild` 和 `resume_run_id`。

重建不会移动 tag。候选业务测试红灯应准备新的修复候选，不能以重新贴标签替代
同一源码提交的验证。

## Android

桌面 publish 的 `needs` 不再包含 Android。桌面公开后，如果该版本尚无 APK，
异步触发 `rebuild-android.yml`，固定 source_ref 为已验证的源码 SHA。
已有 Android 补发资产在桌面恢复发布时保留，不能把 available 重置为 absent。

Android 本身保留：签名校验、APK native 库体积限制、versionCode 生成时机、
mobile-slim feature 集、16KB zipalign、旧版本不降级全局 latest 的策略。

Tauri CLI 2.11 的 Android build 会先编译原生库初始化插件，然后 Gradle 的
`BuildTask` 再调用 android-studio-script。CI 在生成的 BuildTask 中加入仅对
受管 `aarch64 release` 调用启用的复用路径，验证库存在、JNI symlink 目标、
ELF AArch64 与 Tauri JNI 导出后使用第一次编译的结果。普通本地 Gradle 路径
照常运行。模板结构变化会在准备阶段明确失败。

NDK/SDK 固定为 29.0.13846066 / Android 36 / build-tools 36.0.0；clang 的 API
level 与生成项目的 minSdk 24 对齐。Gradle workers=2，Java heap=2GiB，关闭 daemon。
签名前另存 unsigned APK，签名/发布失败可以保留之前的构建证据。

## CI 与迁移编译优化

- 快速前端/脚本门禁通过后才开始重型后端构建。格式在安装系统依赖前检查。
- nextest archive 构建一次，普通测试 8 片 + Provider 3 片都消费该 archive。
  Provider 用 anchored test filter、`--run-ignored only`、`--no-tests fail`，
  不再各自 `cargo test --list` 然后再完整编译一次。
- fixture 的 upgrade/fault/scale 共用一次编译得到的精确测试 executable，
  路径从 Cargo JSON 获取，不用可能匹配旧二进制的 glob。零测试仍然失败。
- build.rs 不再监视桌面端缺失的 AndroidManifest 或不存在的 packed-refs。
- Linux 统一真实 apt 安装并验证 pkg-config；删除 apt 文件快照恢复路径。
- Rust 固定 1.98.1，nextest 固定 0.9.145；Linux tests/dev debuginfo=0、显式安装并启用 lld。
- 根 Cargo 配置不再强制所有机器使用 14 个并行任务；CI 重型任务默认 2 个。
- sccache 安装/启动失败可回退直接编译，存储 I/O 故障可回退；idle timeout=0
  保留长编译期间完整统计，不把缓存网络故障当成应用编译错误。
- MinIO/MC 改用已核验发布 digest 的官方 Quay 镜像，初始化脚本错误不再被
  最后一条 echo 吞掉。
- nightly 三种模式共用 fixture executable；失败通知不再混用 gh 的
  `--comments` / `--json`，缺 fixture 的跳过不会被称作全量恢复。

## 资源与 GitHub 配置

Linux release / Android / CI / nightly 的编译任务共用资源准备脚本：

| 设置 | 默认 |
|---|---:|
| 物理内存最低预算 | 12 GiB |
| swap 总容量 | 补足到 12 GiB（不是检测到 3 GiB 就跳过） |
| 分配 swap 后磁盘余量 | 16 GiB |
| 编译资源采样周期 | 30 秒 |

Linux 编译流式记录 RSS、可用内存、swap、磁盘、cgroup memory events 和压力；
原退出码和 TERM 会传递给实际编译进程组。macOS 编译输出 `/usr/bin/time -l` 峰值。
资源诊断在 runner 存活时保存为 artifact；runner 完全失联时依靠此前流式日志。

需要更大机器时，配置仓库变量 **LINUX_BUILD_RUNNER** 为一个已开通的
**Ubuntu 22.04 x86_64 hosted larger runner label**，建议先从 32GiB RAM 测量。
archive 执行端仍是 Ubuntu 22.04 x86_64，不能把生产者随意切到 ARM 或不同 ABI。
这些准备脚本会清理 hosted runner 的预装开发组件，不用于共享生产/self-hosted 主机。

分支保护建议将 **CI Required** 设为 required check；其汇总不会将失败依赖的
skipped 当作通过，仅允许按变更路径明确跳过的 Provider job。应在该 check 首次
成功出现后更新 GitHub ruleset。

`RELEASE_PLEASE_TOKEN` 可配置为 release bot/GitHub App token，使 bot PR 变更直接
触发 PR CI。未配置时，Release PR workflow 使用 GITHUB_TOKEN 并显式 dispatch
CI 到准备后的 PR 分支，避免因防递归/待批准 PR event 而没有验证信号。合并后的
main push CI 仍然是发布的权威证据。

## 发布身份和渠道

版本准备发生在 Release PR：`npm run release:prepare` 更新 Cargo.lock 和 notices，
自动化只提交这两份准备文件；发布构建使用 `--locked`，不隐式修正候选源码。
源码 SHA 与工作流 SHA 独立记录，前端、平台 provenance 和最终安装包必须一致。

publish 在资产上传前直接读取 R2 当前 latest；不能把读取失败当作空指针。旧版本
恢复可以补充版本化资产，但不能降低全局 latest。资产全部可用之后才公开 draft，
最后更新 R2 latest 和 CDN。独立补发入口继续使用同一资产写入锁。

限时 upgrade-E2E waiver 仍由 `release-requirements.json` 明确定义；现有截止日为
2026-09-30。该要求在廉价 verify 阶段预检，并在恢复迁移证据时重新检查日期，避免
先编译很久才发现要求已过期。续期或真实产物升级 driver 应由维护者明确处理。

## 验证

```bash
node --test scripts/__tests__/*.test.mjs scripts/migration-ci/__tests__/*.test.mjs
actionlint -shellcheck= -pyflakes= .github/workflows/*.yml
shellcheck scripts/ci/prepare-linux-release.sh scripts/ci/with-resource-monitor.sh \
  scripts/ci/install-linux-deps.sh scripts/ci/prepare-sccache.sh
```

资源监控使用 Linux 的 setsid/procfs，macOS 上对应测试显式跳过；Linux 容器可完整执行：

```bash
docker run --rm --mount type=bind,source="$PWD",target=/workspace,readonly \
  --workdir /workspace node:22-bookworm node --test \
  scripts/__tests__/release-pipeline.test.mjs scripts/__tests__/release-recovery.test.mjs
```

首次上线必须用新的绿色候选进行真实跨平台构建；故意让打包/发布阶段失败一次，
再检查恢复日志是否跳过已完成的 Rust 编译/平台构建。单元测试与 YAML 校验覆盖
恢复契约，不替代 macOS 公证、Windows 安装器、Android Gradle 的实机产物验收。

### 2026-09-20 本地验收记录

- Linux Node 22 容器：127 个脚本/迁移工具/恢复测试全部通过，无跳过。
- 前端回归：原 5 个失败用例已修复；针对性 68 项及扩展闪卡/Markdown/顶栏 127 项
  均通过（两批有重叠，不相加统计）。
- `cargo check --lib --locked -j 2` 通过；稳定重复检查约 1.22s，无主 crate 重编译。
- `cargo test --lib data_governance::migration --locked -j 2`：194 passed。
- `cargo clippy --all-targets --locked -j 2 -- -D clippy::correctness` 通过，保留已有非阻塞 warnings。
- TypeScript、ESLint errors、许可证、rustfmt、actionlint、ShellCheck、diff whitespace 检查通过。
- 尚未部署到 GitHub；真实跨平台发布/恢复演练需在提交上线后完成。
