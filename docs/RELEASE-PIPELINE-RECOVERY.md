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
main push CI 仍然是发布的权威证据。fallback 按准备后的完整 SHA 查询 CI，已有
排队中、运行中或成功的验证时复用；失败或待批准的 PR event 不阻止重新 dispatch。

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
- 上述为部署前的本地验收；后续线上验证结果见下节。

### 首次线上验收补充

- 54667f588 已上线新流水线，b377d5fbb 恢复 Vitest 主进程的 6GiB 预算；四个前端分片已在线通过。
- 完整 Rust archive、Linux Clippy、Windows 沙箱、迁移以及 WebDAV/S3/FTP Provider 验证均已在线通过。
- Rust 分片新增 Xvfb + D-Bus 会话，提供桌面测试所需的显示环境；nextest 使用 `--no-fail-fast` 一次收集所有失败。后续工具执行器集成测试改用已有 headless 事件接口，避免在 Rust 测试线程创建桌面事件循环。
- 修正环境漂移测试对 macOS/ARM 主机的隐含假设，更新出题工具 600 秒超时及单调计数字段的旧测试契约。
- 首次完整分片还发现 E2EE 认领的迟到写入覆盖问题，经维护者确认纳入修复。新版通过独立 pending 登记保护在途写入，登记不按 TTL 强行抢占；崩溃残留的处理见用户指南「数据管理与云同步」。
- 云存储 178 项、环境指纹 12 项、工具超时契约本地通过；同步综合测试首次补验遇本机磁盘不足，使用独立精简 profile 构建目录后 59 项通过，E2EE 认领竞态集成测试 4 项通过。
- `69c3e1c6a` 修复应用面板测试未用 `act()` 完成打开 effect 导致搜索输入偶发被清空的问题，27 项面板测试本地通过。
- `fa096a07f` 的 Migration Nightly（run `35508195985`）成功。发现 Release PR 未变化时会重复 dispatch 同一 SHA 的完整 CI，fallback 已增加现有运行查询，并取消重复排队的 run `35509285726`。
- 完整 Rust 分片 run `35508262376` 执行 7,019 项，6,996 项通过、23 项失败；三个 Provider 均通过。后续候选 run `35509574016` 重现这些失败，并暴露 10,000 条写入用例在并行负载下超过 30 秒的波动。
- 第二轮修复覆盖：新增 VFS/聊天表的同步分类、整数软删除时间戳的确定性回放、工具包取消时保留已完成结果、headless 待办通知，以及目录游标/迁移版本/资源类型和真实同步 fixture 的旧契约。搜索测试实际连接本地 SearXNG mock 并验证请求、来源与注入文本。
- 10,000 条写入用例保留 30 秒性能断言，通过 `src-tauri/.config/nextest.toml` 独占当前 nextest 执行槽位，避免同 runner 的其他测试干扰计时。
- 第二轮本地验证：六组集成测试 143 项、同步综合测试 59 项、目录分页 4 项、迁移集合 2 项、资源类型 1 项、同步模块 215 项均通过；`cargo check --lib`、rustfmt 与 diff 检查通过。
- main `8f7f787ce` 的完整 CI（run `35512557653`）成功，包含八个 Rust 分片、三个 Provider、Windows 沙箱、前端和迁移门禁。普通提交触发的 Release 仅完成身份判断，尚未发布新版本。
- 发布 PR 的同批修复 CI（run `35512624980`）仅余画像并发更新测试失败：笔记元数据在事务外读取后，竞争写入替换并删除旧正文资源，导致后续读取报 `Resource NotFound`。笔记更新已将元数据/CAS 检查移入读取正文的同一 SAVEPOINT 快照，保留已有冲突/数据库锁重试；新候选完整门禁及各平台发布仍待验收。
- 该竞态修复的本地回归：画像 19 项、笔记仓库 32 项、每日日志 7 项通过；线上失败的画像并发更新用例额外连续运行 10 次通过。

### v0.9.63 实际发布验收进度

- 竞态修复 `d80b89bb7` 的 main CI（`35514651109`）及候选 dispatch CI（`35514728942`）均成功。GitHub 未将 dispatch 的检查计入 PR required checks；维护者批准原先 `action_required` 的 PR 事件后，正式 PR CI（`35514732157`）成功，#404 自动合并。
- 发布提交 `2687bc53229d09db653ccd16795ce216709d051a` 的 main push CI（`35517783501`）成功，自动 Release（`35519238647`）创建 `v0.9.63` 草稿并进入真实构建。
- Release 的源码/版本预检、exact-SHA CI、前端及完整迁移门禁、四个桌面平台构建与发布均成功，`v0.9.63` 已公开。实际保存平台产物、provenance、`native-*` 和 `release-complete-*` 检查点；尚未完成线上跨 run 恢复演练。
- 独立 Android 运行 `35524235072` 的 APK 编译及签名成功，发布在 `Delete old APK from Release` 步骤失败；桌面发布自动触发的 `35528439643` 全部成功，APK 已上传 GitHub 和 R2。
- 下载 R2 实际分发的 APK，其 SHA-256 与 GitHub release asset digest 一致。包内版本为 `0.9.63 / 14649`，minSdk 24、targetSdk 36，主库 94,306,608 字节；主库和 PDFium 均为 AArch64、ELF LOAD 段 16KB 对齐。
- 成品检查发现应用内更新安装器缺少 Manifest 的 `REQUEST_INSTALL_PACKAGES` 权限，影响 Android 8+ 请求安装更新包。CI 和本地构建已补齐权限注入，CI 增加签名成品的 `aapt dump permissions` 检查。actionlint、shell 语法及发布/恢复测试通过（57 passed，2 个 Linux 专属测试在 macOS 跳过）；修复后的 APK 尚待构建和成品检查，未进行 Android 设备启动测试。
