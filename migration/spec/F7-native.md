# F7 原生适配器：接口、实现与阻塞记录

本文件是手工服务记录，不冒充生成的命令 SPEC。当前 inventory/ledger 只包含 F1–F4，
未生成 F7 契约、DRAFT、SPEC、TESTMAP；F7 无可注册的自有 IPC 命令。
`convert_heic_to_jpeg`、`test_pdfium_status` 等命令归属仍以业务 lane 契约为准。

Ledger 的 `F_LANES`（`scripts/electron-migration/lib/lanes.mjs`）不读取本文件，
因此 F7 的 A/B 百分比无法由 `npm run migration:ledger` 计算；本 lane 不以“100%”自称。
需要 F5/协调者把 F7 纳入 `F_LANES` 并提供 `contracts/ipc/F7-native.json` 等统计入口。

## 接口发布

### WP-280（2026-11-06）：Linux sandbox EAGAIN 根因，blocked / 待 C2 定性

固定历史证据是 `.oc-runs/fulltest/latest.json` 的 `head=5f806c95eb2ef7cee7c08579a7fbdbb615acd1cb`、
`at=2026-11-06T13:11:03.680Z`：13670 tests、13586 passed、9 failed、75 pending、
`numFailedTestSuites=4`。JSON 实际有 **3 个 failed 文件记录**（候选文件含嵌套 describe），
不能把 suite 汇总数当成第四个失败文件；其中正式 L24 文件因 beforeAll 失败，7 个用例体未执行。
开工正常 merge main 至 `84b290acc`；本包审读的 F7/L05 两个实现、三个消费者测试、Rust
shell_sandbox.rs 和 L24 transform-script.ts 相对固定 head 无差异。main 已有
`host/platform/native/index.ts:16,30,60–61` 的 provider，及
`host/plugins/agent-workspace/index.ts:29,57,71–73` 的 adapter；不是缺接口/等待合入。

**定性：唯一一次真实 provider probe 复现宿主 RLIMIT_NPROC 资源阻断；没有证据支持为此修改
provider 限额。历史 9F 的失败阶段可以逐条定位，但历史运行没有同时刻资源快照，不能把本次
采样数冒充 13:11 的读数。G1 保持 blocked，交 C2 裁定环境限制及 capability 阶段差异。**

#### 原件与唯一作业

本工作树运行产物目录（不是新测试语料或产品代码；协调者自动检查点
`d4f8dc62c` 已将当时原件纳入提交，保留该历史）：
`/home/dsdev/dev/ds-mig/F7-native/host/platform/native/wp280/`。

- `fulltest-latest.original.json`：上述固定 JSON 的逐字节副本；`failures.original.json`：保留原
  assertionResults/failureMessages/message 的失败文件提取件，含全部 9 条堆栈及未执行 suite。
- `preflight.json`：先只读 `/proc` / cgroup / namespace 限制再启动作业的原件；
  `probe.json`：唯一实际调用的 before/after 数、逐 PID UID/Threads、实际 spawn 参数、
  子进程 `/proc/<pid>/limits` / stat、exit code/signal/stderr；`probe.mjs` 为取证脚本。
  脚本仅观察并转发真正的 `child_process.spawn`，调用原 `sandbox.probe` 一次，没有替身结果。
- `namespace-census.json`：后续只读 UID/user namespace 分组；`.c` 文件为上游 Linux v6.1
  和 bubblewrap v0.8.0 源码参照原件，不是编译输入；本包没有运行 Rust/C 构建。
- 作业 **20261106154532-9f84be，exit 1**：
  `node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- sh -c 'node host/platform/native/wp280/probe.mjs > host/platform/native/wp280/probe.json'`。
  作业日志 `/home/dsdev/.oc-jobs/done/20261106154532-9f84be.log`；失败照实返回 exit 1。

实际启动（2026-11-06T15:45:51.113Z，PID 3204000）：

```json
{"program":"/usr/bin/prlimit","args":["--cpu=130:130","--fsize=4294967296:4294967296","--nproc=2048:2048","--","/usr/bin/bwrap","--ro-bind","/","/","--unshare-net","--unshare-pid","--die-with-parent","--new-session","--","/bin/true"],"options":{"cwd":"/","env":{"PATH":"/usr/bin:/bin"},"detached":true,"stdio":["ignore","pipe","pipe"]},"code":1,"signal":null,"stderr":"bwrap: Creating new namespace failed: Resource temporarily unavailable\n"}
```

子进程 limits 原行（spawn 返回和 spawn 事件两次观察一致）：

```text
Max cpu time              130                  130                  seconds
Max file size             4294967296           4294967296           bytes
Max processes             2048                 2048                 processes
```

provider 原返回 `{"available":false,"reason":"bwrap: Creating new namespace failed: Resource temporarily unavailable\n"}`。
stat 显示 bwrap 的 PID/PGID/SID 均为 3204000，退出状态 Z；code=1、signal=null，
不是 5s 探测 watchdog 杀死，也没有到达 `/bin/true` 的业务执行。

#### 宿主约束与因果链

| 时点（UTC） | 同 real UID 1000 进程数 | 线程数 | 当前 cgroup |
|---|---:|---:|---|
| 启动作业前 15:45:32.255 | 1067 | 8124 | dsdev.slice/ds-opencode.service |
| probe 前 15:45:50.501 | 1072 | 7910 | dsdev.slice/ds-jobs.service |
| probe 后 15:45:51.388 | 1070 | 8007 | dsdev.slice/ds-jobs.service |

- Linux NPROC 计算线程，且 user namespace 的 rlimit ucounts 沿祖先累计，不是仅算当前
  sandbox 进程树，也不是只看 `ps` 的进程行数。后续 namespace census 确认很多线程在子
  user namespace；不能只用初始 namespace 的约 1001 线程反证未超限。
- 原父进程 NPROC=257008/257008；provider 设置子进程 2048/2048 后 bwrap 才 clone。
  UID 1000、CapEff=0、bwrap 为 root:root 0755（无 setuid），无特权豁免。
- jobs cgroup `pids.current=828`（前后）、`pids.max=77102`；祖先 dsdev.slice 为
  `1142→1135 / 20000`；两级 `pids.events=max 0` 前后不变。现有 cgroup pids 不是触发项。
- 所有 `/proc/sys/user/max_*_namespaces=257008`；unprivileged_userns_clone=1；Seccomp=0；
  threads-max=514016、pid_max=4194304。bwrap 的 namespace 数上限错误是 ENOSPC，
  权限错误是 EPERM；本次是 EAGAIN。MemAvailable 约 34 GB，未观察到 cgroup OOM。
- 上游 `bubblewrap v0.8.0/bubblewrap.c:2875–2889`：`raw_clone` 失败后原样报告 errno；
  `Linux v6.1/kernel/fork.c:2113–2121`：copy_creds 后 NPROC 超限返回 EAGAIN；
  `kernel/user_namespace.c:62–69,142–146` 新 namespace 继承 NPROC 限额；
  `kernel/ucount.c:262–275,342–354` 沿 ancestor 累计/检查。源码来源分别为
  `https://github.com/containers/bubblewrap/blob/v0.8.0/bubblewrap.c` 与
  `https://github.com/torvalds/linux/tree/v6.1/kernel`；宿主是 Debian Linux 6.1.0-10-amd64，
  bubblewrap 0.8.0-2+deb12u1 / util-linux 2.38.1-5+deb12u3。
  未安装 strace、未取得内核 syscall trace；结论依据实际 errno、限额、资源数和对应源码，
  不宣称获取了内核内部 ucounts 计数器。

#### Rust 对齐与应单独裁定的差异

Rust 文件 `src-tauri/crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs`：常量 :7–11；
`:190–225` 的 pre_exec 先 setpgid(0,0)，再设置 CPU/FSIZE/NPROC 的软硬值；Linux
`:710–714` 在真实 bwrap command 上应用；`:779–795,815–827` 对负 PGID SIGKILL，
ESRCH 视为已退出。F7 `sandbox/index.ts:17–31` 的 prlimit 参数和组隔离/清理
`:8–13,44–65` 对应；本次三项限额实际值正确。Node detached 同时创建 session，Rust
这里只 setpgid（bwrap 自身有 --new-session）；这不改变本次 NPROC 失败归因。

**capability 并非逐字同义**：Rust `:688–694` 仅 locate_bwrap，F7 `:72–88` 真实运行
受同样限制的最小 namespace probe，并有 5000ms watchdog；L05
`src/tools/transform-sandbox.ts:38–57` 透传 probe false，`:72–89` 才是真正业务 spawn。
因此资源不足在 TS 更早表现为 `sandbox_unavailable`；Rust 在 capability 后仍会在受相同
NPROC 限制的真实 bwrap 启动失败。把 probe 改成只检查文件不能解除宿主资源根因，本包
没有作此变更；C2 须单独决定此已有 capability/错误阶段差异是否另包处理。

#### 逐 9 条 + 1 suite（均保留失败）

下表 C 指 `host/plugins/chatanki/tests/candidates/l05-linux-sandbox.test.ts`，
A 指 `host/plugins/agent-workspace/tests/transform-sandbox-linux.test.ts`。
共同链：F7 probe clone EAGAIN → `{available:false, reason}` → L05 capability 透传 →
L24 `src/transform-script.ts:349–354` 先抛 sandbox_unavailable，未到 :387 业务 spawn。
历史 JSON 对直接 capability 断言未序列化 reason，故其 EAGAIN 细因由本次同实现复现支持，
不是声称这两条原件含完整 stderr。

| # | 原失败位置/用例 | 原件表现与失败阶段 |
|---|---|---|
| 1 | A:48 merged F7 Context provider enforces limits, env whitelist and cancellation through L05 | capability false ≠ true；未到 :54 spawn / env / limits / cancellation 断言 |
| 2 | C:66 capability and contract come from the real L05 + F7 candidates | capability false ≠ true；后续 contract 断言未到达 |
| 3 | C:91 python script reads input and writes output in sandbox | 原 stderr 为上述 bwrap EAGAIN；transform-script.ts:354，未执行 python |
| 4 | C:121 network is always denied inside the sandbox | 同原 stderr / :354；未执行网络隔离行为断言 |
| 5 | C:148 host files outside the job directory are unreadable | 同原 stderr / :354；未执行宿主文件读取尝试 |
| 6 | C:170 timeout terminates the process group structurally | 实际 sandbox_unavailable，期望 timed_out；未运行 sleep，也未到 timeout 清理路径 |
| 7 | C:190 nonzero exit and missing output are structured failures | 实际 sandbox_unavailable，期望 non_zero_exit；第二段 missing-output 场景也未执行 |
| 8 | C:222 node script honours the same contract | 同原 stderr / :354；未执行 node 脚本 |
| 9 | C:248 symlink output is rejected without following the target | 实际 sandbox_unavailable，期望 setup；未生成或检查输出 symlink |
| suite | `host/plugins/chatanki/tests/transform-script-real-sandbox.test.ts:38` beforeAll | capability false ≠ true，7 个用例体全部未执行；JSON 标 skipped 是 beforeAll 阻断结果，不是新增 skip，也不计 pass |

A:10 的直接 bwrap policy 测试原件 passed；它 :27–29 直接 spawnSync，未经过 F7 prlimit。
所以这个 pass 与受 NPROC2048 限制的 provider fail 并不矛盾，也不能用它替代 provider 验收。

#### C2 待决 / 解除条件

1. 将本次复现归类为共享 UID 的 NPROC2048 环境阻断；提供保持原 5s/130s/4GiB/2048
   的合适 runner/UID 资源预算后另包复验。执行者未结束任何其他进程、修改 sysctl/用户限额。
2. 对 capability 从 Rust 文件探测变为 TS 真启动探测、以及由此产生的错误阶段差异单独裁定；
   本包不借此放宽保护或把历史失败改绿。未发现本次失败所需的 provider 参数修复。
3. L05/L24 消费者复验由 C2 另行派包；本包仅一次最小 probe，无全测/消费者复跑。
   历史 suite 汇总 4 与 failed 文件 3 的计数口径应保持原样，不补造第四个失败文件。
4. 本 lane 无独立 BLOCKERS.md/TESTMAP.md，阻塞权威记录在本 SPEC 与
   `migration/testmap/F7-native.md`。TESTMAP 无条目转 ported/obsolete，G1 未完成。
5. 标准 lane-gate 因上述自动检查点识别到 native 目录变化，自动排入整目录测试
   `20261106155051-0fc0d3`；这与本包仅一次 provider probe 冲突。已立即通知 C2
   只撤销该排队作业。C2 已确认于 **15:56:25.780Z** 从 queue 单独撤销，未执行，
   无 running/done，未动其他作业或进程。原队列 JSON 保全于
   `/tmp/opencode/c2-1554-cancelled-native-job.json`，本 lane 逐字节副本为
   `host/platform/native/wp280/c2-1554-cancelled-native-job.json`。
   门禁原文 `tests（退出码 2）：未找到作业 20261106155051-0fc0d3` 是客户端观察到取消；
   **不是测试失败或通过**。lane-gate 自身 exit1 / ok:false，正式 gate 因范围机制阻塞。

#### 本包检查结果

lane-gate 检查 tip `c677785f5` / base `84b290acc`，4 项 exit0，测试项因上述撤销
无法完成，总 exit1。其后提交只补取证原件与报告，没有 provider/消费者源码变更。
完整 `.json` 元数据与 `.log` 已保存在同一 `wp280/` 原件目录。

| 检查 | job | exit |
|---|---|---:|
| 唯一真实 provider probe | 20261106154532-9f84be | 1 |
| typecheck（tsc host） | 20261106155051-489b3e | 0 |
| boundaries | 20261106155051-813f1f | 0 |
| boundaries-strict(changed) | 20261106155051-79656d | 0 |
| native index importable | 20261106155051-1de3e0 | 0 |
| ledger --check --no-write + wiring --lane native + boundaries:strict | 20261106155146-b7fa6f | 0 |
| lane-gate 自动派生 native 整目录测试 | 20261106155051-0fc0d3 | 取消、未执行（客户端 2；无测试 exit） |

必需检查原文（F7 无 ledger 统计入口，以下全仓百分比不代表本 lane A/B；wiring 也不读取
F7 手工表，0 不能当完整覆盖证明；无测试映射状态变化）：

```text
ledger: commands 1058 (A 99.8% B 0% C 0%), tests 8109 (A 89.8% B 1.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）; prod-reachable unreachable 14 (unknown 3644, not vetoed)
合计 ported 0，其中所测模块未从 index.ts 接入 0（0%）
(allowed) host/platform/native/tests/fixtures/sqlite-busy-worker.ts:28:31 [sql-outside-repository]
(allowed) host/platform/native/tests/fixtures/sqlite-busy-worker.ts:29:13 [sql-outside-repository]
boundaries: scanned 3204 files, 0 violation(s), 254 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
```

### 2026-11-04 PDFium 诊断行为清单

来源 `pdfium_utils.rs:191–238,248–349`：返回字符串 map；报告 `current_exe` 及父目录
（Rust Debug 引号）、按原顺序枚举候选并附 `(exists=true/false)`。Linux 扫描相邻 lib
一级子目录（含空格产品名），忽略不可读目录、只收文件、去重；追加 Resources 与 APPDIR
旧布局。macOS 三个 dylib 候选、Windows 两个 DLL 候选。加载成功写 `load_result=OK`，
再解析源码的同一个最小 PDF，写 `parse_test=OK, pages=N`；失败分别写 `FAIL: ...`，不抛
库加载/解析错误；无 DB、事件、事务。原命令本身无日志（初始化日志已由 WASM 加载取代）。
Host 真实引擎是 WASM，不尝试把候选 .so 伪装成已加载：额外 `engine`/`engine_path`
披露包版本与真实 WASM 路径；原键/候选保持不变。命令归 L18，由其接入
`nativePdfium.diagnostics()`；F7 不注册业务命令。

`host/platform/native/api.ts` 汇总各引擎的 `api.ts`；Cordis 属性为
`nativeTokenizer/nativeCompression/nativeProtobuf/nativePdfium/nativeFsrs/nativeStarlark/nativeOffice/nativeAudio/nativeImage/nativeHeic/nativeRegex`。
`host/platform/vector/api.ts` 提供 `vector`。接口发布后只做增补。
本期在不改已有签名语义的前提下追加：`NativeOfficeText`、`NativeProtobuf.decodeDmViewReply`
的可选 `encoding`/`status` 参数；`NativeFsrs.optimize` 收紧为可选成员（当前实现不提供，
原因见下文），并删除 F7 侧重复的调度/逻辑日导出。

## 已注册服务（`dstu.native`）

2026-11-04 新增provider见各节：`nativeOfficeWriter`、`nativeSandbox`、
`nativeWindowsFiles`、`nativeWindowsSandbox`；独立 `dstu.vector` 提供 `vector`。
另增 `nativeArgon2`，供F4替换Electron中的纯JS KDF（不越界改F4调用点）。
旧恢复记录的“未提供”说明以2026-11-04条目为准；不改业务lane拥有的命令注册。

### 2026-11-04 Unix 进程原生桥行为清单

来源shell_sandbox.rs:178–228,501–520,696–714,779–839。`nativeSandbox.spawn`
接收L05已构造的bwrap/Seatbelt launcher与argv；平台桥不复制L05的policy/root/profile逻辑。
校验平台和真实launcher名称，不降级普通shell；等待spawn/error后才返回；stdin忽略、
stdout/stderr为真实异步字节流（大小预算归消费方）；env是完整白名单，不merge宿主环境。
detached建立进程组；Linux用`/usr/bin/prlimit`原子exec设置CPU130秒、文件4GiB、
用户进程2048软硬限制；macOS由sh ulimit后exec sandbox-exec（未在目标平台验证）。
取消开始前/启动成功后检查；中途abort杀进程组SIGKILL，ESRCH视已退出；wait保留非零码/
signal→null。cleanupFinishedProcessGroup回收后台后代；dispose/插件卸载kill+reap所有句柄，
不删除job目录。probe真正运行最小sandbox，5秒后终止，不以“文件存在”宣称可用。
无DB/事件/业务日志；能力失败的原生错误由probe返回reason/执行时抛出。
Linux实测用Debian bubblewrap0.8.0-2+deb12u1的隔离解包二进制，未改系统包。
发布环境仍需安装bubblewrap与util-linux(prlimit)，或由打包方传入受信任launcher绝对路径。

### 2026-11-04 Windows 原生桥行为清单（未在目标平台验证）

`nativeWindowsFiles`：runtime_roots.rs:210–233,585–600,2025–2070。
CreateFileW(access0,BACKUP_SEMANTICS,share7,OPEN_EXISTING)获取root身份；
GetFileInformationByHandle真实返回attributes/volumeSerial/fileIndex，high/low拼bigint，
不把libuv inode当Win32身份。文件先GetFileAttributesW排除directory/reparse，再用
GENERIC_READ/OPEN_REPARSE_POINT打开，重新检查opened handle attributes；错误分为
inspect/open/inspect opened，文案按Rust；close忽略Win32返回（File Drop原行为）。
读操作使用handle的size先限额再分块ReadFile；不以路径重新打开。`ioError`用FormatMessageW
系统语言+`(os error N)`，不是把UV errno冒充Win32。没有业务DB/事件/日志。

`nativeWindowsSandbox`：shell_sandbox/windows.rs:131–209,1347–1464,1873–2023。
通过koffi3.3.3调用真实Create/DeleteAppContainerProfile、KernelBase的
DeriveCapabilitySidsFromName（逐SID/数组LocalFree）、Get/SetNamedSecurityInfoW DACL。
runAppContainer使用SECURITY_CAPABILITIES/EXTENDED_STARTUPINFO_PRESENT，默认无网络SID；
CREATE_SUSPENDED后先加入匿名Job，再检查取消，再ResumeThread。Job标志沿Rust：
kill-on-close/每进程CPU130秒/活动进程128，**Rust没有内存limit，不擅加**。
信号取消前置返回124；启动后TerminateJobObject(124)，像windows.rs:2002的INFINITE一样等进程退出
（异步100ms轮询；曾自加5s墙钟上限，v2自查已删除），再取i32 exitcode；
异常/退出均关闭thread/process/job，Job close终止整个树；失败无非沙箱回退。
命令行可信路径/quote、cwd ACL枚举/deny重写、受保护子目录恢复、helper payload与named
cancellation event仍属于L05；本bridge只提供原生操作，不把未接线策略谎报为“完整Windows沙箱”。
L05须在其api.ts发布policy/launch adapter并使用这些原生入口；当前5个Windows业务用例
仍pending，F7自身目标平台测试按win32条件执行，不用恒false能力测试掩盖缺口。

L05 W3增量（未在目标平台验证）：
- `WindowsRegularFile.readAt(offset: bigint, maxBytes)`：同一opened handle上SetFilePointerEx(FILE_BEGIN)
  后单次ReadFile，返回≤maxBytes（可短读，空=EOF），与Rust `File::read`一致；不重开路径、
  不缓存整文件。offset须0..i64max，maxBytes须0..u32max，越界RangeError；关闭后抛错。
  L05自行维护顺序读的位置（对应Rust `read`/`fstat`在write-backups/workspace-fs的用法）。
- `refreshInformation()`：对同一handle重新GetFileInformationByHandle（Rust `file.metadata()`），
  `information`仍是打开时快照。
- `runFullAccessJob(launch)`：windows.rs:1771–1868 `run_unsandboxed_job_process`。无AppContainer/
  ACL，STARTUPINFOW+STARTF_USESTDHANDLES，CREATE_SUSPENDED|CREATE_NO_WINDOW，Job只有
  KILL_ON_JOB_CLOSE（relaxed）。分配失败TerminateProcess(126)后报错；恢复前取消返回124；运行中
  取消TerminateJobObject(124)，像Rust INFINITE一样等待进程退出（异步100ms轮询，无5s上限）。
  差异：Rust helper用`Local\DeepStudentShellJob-{helperPid}`命名Job，那是每个helper进程一个；
  在宿主进程内同名会被并发执行共享，故用匿名Job（同DirectHostShellBackend:850的理由）。
- `acquireAclMutex(signal?)`：windows.rs:252–266。CreateMutexW
  `Local\DeepStudentShellAclMutex-v1`，WAIT_OBJECT_0/WAIT_ABANDONED即持有，超时检查取消→`null`，
  其他状态报错。差异：以WaitForSingleObject(0)+100ms异步休眠代替阻塞100ms，避免阻塞事件循环；
  Win32 mutex对同一线程可递归获取，而Rust每次执行在独立helper进程获取，所以宿主进程内先排队，
  保证进程内互斥。guard须在获取它的JS线程上release（ReleaseMutex线程归属）。
- 仍属L05：ACL策略、protected子树、helper协议、可信exe选择、命名cancellation event协议。

### 2026-11-04 DSBK Argon2id 加速评估

来源dstu-security/crypto/backup_crypto.rs与F4 backup-crypto.ts:90–110。
新增 `nativeArgon2.deriveKey(passwordBytes,salt,mKiB,t,p,length=32)`，调用
`@node-rs/argon2@2.2.2` 的Rust Argon2id v0x13（algorithm2/version1），
所有成本/长度都显式传入，不用库默认19MiB/t2/p1。不加secret/AD，不写文件/日志/DB/事件。
参数上限、错误包装、密码buffer清零与DSBK容器仍归F4；不在平台再复制其校验和业务文案。
测试用noble同输入核对UTF8/NUL、p1/p4与完整64MiB/t3/p4逐字节结果，并验证异步KDF期间
Host定时器正常运行。Linux实测：Node26.5 native67.97ms / noble7179.12ms；
Electron45.2.1 native113.36ms / noble7562.98ms，结果均相等（共享CPU环境，不作为性能硬断言）。
结论：可采用native加速，不需要更换算法/容器；F4待接入此导出，新增依赖需协调者安装。

- `nativeCompression`：Zstd 使用 Node/Electron 自带 libzstd，省去 npm 原生依赖；
  压缩不写 content size/checksum，解码按 Rust `decode_all` 处理所有帧。
  Node 单帧 API 不拒绝部分截断输入，故先检查帧边界。gzip 保留 flate2
  `GzDecoder` 单 member 语义、CRC/ISIZE 校验、默认 OS=255。
- `nativeHeic`：桌面分支必须在校验 raw body 后返回 `HEIC_UNSUPPORTED_PLATFORM`。
  引入 libheif 做桌面转换会改变 Rust 行为，因此当前不请求安装 libheif。
- `nativeImage`：同 crate 的 `image = 0.24.9` wasm 构建（默认 features，去掉单线程
  WASI 不需要的 `jpeg_rayon`）。`dimensions`/`decodeRgba` 对应
  `image::load_from_memory(bytes)` 后的 `DynamicImage::dimensions()` /
  `to_rgba8()`；PNG/JPEG/GIF/WebP/BMP/ICO/PNM/TIFF/HDR/DDS/QOI/OpenEXR 的接受集合
  与 Rust 相同（`load_from_memory` 按 magic 判型；TGA 没有 magic，Rust 与 Host
  都会拒绝，不能靠扩展名补判）。解码错误保留 `image::ImageError` 的 `Display`。
  `sharp@0.34.2` 路线已放弃：libvips 不支持 `FilterType::Triangle`，也不能解码
  Rust `load_from_memory` 支持的 BMP 等格式。
- `nativeOfficeText`：`document_parser.rs::decode_text_bytes` 的 BOM/UTF-8/
  GB18030/Big5/Shift_JIS 回退，`.txt/.md` 纯文本解码，以及 csv-core 0.1.13
  默认 dialect 的 CSV→TSV。只覆盖无 Office 容器的纯文本路径；二进制 Office
  引擎仍缺失。
- `nativeProtobuf`：手写 prost 兼容子集，覆盖 `bilibili_transport/grpc.rs`
  的 `DmViewRequest` 编码、gRPC 分帧、gzip data frame、trailer 校验、
  `DmViewReply/Subtitle/Track` 解码、未知字段跳过与 UTF-8/wire 校验。
  `encodeDmViewRequest` 返回与 Rust `request()` 相同的 `[0][len:u32be][body]` 帧。
  错误使用 `BiliError.code` 保留 `subtitle-protocol`/`grpc-status`/`response-too-large`。
- `nativeTokenizer`：`tiktoken@1.0.22`（同发布方原始Rust/WASM核心）的 cl100k_base / o200k_base。
  `encode()` 返回与 `tiktoken-rs::encode_with_special_tokens` 相同的 token id；
  `estimateTokensWithModel()` 完整复刻 `token_budget.rs::pick_encoding`、
  `has_o_series_prefix`、8,000 字符阈值、首/中/尾各 2,000 字符采样与
  `max(density) * total * 1.10` 外推；`estimateTokensHeuristic` 复刻 f32 累加的
  无 tiktoken 分支。
  **2026-11-04恢复后的实测与修正**：纯JS js-tiktoken在共享Linux机器上，200,000个
  “数”的采样估算耗时38.46秒，确实不满足Rust <5秒断言；不更改8000/2000阈值或
  采样算法，而改用同一发布方`tiktoken`的原始Rust/WASM BPE。相同输入估算220000，
  冷启动约493.9ms；原Rust的20K英文+20K中文+20K英文精确对照约3.47秒通过。
  120K多样文本的原±20%对照也已完整移植。旧记录“多样文本需数分钟”不成立：本次
  实测旧JS版本约1.97秒，真正瓶颈是连续CJK，已纠正而非继续沿用错误阻塞理由。
- `nativePdfium`：`@embedpdf/pdfium@2.15.1` 的原始 FPDF API。
  `open()` 对应 `load_pdf_from_byte_slice`（含密码）；`pageCount` 对应
  `pages().len()`；页宽高走 `FPDF_GetPageWidthF/HeightF`；`text()` 与
  `pdfium-render 0.9.4` 的 `PdfPageText::all()` 一样使用
  `FPDFText_GetBoundedText(0, height, width, 0)`；`render()` 按给定像素尺寸
  清白底、`FPDF_REVERSE_BYTE_ORDER` 输出 RGBA，`annotations` 控制 `FPDF_ANNOT`；
  `extractText()` 复刻 `pdfium_utils.rs` 的页序、`\f` 分隔、逐页 `trim()`、
  页内 `\f`→`\n` 与空页跳过；页文本对象创建失败与 pdfium-render 一样抛错，
  再由 `extractText()` 记 debug 日志后跳过该页（不静默返回空串）。
  **版本差异**：Rust 捆绑 `pdfium_7350`；`@embedpdf/pdfium@2.15.1` 内嵌
  `chromium/7689`（2.14.4 changelog “Sync pdfium-src with upstream
  chromium/7689”），`@hyzyla/pdfium@3.0.0` 为 8046d。选 7689 是因为它更接近
  7350 且直接暴露 FPDF 符号；仍不可能保证逐像素/逐字体一致，渲染等价性只验证
  API、文本、页尺寸与 RGBA 位图语义。`@hyzyla/pdfium` 可以卸载。
- `nativeFsrs`：只发布 fsrs crate 层数值：`nextStates`/`memoryState`
  （`fsrs = "=6.6.2"`，全部 f32 步骤用 `Math.fround`）。
  不提供 `optimize`（见下节）。接口中的 `optimize?` 为可选，测试显式断言其缺失。
- `nativeRegex`：`regex = 1.12.3`（与 `src-tauri/Cargo.lock` 一致）的 wasm 引擎。
  `compile` 的拒绝文案就是 `regex::Error` 的 `Display`（含
  `regex parse error:`、插入符行与 `error: …`），不经过 JS 改写；
  `is_match`/`find_iter`/`captures`/`replace`/`replace_all`/`split` 全部调用
  `regex::Regex` 对应方法。`$name`、`${1}`、`${name}`、`$$` 由
  `Regex::replace*` 自己的展开器处理，不使用 JS 替换字符串语义。
  返回的 `start`/`end` 是 **UTF-16 code unit** 下标（JS 字符串下标）；Rust 的
  UTF-8 字节偏移在引擎内换算。`Regex::split` 的末尾空串、空匹配推进、Unicode
  `\w`/`\b`/`\p{…}` 与内联 flag 均保持 crate 行为。
- `nativeStarlark`：`starlark = 0.14.2` 的 wasm 构建，方言为
  `Dialect { enable_load: false, enable_top_level_stmt: true, ..Standard }`，
  Globals 为 `Standard + Json + StructType + call/object_read/object_write`，
  限制默认 256 callstack / 32 MiB heap / 10M tick，解析/求值/结果错误前缀分别
  为 `ptc_run script parse error: `、`ptc_run script error: `、
  `ptc_run script result is not JSON-representable: `。宿主函数通过“记录应答 +
  重放脚本”桥接（Starlark 无时钟/随机/IO，重放确定）：每次真实宿主调用只执行
  一次 Node 回调，重放时返回同一记录。`call` 返回 Rust envelope
  `{"ok": true, "output": …}`；`StarlarkToolFailure` 映射为
  `{"ok": false, "error": …}`，其他异常按 Rust 硬错误中止并保留 traceback。
  `deadlineMs` 是绝对 Unix epoch 毫秒（与仓库其他 `deadlineMs` 一致）。
  **边界**：`call` 的白名单/预算/审批、`object_read`/`object_write` 的
  ManagedLocator/artifacts root/血缘属于消费方（L10 的 PTC 执行器）职责，
  由 `api.ts` 的回调实现；F7 只负责解释器与参数/默认值/错误包装。
- `nativeAudio`：`symphonia = 0.5.5`（features 与 `src-tauri/Cargo.toml` 完全
  一致）的 wasm 构建，直接复用 `dstu-media/media/decoder.rs` 与 `resample.rs`
  的代码（来源 commit 见 crate 头注释）。`probe` 与 `decodeToMono16k` 的
  容器/编码判定、坏包补静音、时间戳空洞、采样率变化、16 kHz 网格、报告字段
  与 Rust 相同；PCM 为 16-bit little-endian 单声道 16 kHz。
  错误对象为 `AudioDecodeError`，`code` 沿用
  `media-unsupported/media-no-audio-track/media-decode-failed/cancelled/io-failed`，
  `message` 保留 Rust `Display` 文案（含 `MP4(AAC)/M4A/MP3/WAV` 提示）。
  `onProgress` 的数值序列由解码器产生、在本次worker解码结束后按原顺序回放；
  `sink` 按 16,000 采样块交付（Rust 的 flush 阈值）。
  **取消**：2026-11-04已将WASI移入worker，中途AbortSignal终止worker并等待退出，
  之后清理输出并抛cancelled；开始前、每个进度/输出块前仍检查。停止点是worker退出，
  不精确等于Rust每packet边界，但不再阻塞Host或等整份音频结束才响应取消。

### `nativeRegex` 行为清单

#### C2 08:17增量：L24全文捕获有界替换（2026-11-05 已提供，见“第二次 WASI 重建”节；以下为当时记录）

已逐行阅读 `src-tauri/src/chat_v2/tools/chatanki_transform.rs:466–594`：

- `capture_reference_len`先按usize解析reference，失败才按capture name查找；缺失/未参与组
  长度为0。`expanded_replacement_len`扫描替换串的UTF8字节，不构建展开串，支持
  `$1`/`${1}`/`$name`/`${name}`/`$$`；未闭合`${`只计字面`$`后继续，非reference的`$`
  也按字面处理。`+1`放在`${+1}`中按Rust usize解析；整数溢出后按名称查找而不是Number舍入。
- `bounded_regex_replace`由L24取`limit=max(1MiB,before.len())`；对完整before的
  `regex.captures_iter(before)`，每个match先加`matched.start()-previous_end`未匹配段字节，
  再加expanded长度（两次独立检查），每次saturating_add后首个`projected>limit`立即返回
  该累计值；末尾再加tail字节。只有所有检查成功才调用原文`regex.replace_all`。
  不对文本切片重匹配，不先物化最终值再查长；零宽推进/Unicode边界由Rust引擎处理。
- 当前F7公共`regex/api.ts`/`index.ts`只有compile/isMatch/findIter/captures/replace/
  replaceAll/split。`findIter`只返回整段匹配的UTF16起止和text，不含每组捕获；
  `captures`只有完整原文中的第一次捕获，没有start_at/captures_iter；replaceAll只返回
  已物化字符串，不接收limit也不返回投影字节。
- 现有预编译引擎对应 `wasm/src/regex_engine.rs:38–94` 的JSON操作表是
  `compile,is_match,find_iter,captures,replace,replace_all,split`；缺
  `captures_iter` / `captures_at` / `replace_all_projected`。预编译WASI入口
  `wasm/src/main.rs:48–55`只分派engine；regex内部有captures迭代实现用于replace_all
  不等于它通过JSON绑定公开。现有源码/产物记录见toolchain.txt、wasm.sha256；本轮
  **没有运行cargo/rustc、没有重编产物、没有安装新包**。
- 不能用`findIter`+`captures(before.slice(...))`恢复捕获：例如`(?P<suffix>\Bb)`对
  完整`xb`匹配b，但独立`b`不匹配；`^`/`\A`等同理。不能根据整段match推出可选/命名组，
  也不能把`replaceAll`后最终bytes当作“第一次超限bytes”。本lane未发布空实现或仅加声明。

最小绑定请求（供获授权产物维护方实施，不是已提供的API）：

```ts
replaceAllProjected(pattern, text, replacement, limit): Promise<
  { ok: true; value: string; bytes: number } | { ok: false; bytes: number }
>
```

对应WASI新增一个 `replace_all_projected` JSON op：输入pattern/text/replacement及明确limit；
成功响应`{ok:true,value:{ok:true,value:after,bytes:projected}}`；首超限响应
`{ok:true,value:{ok:false,bytes:firstOverLimit}}`（外层ok是协议成功，不能误抛编译错误）；
编译失败继续原外层`{ok:false,error:regex::Error Display}`。业务op_index/field/error封装
仍归L24。limit由调用方按Rust规则计算，不在native再偷偷max；比较为严格`>`。
一次请求在同一Rust Regex上执行全文captures_iter与纯长度投影，失败分支不调用replace_all，
成功才在原文replace_all并返回value/bytes。单个op避免将所有captures跨JSON物化，亦不改变
原文锚点/零宽推进。无日志/DB/事件/事务副作用。

**WASI32实现注意（不能直接照抄usize宽度）**：四个桌面目标均64位，Rust原`usize`
投影与reference解析为64位；wasm32的usize为32位。新op须以u64保持桌面64位饱和
计数（capture字节len先转u64、saturating_add），reference先按u64解析，确认索引在
实际captures长度内才转本地usize。否则大展开首次超限bytes会错误饱和到2^32-1。
例：完整2MiB文本被`(?s)(.*)`捕获，replacement为`$0`重复2048次，limit=2MiB，
应在首个expanded检查返回4294967296，不能返回4294967295，也不得分配4GiB结果。
这是待绑定就绪后运行的安全投影向量，本轮未向无界replaceAll发送该大展开输入。

绑定就绪后必须通过的最小直接API向量（当前仅为Rust源码推导的验收需求，未执行新op）：

| pattern / text / replacement / limit | 应返回 | 所保护的事实 |
|---|---|---|
| `(?P<letter>[a-z])\|(?P<number>[0-9])` / `ab12` / `${letter}${number}$$` / 8 | `{ok:true,value:"a$b$1$2$",bytes:8}` | 未参与组为空、命名展开、$$、恰好limit可接受 |
| `(?P<suffix>\Bb)` / `xbZ` / `${suffix}${suffix}${suffix}` / 3 | `{ok:false,bytes:4}` | 首gap1+expanded3即停止；不能报告加入尾Z后的最终5；不能slice后丢失\B |
| `x` / `数x尾` / 空串 / 2 | `{ok:false,bytes:3}` | 未匹配gap本身先触发，不能跳过gap检查直接看最终输出 |
| `a` / `a数` / `a` / 3 | `{ok:false,bytes:4}` | 尾段也按UTF8字节参与独立检查 |
| 空pattern / `数😀` / `$$` / 10 | `{ok:true,value:"$数$😀$",bytes:10}` | Rust全文Unicode零宽推进、UTF8字节而非UTF16长度 |

上述limit是native的显式入参；业务层的1MiB下限不应硬写到原语里，因此可用小向量验证。

本轮仅新增两条现有公开API的上下文/零宽/捕获展开证据测试，不把它们标成有界替换已迁移；
L24的分配前增长闸门与首超限bytes仍pending。需授权维护方更新同regex1.12.3的WASI产物
后，F7再增补公开方法并测试原Rust三项增长用例；禁止用相似TS/JS算法或危险大输出探测来绕过。

Rust 来源：直接调用 `regex = 1.12.3`；无项目内包装层。

| 操作 | 输入校验 | 分支/返回 | 错误文案 |
|---|---|---|---|
| `compile` | `Regex::new(pattern)` | 成功返回不透明 handle；不做额外 trim | `regex::Error` 的 `Display` 原样（含 `regex parse error:`、插入符行、`error: …`） |
| `is_match` | 重新编译同一 pattern | 布尔 | 同上 |
| `find_iter` | 同上 | 所有非重叠匹配 `{start,end,text}`；空匹配按 crate 规则推进 | 同上 |
| `captures` | 同上 | 首个匹配；`groups[0]` 为整体，未参与组为 `null`，`name` 为 `(?P<…>)` 或 `null` | 同上 |
| `replace` | 同上 | 仅替换首个匹配；替换串交给 `Captures::expand` | 同上 |
| `replace_all` | 同上 | 替换全部 | 同上 |
| `split` | 同上 | `Regex::split` 的完整片段，末尾匹配后保留空串 | 同上 |

- **下标**：`start`/`end` 是 UTF-16 code unit 下标（JS 字符串）；crate 的 UTF-8 字节偏移在
  wasm 内换算。
- **crate 隐式语义**：默认 Unicode（`\w`/`\d`/`\b`/`\p{…}`）；支持内联 `(?i)`/`(?m)`；
  不支持环视/反向引用（编译期报错）；默认匹配大小上限与 crate 相同。
- **日志/副作用/事件**：无。纯函数；不写文件、不发事件、不访问数据库。

### `nativeStarlark` 行为清单

Rust 来源：`ptc_runtime.rs::run_ptc_script_with_limits` 与 `ptc_globals`。

| 阶段 | 行为 |
|---|---|
| 解析 | `AstModule::parse("ptc_run.star", script, Dialect { enable_load:false, enable_top_level_stmt:true, ..Standard })`；`load()` 解析期拒绝；失败 `ptc_run script parse error: {e}` |
| Globals | `Standard + Json + StructType` + `call`/`object_read`/`object_write`；无 Print/Debug/Breakpoint/IO |
| 限制 | 默认 256 callstack / 32 MiB heap / 10M tick；`set_max_*` 失败时 `log::warn!("[PtcRuntime] interpreter limit rejected: {e}")` 后继续（Host 的 wasm stderr sink 记 warn） |
| 取消 | `set_check_cancelled(deadline)`；starlark 报 `Evaluation cancelled`，外层加 `ptc_run script error: `；AbortSignal 在每次重放边界检查 |
| 结果 | 末尾表达式 `to_json_value()`；失败 `ptc_run script result is not JSON-representable: {e}`；赋值结尾返回 `None` |
| `call(tool,args)` | 工具名 trim 后补 `builtin-`；`builtin-ptc_run` 直接硬错误 `ptc_run cannot invoke itself (recursive call)`；字符串 args 按 JSON 解析，失败 `ptc_run: call args string is not valid JSON: {e}. Pass a Starlark dict or a JSON string.`；非字符串按 `to_json_value`，失败 `ptc_run: call args must be JSON-representable: {e}`；成功 envelope `{ok:true,output}`，tool failure envelope `{ok:false,error}` |
| `object_read(object, offset=0, limit=8192)` | 仅把 object 转 JSON 后委托回调；回调失败硬错误 `ptc_run: object_read failed: {e}` |
| `object_write(object, content, offset=None, expected_sha256=None, encoding="utf-8")` | 同上；回调失败 `ptc_run: object_write failed: {e}` |
| 副作用 | 每次真实宿主调用在 Host 回调执行一次；重放只复用记录，不重复调用；不写数据库、不发事件 |
| 事务位置 | 无事务；宿主回调的副作用由消费方（L10 PTC 执行器）在调用时执行 |

- **边界**：白名单/预算/审批、artifacts root、ManagedLocator、血缘与 trace 都是消费方
  `call`/`object_read`/`object_write` 回调的职责；F7 只保证解释器、参数默认值、错误包装。
- **crate 隐式语义**：`starlark 0.14.2` 的 Standard dialect；整数任意精度、字符串 Unicode、
  dict 插入顺序；重放协议依赖 Starlark 无时钟/随机/IO 的确定性。

### `nativeAudio` 行为清单

Rust 来源：`dstu-media/media/decoder.rs` + `resample.rs`。

| 方法 | 输入校验/分支 | 返回/错误 |
|---|---|---|
| `probe(path, extensionHint?)` | `File::open` 失败 `io-failed`（`无法打开媒体文件 {path}: {io}`）；`Hint` 取扩展名、去前导点、转小写；容器探测失败按 `SymError` 分流 `Io`/`Unsupported`；选首条可解码音轨，否则 `media-no-audio-track`/`media-unsupported` | `{duration_ms,codec,sample_rate}`；`duration_ms` 由 `n_frames × time_base`（或采样率）计算，未知为 `null` |
| `decodeToMono16k` | 同上打开/选轨；`make` 解码器失败 `media-unsupported`；首包建立时间戳原点；时间戳前跳超过 200 ms 补静音（单次上限 600 s）；坏包按包时长补静音并累计 `corrupt_packets/filled_silence_ms`；开头连续失败 > 64 次判损坏；尾部读错误 `warn` 后按已解码部分收尾；采样率中途变化时收尾旧重采样器、网格偏移继续；从未解出任何帧 → `media-decode-failed` | `{samples,duration_ms,source_rate,source_channels,codec,corrupt_packets,filled_silence_ms}`；PCM 16-bit LE mono 16 kHz |
| 日志 | 尾部读错误 `warn!("[media::decoder] read error near end, finishing early: {e}")`；demux 坏数据 `warn!("… demux error skipped: {msg}")`；已解码后 demux 停止 `warn!("… demux stopped: {e}")`；坏包 `debug!("… corrupt packet skipped: {msg}")` | Host 通过 wasm stderr sink 记录到 `dstu_media::media::decoder` |
| 进度 | 每 64 个 packet 用 `expected_frames / n_frames` 报 0..1；结束 `on_progress(1.0)` | Host 在worker解码结束后按原顺序回放，非实时 |
| sink | `out.len() >= 16_000` 时 flush；sink 返回错误立即中止 | Host 按 16,000 采样块交付 |
| 取消 | 每 packet 前检查；Host中途取消终止worker并等待退出，开始前/每个输出块前仍检查 | `cancelled`/`已取消`（worker终止与packet边界粒度不同） |
| 副作用 | 只读源文件、写 PCM/进度临时文件；不写数据库、不发事件 | 无事务 |

- **crate 隐式语义**：`symphonia 0.5.5` features 与 `src-tauri/Cargo.toml` 完全一致
  （aac/adpcm/alac/flac/mp3/pcm/vorbis/isomp4/mkv/ogg/wav）；`FormatOptions { enable_gapless:false, ..Default }`；
  `MetadataOptions::default()`；重采样常量 `TARGET_RATE=16000`、`ZERO_CROSSINGS=8`、
  `CUTOFF_RATIO=0.92`、`MAX_PHASES=4096`、`GAP_TOLERANCE_MS=200`、`MAX_GAP_FILL_SECONDS=600`、
  `MAX_LEADING_DECODE_FAILURES=64`。

## 已注册服务行为清单（单元协议第 1 步补充）

本节补齐本 lane 在协议生效前已实现服务的 Rust 行为清单；`nativeRegex`、
`nativeStarlark`、`nativeAudio` 的清单见上。除 `nativeHeic` 的 Android 分支外，
这些服务都不写业务数据库、不发事件、没有事务提交点；日志一栏逐项注明。
`nativeCompression`/`nativeProtobuf` 的错误包装由消费方按 `api.ts` 约定完成，
这里只记录适配器保留的底层错误。

### `nativeCompression` 行为清单

Rust 来源：`dstu-anki/apkg_importer_service.rs` 的 zstd 解压/媒体写入，
`dstu-media/bilibili_transport/grpc.rs` 的 flate2 gzip data frame。

| 方法 | 输入校验/分支 | 返回 | 错误 |
|---|---|---|---|
| `zstdEncode(bytes, level=0)` | `level=0` 表示 zstd 默认级别；不写 content size、不写 checksum（Rust 流式 `Encoder` 不知道总长） | zstd 帧 | Node zlib 原生错误原样抛出 |
| `zstdDecode(bytes, maxOutputBytes?)` | 按 zstd 帧头逐帧切分（`zstd::stream::read::Decoder` 会连续读取拼接帧）；每帧校验 magic/长度；累计输出超过上限立即失败 | 所有帧解压后拼接 | 截断/损坏保留 zlib 错误（`code` 如 `Z_DATA_ERROR`）；超限 `RangeError` |
| `gzipEncode(bytes)` | flate2 `Compression::default()`；mtime=0、OS=255 | gzip 单 member | Node zlib 原生错误 |
| `gzipDecode(bytes, maxOutputBytes?)` | 校验 magic/CM/flags 与 FEXTRA/FNAME/FCOMMENT/FHCRC；raw inflate 后校验 CRC32/ISIZE；只解一个 member，后续字节不消费 | 解压字节 | 结构错误 `invalid gzip stream`；超限 `RangeError` |

- **日志**：Rust 调用点把 zstd 错误作为 `Result` 返回并由业务层转文案（如
  `初始化 zstd 解压失败: {e}`），没有 `warn!`/`error!`；本服务不记日志。
- **隐式行为**：Node 的 `zstdDecompress` 只处理单帧，必须自行切帧；
  `zstdCompress` 默认写 content size，必须显式关闭；`gunzip` 会消费所有
  member，必须换 `createInflateRaw` 才能复刻 flate2 的单 member 语义。
- **错误文案边界**：`api.ts` 声明 raw codec 只保留底层库错误，Rust 包装文案由
  消费方生成；这不是静默改写，而是接口层约定。

### `nativeHeic` 行为清单

2026-11-04：曾根据续派需求实现并验证libheif桌面解码，但随后合入的架构师D5
明确“不批准libheif-js”（decisions.md:129），桌面HEIC能力退化交前端统一评估。
因此撤回本轮未合入main的decodePrimary/convertDesktopToJpeg扩展及其专属新增测试/样本，
不是为了让测试通过而删除断言（撤回前Node/Electron真实样本测试均通过）。
不请求安装libheif-js，原convertToJpeg及Rust桌面四分支测试完全保留。

Rust 来源：`src-tauri/src/heic_decoder.rs::convert_heic_to_jpeg`。

| 阶段 | Rust 行为 | Host 实现 |
|---|---|---|
| 请求体 | 必须是 raw bytes；JSON/其他 body → `HEIC_INVALID_INPUT: expected raw binary request body` | 同文案（`AppError.validation`） |
| 空体 | `HEIC_INVALID_INPUT: empty image body` | 同 |
| 大小 | `> 50 MiB` → `HEIC_INVALID_INPUT: image exceeds 50 MB` | 同（先于平台判断） |
| 平台 | 非 Android 在完成上述校验后返回 `HEIC_UNSUPPORTED_PLATFORM: native HEIC conversion is only available on Android` | 同（Electron Host 只有桌面平台，Android 分支不迁移） |
| Android | 写 `<cache>/heic-convert/<uuid>.heic`，Kotlin 解码为 JPEG（质量 90、16MP 上限），读回后删除输入/输出临时文件 | 不在 Host 目标平台内，不实现 |
| 日志 | 无 | 无 |
| 副作用 | 仅 Android 临时文件；桌面分支无 | 无 |

### `nativeImage` 行为清单

### C2增量：整数像素裁剪（exam_sheet_service.rs:521–539,744–751）

- 输入已经是业务层规范化的u32 `{x,y,width,height}`，源图已`to_rgba8`；新增
  `nativeImage.cropRgba(input,bbox):RgbaImage`，不调用cropFigure、不除以源尺寸再换算。
- image0.24.9/imageops/mod.rs::crop_dimms：`x=min(x,iwidth)`、`y=min(y,iheight)`，
  `width=min(width,iwidth-x)`、`height=min(height,iheight-y)`；复制对应行RGBA字节。
  x恰在右边界可返回0宽；完全越界可返回0×0；不强制至少1，不自动旋转/交换bbox。
- 参数域与Rust u32一致：0..4294967295整数；负宽高（并非合法的反向端点bbox）、
  分数、NaN/Infinity在TS原语边界报RangeError，不擅自abs/round。有效大u32 extent
  先截断到现有源图，再分配；原语没有另设4px最小值或200MB门槛。
- 新题create路径在调用前由业务层检查最小4px，调用后若宽/高为0返回
  `AppError.validation("新增题目的分割框无效")`；adjust路径的输入width/height>0及
  调用后`"调整后的分割框无效 (0 宽或高)"`检查都由L18保持，不搬入原语。
- 输出为独立、非预乘RGBA8 buffer；不改源图。PNG由消费方调用现有encode组合；
  加载/保存文案、文件副作用和事务在L18。本原语无日志/事件/DB/磁盘副作用。
- 精确字节裁剪不涉及滤波或JPEG损失；encode的依赖审批/PSNR门槛并未因此解除。
  当前PNG编码依然用未批准pngjs，包装部署状态如实保持阻塞，不以测试通过签收D5。

L02增补（exam_engine.rs:371–388）：`resizeTriangleJpeg`先同crate解码，宽高都在bounds内
不resize，否则按DynamicImage bounding-box resize/Triangle；JPEG quality由调用点传85。
错误类ImageOperationError只加stage=decode/encode，不改底层message，使L02保留两种上下文。
≤1500000字节的bytes/MIME原样分支归L02；平台不复制该门禁。无日志/DB/事件。

2026-11-04 增补（8-bit RGBA 层，不冒充所有 DynamicImage 色深）：

- `resizeRgba` 逐步移植 image 0.24.9 `imageops/sample.rs` 的 vertical_sample →
  horizontal_sample：像素中心、下采样 support 扩张、边缘截断后权重归一、f32 累加、
  末次 clamp + round。Triangle 支持域1；Lanczos3 是 sinc(x)*sinc(x/3)，支持域3。
  不做 alpha 预乘、gamma、EXIF auto-orient。JS sin 与 Rust sinf 最末位可能不同，
  Lanczos 输出允许1个8-bit量化级，未取得 Rust 动态向量（C级）。尺寸相同时复制。
- sharp 无 Triangle kernel；其 Lanczos3 的定点/缩小优化和 alpha 预乘不等价，
  因此不把 sharp.resize 静默当 imageops。无成熟等价 Triangle 库时才移植上述采样器。
- `resizeDimensions` 对应 `image::math::utils::resize_dimensions(..., fill=false)`，
  f64 比例，宽高 round、最小1，含上采样；不是 sharp 的 floor-fit。
- `encode` 已按架构师转L18请求切至D5批准的 `sharp`（root声明^0.34.2，实际0.34.5）。
  PNG使用raw RGBA8、palette:false保留无损像素；JPEG先显式复制RGB丢弃alpha，再以raw RGB
  编码（不flatten黑/白背景、不预乘）。quality clamp 1..100，JPEG chromaSubsampling:'4:4:4'。
  image JPEG 源码的 components h/v 均1，注释声称4:2:2但实际4:4:4，以代码为准。
  libjpeg 与 image 的 DCT/YCbCr 舍入不同：不声明 JPEG 字节恒等或全图误差上界；
  同尺寸/格式/quality策略/输出大小上限可验证；实际 Rust JPEG 像素容差仍待C级向量。
  sharp实测在Electron45.2.1触发大量 `GLib-GObject-CRITICAL ... g_object_unref/ref`
  警告（测试仍通过）；本轮改回批准依赖后Electron仍复现警告，未屏蔽/过滤，不据exit0签收
  为无警告（最终Electron定向作业日志有1056条GLib-GObject-CRITICAL行，Node未出现）。
  pngjs/jpeg-js候选已不再被生产代码加载，不再要求安装它们来解除codec缺包。
  编码仍在独立image/encode-worker.mjs中执行，等待exit
  后返回字节/抛库错误；不阻塞Host定时器。同步resizeRgba仍是显式内存操作，消费者可
  放入自己的CPU任务worker；不偷偷改变其现有同步返回签名。
  Node作业20261104145405-0df76d、Electron20261104145405-8e8128均21 passed/exit0（3文件）；
  除原质量/上限/尺寸断言，新增透明RGB PNG精确往返、同RGB不同alpha的JPEG字节一致及
  独立固定PNG→DOCX必须有drawing/media且无[image]的回归。sharp从共享root解析，未安装新包。
  D5图片PSNR与目标平台验证仍pending，不把codec可运行当作Rust像素等价。
- `cropFigure` 对应 vlm_grounding_service.rs:1501–1532：反向 bbox 先 min/max，再 clamp
  到0..1；origin与宽高独立 round；宽高至少1；origin clamp 到边缘像素，extent clip。
  默认零框得1×1。失败使用同 AppError（Unknown/Validation）形状，无日志/DB/事件。
- `encodeJpegWithinLimit` 只执行消费者传入的质量序列（VLM为85/75/65/55），首次
  ≤上限返回；全失败抛“压缩后仍超过 NKB 上限”。VLM的成功 info 日志、输入大小门禁、
  source_index与data URL仍属L18，不在平台复制。

Rust 来源：调用点直接使用 `image = 0.24` 的
`image::load_from_memory(bytes)` + `DynamicImage::dimensions()` / `to_rgba8()`。

| 方法 | 输入/分支 | 返回/错误 |
|---|---|---|
| `dimensions(bytes)` | 空/未知 magic/损坏数据 → `image::ImageError` 的 `Display`（如 `The image format could not be determined`）；格式由 magic 决定，不看文件扩展名 | `{width,height}` |
| `decodeRgba(bytes)` | 同上；成功后在 wasm 内 `to_rgba8()`，原始 RGBA 写入 `/out/rgba.bin`，JSON 只回报宽高与字节数 | `{width,height,rgba}` |
| 格式集合 | PNG/JPEG/GIF/WebP/BMP/ICO/PNM/TIFF/HDR/DDS/QOI/OpenEXR；TGA 因无 magic 不被 `load_from_memory` 识别（Rust 同样拒绝） | |
| 错误文案 | 保留 crate `Display`；Host 只在响应缺失/长度不符时生成 `image engine returned ...` 的内部协议错误 | |

- **日志**：`image` crate 的解码路径与 Rust 调用点都没有 `warn!`/`error!`；本服务不记日志。
- **副作用**：只读输入字节，临时文件在 `/out`，调用结束即删除；无 DB/事件。
- **隐式行为**：`to_rgba8()` 对带 alpha 的源图不做预乘；动画格式取 `load_from_memory`
  返回的首帧，与 Rust 调用点一致。

### `nativeOfficeText` 行为清单

Rust 来源：`dstu-docs/document_parser.rs::decode_text_bytes`、
`extract_plain_text_from_bytes`、`extract_csv_from_bytes`（csv-core 0.1.13）。

| 方法 | 输入校验/分支 | 返回/错误 |
|---|---|---|
| `decodeTextBytes` | BOM 优先：UTF-8、UTF-16LE、UTF-16BE（解码时去掉 BOM）；无 BOM 先严格 UTF-8，再依次尝试 GB18030、BIG5、SHIFT_JIS（`had_errors=false` 才采用）；全部失败用 lossy UTF-8 | 文本；不抛错 |
| `extractPlainText` | 先 `check_file_size`：`> 200 MiB` → `ParsingError::FileTooLarge("文件大小 NMB 超过限制 200MB")`（Display 前缀 `文件过大: `） | 解码后按 Unicode White_Space `trim()`（Rust `str::trim`） |
| `extractCsv` | 同样 200 MiB 限制；BOM 由解码去除；csv-core 默认 dialect：逗号、`\r`/`\n` 终止、`flexible(true)`、`has_headers(true)`；表头与每条记录按 `\t` 连接、行尾 `\n`，最后整体 `trim()` | CSV→TSV 文本 |
| CSV 行错误 | Rust 对 `records()` 的 `Err` 记 `warn!("CSV行解析跳过: {e}")` 并跳过 | Host 的自有状态机对已解码 UTF-8 不产生该错误（csv-core 的 `Utf8` 不会触发、`flexible(true)` 关闭 `UnequalLengths`、内存 `Cursor` 无 IO 错误），因此没有可记录的日志位置 |
| 二进制 Office | docx/xlsx/pptx/rtf/ods/xlsb 由各引擎负责 | 未注册（见阻塞节） |

- **日志**：`has_headers()` 失败在 Rust 里也是 `if let Ok(...)` 静默跳过；CSV 行
  `warn!` 的不可达性如上。`extractPlainText` 无日志。
- **副作用**：只读输入字节，无文件/DB/事件。

### `nativeOffice` 行为清单（2026-11-04 接管；同日改为同 crate WASI 引擎）

入口 `ctx.nativeOffice.extractText(fileName, bytes)`，对应 `DocumentParser::extract_text_from_bytes`
（document_parser.rs:859-910）中各二进制格式的引擎部分；文件大小、加密、ZIP 炸弹门禁仍由 L18 在调用前执行（与 Rust
`extract_*_from_bytes` 先 check 再 internal 的顺序一致）。扩展名按 Rust `Path::extension()` 取并小写；
非本服务格式抛 `OfficeParsingError('UnsupportedFormat', '不支持的文件格式: .ext')`，无扩展名为 `无法确定文件扩展名`。
错误统一为 `OfficeParsingError`，`message` 即 Rust `ParsingError` Display（如 `DOCX解析错误: Failed to read xml.`）。
`formats` 为全部 8 种格式（docx/xlsx/xls/xlsb/ods/pptx/rtf/html）；`OfficeEngineUnavailableError` 已删除。
新增错误类别 `IoError`（Display `IO错误: …`）：对应 Rust `extract_pptx_*_from_bytes` 先把字节写临时文件的 `?` 传播。
引擎为 `host/platform/native/wasm/src/office_engine.rs`：从 document_parser.rs（源提交 4525e11ac）原样复制各 `*_internal`
与 `extract_*_text`，链接与 src-tauri 相同版本的 docx-rs 0.4.19 / calamine 0.26.1 / pptx-to-md 0.2.0 / rtf-parser 0.3.0 /
html2text 0.16.7；TS 侧 `office/extract.ts` 只做扩展名分派与错误重建。wasm32-wasip1 重建作业 20261104153802-9913ff（cargo build --release，7m14s；15:38:03→15:45:18Z），产物 sha256 c2ee3e9a14868603c4ef4515bc831ff1ababc8db214d01575e8a71c905db2559，rustc 1.98.1。
**已记录偏差（架构师批准）**：`pptx-to-md` 经 `[patch.crates-io]` 指向 `wasm/vendor/pptx-to-md`（源码与 crates.io 0.2.0 相同），仅把其 `zip` 依赖去掉 C 实现的 `bzip2`/`zstd`/`xz` 压缩特性（wasm32-wasip1 无 WASI C 工具链无法交叉编译）。因此 PPTX 中以 bzip2/zstd/xz 压缩的条目报 zip `UnsupportedArchive` 错误（`PPTX解析错误: 无法打开/解析PPTX…`），Rust 原版可解码；Office 写出端只用 stored/deflate，实际文档不受影响。其余传递依赖按 src-tauri/Cargo.lock 用 `cargo update --precise` 对齐（zip 2.4.2、xml-rs 0.8.28 等，详见 wasm/README.md）。

| 格式 | 状态 | Rust 来源 | 实现 |
|---|---|---|---|
| docx | 已实现（WASI 同 crate） | `extract_docx_text`（:1447-1600）+ docx-rs 0.4.19 `read_docx` | office_engine.rs 复制 |
| rtf | 已实现（WASI 同 crate） | `extract_rtf_from_bytes`（:4012）+ rtf-parser 0.3.0 | 同上 |
| pptx | 已实现（WASI 同 crate，zip 特性偏差见上） | pptx-to-md 0.2.0（:2640-2773），`extract_images(false)` | 同上；`extractPptxPages` 对应 `extract_pptx_pages_from_bytes` |
| xlsx / xls / xlsb / ods | 已实现（WASI 同 crate） | calamine 0.26.1 `open_workbook_auto_from_rs` + `extract_excel_text`（:2479-2638，含 256 表/100 万单元格/8MiB·16MiB 文本上限） | 同上；四扩展名共用 `excel` 请求 |
| html | 已实现（WASI 同 crate） | html2text 0.16.7 `from_read(..,80)`（:2430），UTF-8 有损解码 | 同上 |

原先的 TS 逐行移植（docx-text.ts / rtf.ts / pptx-text.ts / xml-events.ts）已删除；下面 docx/pptx/rtf 语义要点仍成立
（测试未改断言），但其中“近似”“未复刻”的说明（xml-rs/roxmltree/zip 错误载荷近似、panic/死循环转抛错等）随移植删除而失效：
现在载荷即 crate 原文；Rust 会 panic 的输入在 WASI 中为引擎 panic→trap（未单独测试），不再有 TS 自造的 `RtfPanic`。

docx 语义要点（均有测试）：每个 reader 在第一个同 local name 的结束标签处返回，未知元素透明——因此
行内 `w:sdt`/`w:smartTag` 中的 run 保留，正文级 `w:sdt`、`m:t` 公式文本、`mc:Fallback`、文本框内容丢弃；
`w:hyperlink` 只取直接 run（其内 ins/del 丢弃）；`w:ins`/`w:del` 的 run 文本都输出；Text/DeleteText 先经
xml-rs 实体解码再经 `replace_escaped`（`&amp;lt;`→`<`、`&nbsp;`→空格）；CDATA 不计入；`instrText` 吞掉其后第一个
非空白 Characters（含后续 `w:t` 文本）；表格为 Markdown（首行后 `| --- |`，单元格段落 trim 后以空格连接，嵌套表丢弃）；
空白行跳过，整体 Rust trim。错误：非 ZIP / 缺 `[Content_Types].xml`、`_rels/.rels`、文档 rels、document、被 rels
引用的 styles/numbering/settings/webSettings → `Failed to read from zip.`；XML 不良构（含未绑定前缀、重复属性、
未知实体）→ `Failed to read xml.`；`bookmarkStart/End` id 非 usize（正文/段落级）→ `Failed to parse int.`；run 级
`w:sz` 非 f64 → `Failed to parse float.`；hyperlink/sdt 内同类错误按 `if let Ok` 吞掉。
**未复刻**（记录，交复核）：styles/numbering/settings/comments 等部件只校验良构，不复刻其内部类型解析错误；
xml-rs 的 UTF-16/非 UTF-8 声明编码只支持 BOM 判定的 UTF-16 与严格 UTF-8；Rust 会 panic 的输入（部件 <3 字节、
`w:sz`/`w:jc` 无属性、gridCol 宽度非数）抛普通 Error；Rust 会死循环的情形（reader 等不到结束标签即遇 EOF）抛错。

pptx 语义要点（均有测试）：slide 路径 `ppt/slides/slide*.xml` 按字节排序（slide10 在 slide2 前），页码取文件名数字（失败为 0）；
spTree 直接子元素中 `p:sp` 无 `p:txBody` → `解析PPTX失败: Unknown`，`p:pic` 无 `a:blip@r:embed` → `ImageNotFound`（整份失败，
与 crate 一致）；`p:grpSp` 等其他元素忽略（组内文字不输出）；`a:pPr` 有 `lvl` 或 `buAutoNum/buChar` 子元素即按列表渲染，
buChar 也算有序（crate 原样），条目文本自带换行再追加换行；`a:br` 不产生换行；run 末尾换行时整段换行被移除再包 `**`/`_`/`<u>`；
表格首行后分隔行；图片元素只写换行。XML/ZIP 错误的 `{:?}` 载荷为近似（`Xml("…")`、`Zip(…)`，非 roxmltree/zip 2.2.2 原文），
测试只断言前缀。

rtf 语义要点：UTF-8 lossy（保留 BOM）→ Rust `trim` → 逐字节切片；`split_first_whitespace` 把字节 0x85/0xA0 视为空白，
落在多字节字符中间时 Rust 会 panic，本实现抛 `RtfPanic`；`\'xx` 按 Latin-1 码点输出（与 crate 一致，GBK 不还原）；
`\uN` 负值 +65536、后续 ≤255 的 Unicode token 按 `\uc` 计数跳过；`\uc` ≤ -2 时 Rust `with_capacity` 溢出 panic；
错误为 `RTF解析错误: RTF词法分析失败: <LexerError Debug>` / `RTF语法分析失败: <ParserError Debug>`（Debug 字符串转义按 Rust
`escape_debug`，非打印字符近似为 Cc/Cf/Zl/Zp/Co/Cn 类）。

**依赖提案（已裁定：采纳首选方案，已于 2026-11-04 实施；以下保留原文备查）**：
- 首选：把 `docx-rs 0.4.19`、`calamine 0.26.1`、`pptx-to-md 0.2.0`、`rtf-parser 0.3.0`、`html2text 0.16.7` 原样加入
  已有 `host/platform/native/wasm`（wasm32-wasip1，decisions.md 用户授权的 F7 唯一 cargo 豁免 crate），一次构建即对全部
  8 种格式逐字节等价，并可替换本批 TS 移植。需要授权：重建该产物 + 服务器安装 `wasm32-wasip1` target（当前仅 x86_64）。
- 若不授权重建：html 需 `parse5@7.3.0`（MIT，HTML5 规范解析器，html5ever 同规范；仓库已作为传递依赖存在）作直接依赖，
  再移植 html2text 渲染器（lib.rs+render/text_renderer.rs 约 6k 行）；xls（BIFF8/CFB）、xlsb（BIFF12）、ods 无同语义 npm 实现，
  备选 `xlsx@0.18.5`（SheetJS，Apache-2.0，npm 最后版本、已停更）——单元格类型/日期/错误值表示与 calamine 不同，只能给差异清单，
  不推荐。

### `nativeProtobuf` 行为清单

Rust 来源：`dstu-media/media/bilibili_transport/grpc.rs`（prost 0.13 语义）。

| 方法 | 输入/分支 | 返回/错误 |
|---|---|---|
| `encodeDmViewRequest(aid, cid)` | proto3 标量默认值不编码（aid/cid 为 0 时省略）；字段 3 固定 `1`；字段 4 固定 `main.ugc-video-detail.0.0` | `[0][len u32be][body]` gRPC data frame |
| `decodeDmViewReply(bytes, encoding, status)` | `status` 非 `null` 且非 `'0'` → `grpc-status` 错误；总长 `<5` 或 `>2 MiB` → `subtitle-protocol`；逐帧读取 `flag`/`len`，`len >2 MiB` 或越界 → `subtitle-protocol` | `{subtitle:{tracks:[…]}}` |
| frame `0x00` | data frame；必须位于任何 trailer 之前且只能有一个 message frame | 解码 `DmViewReply` |
| frame `0x01` | 仅当 `content-encoding: gzip` 时用单 member gzip 解压；解压后 `>2 MiB` → `response-too-large` | 解压后再解码 |
| frame `0x80` | trailer；UTF-8 严格解码；必须恰好一个 `grpc-status` 且值为 `0`，否则 `grpc-status` | 结束 |
| 未知字段 | prost 规则跳过：varint/fixed32/fixed64/length-delimited；group 递归配平，嵌套深度上限 64；线型不合法 → `subtitle-protocol` | 忽略 |
| 子消息 | `tracks` 重复字段跨 data frame 合并；`lan`/`lan_doc`/`url` 严格 UTF-8；缺失 subtitle 字段 → `subtitle-protocol`（`字幕响应缺少状态，无法确认是否无字幕`）；`lan`/`url` 去空白后为空 → `subtitle-protocol` | |

- **错误文案**：`BiliError.code` 保留 `subtitle-protocol` / `grpc-status` /
  `response-too-large`，message 与 Rust 一致（`B 站字幕协议响应无效` 等）。
- **日志/副作用/事件**：无。

### `nativeTokenizer` 行为清单

Rust 来源：`dstu-util/utils/token_budget.rs`，桌面构建启用
`tokenizer_tiktoken`（`src-tauri/Cargo.toml` 的 default feature）。

| 方法 | 行为 |
|---|---|
| `encode(text, modelHint?)` | `pickEncoding` 后用 `encode(text, 'all')`（对应 `encode_with_special_tokens`）；空文本返回 `[]`；特殊 token 按原样编码 |
| `estimateTokensWithModel(text, modelHint?)` | 文本 ≤ 8,000 个 code point 走精确编码；超过后取首/中/尾各 2,000 个 code point（中间段起点 `floor((total-2000)/2)`），`maxDensity = max(head,mid,tail)/2000`，返回 `max(round(maxDensity*total*1.10), head+mid+tail)` |
| `pickEncoding` | `null` → cl100k；小写后包含 `o200k`/`gpt-4o`/`gpt-4.1`/`gpt-4.5`/`gpt-5`，或 `o1/o3/o4` 前一个字符不是 ASCII 字母数字 → o200k；否则 cl100k |
| 启发式分支 | Rust 的 `tokenizer_tiktoken` 未启用时返回 `estimate_tokens`（f32 累加）；Host 桌面始终走精确路径，`estimateTokensHeuristic` 仅作为该移动端 fallback 的等价移植导出，不在 `NativeTokenizer` 接口上 |

- **日志**：Rust 在首次调用时用 `println!` 打印一行“✅ 使用 tiktoken 精确计数”；
  这是构建特性提示，不是 `log` 记录，Host 不搬运（没有 stdout 契约）。
  `#[cfg(not(feature))]` 的“⚠️ 启发式估算”分支在桌面构建不可达。
- **crate 隐式语义**：`tiktoken-rs`、`js-tiktoken`、同源`tiktoken` WASM使用同一组
  cl100k/o200k词表；BPE合并优先级/特殊token处理不变。get_encoding缓存每种词表一次，
  与Rust进程内OnceLock相同；encode的Uint32Array转成原公共接口number[]。
  只更换编译后的BPE引擎，不改变模型选择/采样/舍入；需协调者安装`tiktoken@1.0.22`。
- **副作用**：无；首次加载词表后缓存于进程内。

### `nativePdfium` 行为清单

Rust 来源：`pdfium-render 0.9.4`（pdfium_7350）与
`dstu-docs/pdfium_utils.rs::{extract_text_from_document, load_pdf_from_byte_slice}`。

| 方法 | 输入校验/分支 | 返回/错误 |
|---|---|---|
| `open(bytes, password?)` | 空输入 → `PDF document load failed (empty input)`；`malloc` 失败 → `(out of memory)`；`FPDF_LoadMemDocument64` 返回 0 → `PDF document load failed (FPDF_GetLastError=N: <说明>)`，`PdfiumError.code=N` | `PdfiumDocument` |
| `pageCount` | `FPDF_GetPageCount` | 数字 |
| `page(index)` | 已 close → `PDF document is closed`；非整数/越界 → `PDF page index out of range: N`；`FPDF_LoadPage` 失败 → 同 load 错误文案 | 页宽高取 `FPDF_GetPageWidthF/HeightF` |
| `page.text()` | `FPDFText_LoadPage` 失败 → `PDF text page load failed`（对应 pdfium-render 的 `PdfPage::text()` 错误）；文本用 `FPDFText_GetBoundedText(0, height, width, 0)`，UTF-16LE 解码 | 文本（无文本层返回 `''`） |
| `page.render({width,height,annotations})` | 宽高必须为正安全整数，否则 `RangeError`；`malloc`/`FPDFBitmap_CreateEx` 失败 → `PDF render failed (...)`；白底 `0xffffffff`；标志 `FPDF_REVERSE_BYTE_ORDER` + 可选 `FPDF_ANNOT` | `{width,height,rgba}` |
| `close()` | 幂等；`FPDF_CloseDocument` + 释放输入缓冲 | `void` |
| `extractText(bytes)` | 按页序；页间插 `\f`；每页 `trim()`、页内 `\f`→`\n`、空页跳过；页文本失败记 debug 后继续 | 拼接文本 |

- **日志**：`extractText` 的两个失败位置对应 Rust
  `debug!("[Pdfium] Failed to get page {}: {:?}")` 与
  `debug!("[Pdfium] Failed to extract text from page {}: {:?}")`；经
  `setPdfiumLogSink` 写入 `dstu_docs::pdfium_utils`（见 WASI 日志节）。
  `open`/`render` 的错误由调用方处理，Rust 这两处不记日志。
- **副作用**：只读输入字节与 wasm 堆；无文件/DB/事件。
- **版本差异**：Rust 捆绑 pdfium_7350，适配器是 chromium/7689；API 调用与文本
  规则相同，逐像素/逐字体输出不保证一致（见依赖表）。

### `nativeFsrs` 行为清单

Rust 来源：`fsrs =6.6.2` 的 `inference.rs::next_states`、
`model.rs::forward_reviews`、`parameter_clipper.rs`。

| 方法 | 输入/分支 | 返回/错误 |
|---|---|---|
| 参数补全 | 空 → 默认 21 个参数；17 个 → 按 6.6.2 的 v5→v6 公式升级并补 4 个；19 个 → 补 2 个；21 个 → 原样；其他长度或非有限值 → 默认参数 | `clipParameters` 再按 6.6.2 的每参数上下界裁剪 |
| `nextStates(parameters, memory, retention, daysElapsed)` | `memory=null` → 初始 `{0,0}`、`nth=0`；非 null → `nth=1`；四个 rating 1..4 依次 `step`；每步 f32（`Math.fround`）；结果非有限 → `RangeError('FSRS_INVALID_INPUT')` | `{again,hard,good,easy}`，每项 `{memory,interval}`；interval 由期望保留率与 stability 计算 |
| `memoryState(parameters, item, startingState)` | 有起始状态 → 从它开始；无起始状态且无复习 → `{0,0}`；否则首条复习 `rating=0` → `{S_MIN,D_MIN}`，其余按 `init_stability/init_difficulty` 后 clamp；后续复习按 `index` 作为 `nth` 逐步 `step`；结果非有限 → `RangeError` | `MemoryState` |
| `optimize` | binding 优化器数学与 6.6.2 不一致 | 不提供（见下节） |

- **日志**：fsrs crate 的推理函数不记日志；`fsrs_review_service.rs` 的
  `info!`/`warn!` 属于 L15 调度层，不在本服务内。
- **副作用**：纯计算；无 DB/事件。
- **crate 隐式语义**：全部状态转移用 f32；`S_MIN=0.001`、`S_MAX=36500`、
  `D_MIN=1`、`D_MAX=10`；参数裁剪与 `ModelConfig::default` 的
  `num_relearning_steps=1` 上限一致。

## FSRS：与 L15 的调度分工

`dstu-learning/src/fsrs_scheduler.rs` 在 inventory 中属于 L15，权威实现是
`host/plugins/review/src/fsrs-scheduler.ts`。本 lane 已删除 `fsrs/scheduler.ts`、
`fsrs/time.ts`、`tests/fsrs-scheduler.test.ts`，并从 `fsrs/parameters.ts` 移除
`fuzzDelta/constrainedFuzzBounds/withReviewFuzz/fuzzFactorFor/sanitizeSteps/hardDelay`
及对应 `fsrs.test.ts` 用例；F7 不再导出任何学习步、重学步、逻辑日、fuzz 或
调度上限实现。L15 的 pending/ported 状态不受本 lane 影响。


## 2026-11-05 第二次 WASI 重建（架构师批准 fsrs；一次合并全部 wasm 能力）

开编前盘点 NEEDS.md 与全部 `host/plugins/*/{BLOCKERS,native-needs}.md`、`host/platform/storage/*` 中仍需 Rust crate 的能力，
一次编入：

| 能力 | 请求方 | 产物 op | TS 公开面 | 状态 |
|---|---|---|---|---|
| fsrs =6.6.2 `compute_parameters`（card_ids / enable_short_term / num_relearning_steps）与 `FSRS::evaluate` | L15（R5） | `fsrs`: `optimize` / `evaluate` | `nativeFsrs.optimize(input,{signal})` / `evaluate(params,items,{signal})` | 已提供并测试 |
| fsrs 推理 `next_states` / `memory_state`（用于核对 TS f32 移植） | 本 lane | `fsrs`: `next_states` / `memory_state` | 无（测试中作 oracle） | 已编入 |
| `chatanki_transform.rs` `bounded_regex_replace`（全文 captures_iter 预检，首超限 bytes） | L24（C4） | `regex`: `replace_all_projected` | `nativeRegex.replaceAllProjected` | 已提供并测试 |
| DOCX 结构化读取 `extract_docx_structured/_tables/_metadata/_as_spec`、`extract_pptx_metadata` | L18（parse/notes/textbooks 的 Office 读取） | `office`: `docx_structured` 等 | `nativeOffice.extractDocx*` / `extractPptxMetadata` | 已提供并测试 |
| image 0.24 `DynamicImage::write_to(Png / Jpeg(q))` 编码（rgba8/rgb8/l8/la8） | L18/F3/L02/qbank/L13（D5 PSNR 门槛） | `image`: `encode` | `nativeImage.encode`（2026-11-05 架构师裁定 D12：取代 D10 的 pngjs/jpeg-js，未重编，仅 TS 接线） | 已提供并测试 |

未编入（不是 Rust crate 能力或另有归属）：系统 OCR（macOS Vision / Windows.Media.Ocr 平台 API）、Lance 独立
compact/prune/index（npm binding）、PDFium 表单渲染（C 库）、HEIC（D5 否决）、`replace_text_in_docx`（依赖 docx-rs 写出，
TS 侧已有 D9 生成器）、pptx as_spec/tables（由 pptx Markdown 派生，纯 TS 可做，归 L18）、xlsx 读写（umya，已有 exceljs 实现）。

构建作业 20261104193343-0fb691（cargo build --release --target wasm32-wasip1，env CARGO_BUILD_JOBS=8 nice -n 10，复用 target/；12m45s，19:33:44→19:46:30Z；前置 cargo check 作业 20261104193142-49fc41 1m50s），产物 sha256 8369aa569f333801403cd65c0ceff4171c1998d82a084e6d806b7b3fc4efaa65（7,874,536 字节），rustc 1.98.1。新增依赖仅 `fsrs = "=6.6.2"`；传递依赖与 src-tauri/Cargo.lock 对齐（portable-atomic 1.13.1、portable-atomic-util 0.2.6
经 `cargo update --precise` 回退，其余新条目版本与 src-tauri 相同）。

### `nativeFsrs.optimize` / `evaluate` 行为清单

- 对应 `fsrs_review_service.rs::optimize_parameters`（:4034-4120）：`compute_parameters(ComputeParametersInput { train_set,
  card_ids, enable_short_term, num_relearning_steps, ..Default::default() })`，`progress`/`training_config` 为 None；
  `FSRS::new(params)?.evaluate(items, |_| true)`。TS 输入 camelCase（`trainSet/cardIds/enableShortTerm/numRelearningSteps`），
  `enableShortTerm` 缺省 true（crate Default）。card_ids 以十进制字符串过 JSON，接受 number（安全整数）或 bigint，越 i64 抛 TypeError。
- 错误：`FsrsError`，`kind`/`message` 为 `FSRSError` 变体名（即 Rust `{:?}`，L15 自行拼 `FSRS 参数优化失败: {:?}`）。
  evaluate 空集 → `NotEnoughData`；参数个数非 0/17/19/21 → `InvalidParameters`；card_ids 长度不齐、空 item、rating>4 → `InvalidInput`。
- 返回：optimize 为 21 个 f32；evaluate 为 `{logLoss, rmseBins}`（serde 对非有限 f32 写 null → NaN，L15 自行按 Rust `is_finite` 过滤）。
- 取消：`signal` 终止 WASI worker（`WasmCancelledError`）；Rust 命令本身无取消。
- 数值：与桌面 Rust 同源码；`compute_parameters`/`evaluate` 单线程，未用 rayon。`rmse_bins` 在 crate 内对 HashMap 求和，
  Rust 自身每次调用末位可不同（crate 注释），测试用 crate 的 1e-4 容差。wasm 的 expf/powf/logf 来自 wasi-libc（musl，
  与 glibc≥2.28 同源 ARM optimized-routines），未在 x86_64 桌面实机逐位对照，记 C 级。

### `nativeRegex.replaceAllProjected` 行为清单

`chatanki_transform.rs:466-594` 原样复制进 `wasm/src/regex_engine.rs`，差异仅：limit 由调用方传入（L24 计算
`max(1MiB, before.len())`）、错误只带 bytes、计数器为 u64（wasm32 的 usize 会在 2^32 饱和，桌面 64 位不会）。
返回 `{ok:true,value,bytes}` / `{ok:false,bytes}`（失败不含 value）；limit 非安全非负整数在 TS 侧抛 TypeError。
L24 native-needs.md 验收表第 3 行（`abc`/`(b)`/`$$[$1]`）写 bytes 7，实际值 `a$[b]c` 为 6 字节，且 Rust
`debug_assert_eq!(after.len(), projected)`（:593）要求 6；测试按 6 断言并已告知 L24。

### `nativeOffice` 结构化读取行为清单

document_parser.rs:1597-2040 / 3046-3077 原样复制进 `office_engine.rs`（去掉前置 size/encryption/zip-bomb 门禁，归 L18 先执行）。
返回值键名与 Rust `json!` 完全一致（`block_count`、`slide_count`、`total_text_length`、`lastModifiedBy`）。
已测 quirk：外链输出 `[text](rId)`（关系 id 而非 URL），锚点 `[text](#anchor)`；列表行 `"  1. "` 缩进按 ilvl、无空行；
`outlineLvl` 0 → h1；docx-rs 0.4.19 `read_docx` 不解析 docProps/core.xml，所以 metadata 全为 `""`、as_spec 的 title 为 `""`
（core.xml 存在也一样）；`total_text_length` 为未 trim 的 slide Markdown 字节和。

### `nativeImage.encode`：同 crate image 0.24 编码（D12）

`image/operations.ts::encode` 把 RGBA8 写入 WASI `/out/input`，引擎执行 `DynamicImage::ImageRgba8(..).write_to(..,
ImageOutputFormat::Png | Jpeg(q))`（与 docx_handout.rs:119/415、exam_engine.rs:387、media.rs:111、file_manager.rs:141 等同一编码器），
quality 先 `trunc` 再夹到 1..=100（crate 内同样 clamp）；JPEG 由 crate `to_rgb()` 丢 alpha；错误文案为 crate `ImageError` Display
（原 TS 对 >65535 的预检已删，由 crate 报同一文案）。删除 `image/encode-worker.mjs`；编码仍在 worker 线程（WASI worker）中执行，
不阻塞 Host 计时器。由于与 Rust 为同一 crate 同一源码，D5 的 PSNR 门槛按构造满足（输出字节由同一实现产生）；
剩余差异只可能来自 wasm 与桌面目标的浮点 libm（JPEG DCT 为整数/f32 算术），由 X7 差分在三平台确认。
D12 正文（`docs/dev/electron-migration/decisions.md`）与 root `package.json` 移除 pngjs/jpeg-js 不在本 lane 允许路径内，交架构师落笔。

### 已知偏差（架构师裁定）：同步 `nextStates/memoryState` 的 f32 移植与 crate 不逐位一致

新 oracle（crate `next_states/memory_state`）抽检样本集每 40 条（作业 20261104195914-33f9d7）：memoryState 8/358 不同
（最大 13 ulp），nextStates 2/358 不同（最大 10 ulp）。原因：`fsrs/model.ts` 用 `Math.exp/pow`（f64 再取整），crate 用
libm `expf/powf`（非总是正确舍入），差异经多步累积放大。crate 自带向量（test_next_states）仍逐位相等。修复路径二选一：
在 TS 中移植 musl/ARM optimized-routines 的 expf/powf/logf（f64 内部运算，可逐位复刻），或 L15 改用异步 crate 路径。
该缺口不影响 optimize/evaluate（二者完全在 crate 内）。

**裁定（2026-11-05）**：记为已知偏差，不移植 libm。依据：Rust 的 `f32::exp` / `f32::powf` 编译为对平台 libm
（`expf`/`powf`）的调用，macOS（Apple libm）、Windows（UCRT）、Linux（glibc）实现不同且都不保证正确舍入，
因此 Rust 桌面版自身在三个平台之间就不逐位一致，“逐位等于 Rust”没有唯一目标。接受界限 16 ulp（实测最大 13 ulp），
`tests/fsrs-optimizer.test.ts` 以 crate 为 oracle 对样本集每 40 条断言 ≤16 ulp；X7 差分在三平台实测确认。

## FSRS 优化器：binding 与 `=6.6.2` 不一致（历史记录，已由上节同 crate 实现取代）

2026-11-04进一步检查历史npm版本（不运行Rust）：

- `binding0.5.0` / `0.6.0-beta.0` 内嵌fsrs-rs `999b8b0`（6.5.0）：
  training.rs仍按best validation epoch选参数，6.6.2返回最终epoch，故不能替换。
- `0.6.0-beta.2` 内嵌`48b2ff3`（6.6.2）：analytic/dataset/parameter_initialization/
  parameter_clipper与6088949逐文件一致；training仅增加observer，模型差异是初始化
  方法提取，推理差异主要新增card-id evaluation。因此其训练数学确实最接近目标。
  **仍不能覆盖L15真实调用**：该npm `ComputeParametersOptions`没有`cardIds`，
  FSRSBindingItem构造器也只有reviews，无法传入Rust FsrsReviewService:4074的
  `card_ids:Some(card_ids)`；不能悄悄改为None（分组窗口/批次训练路径不同）。
- `beta.3/.4/.5` 内嵌`f934b88`，已含`ADAM_BETA_1:f32=0.70` / `0.98`；
  稳定版d7f337b同理。不能为了新绑定的cardIds接口接受变化的训练数学。

（历史结论，已取代）因此当时维持optimize未注册；所缺原生能力现在精确为“FSRS6.6.2训练数学 + card_ids公开入参”
的同一绑定。近似版本未写入生产依赖申请，也未把小数据默认参数测试充作完整训练等价。

`@open-spaced-repetition/binding@0.6.0` 的 wasm 内嵌路径为
`fsrs-rs-71fa07c6678f7750/d7f337b/...`；`fsrs 6.6.2` 的
`.cargo_vcs_info.json` 是 `6088949b99d44f46f5328fd7289d209b9a842b68`（tag v6.6.2）。
`d7f337b` 是引入 FSRS-7 的大改，FSRS-6 推理路径保持等价：

- `FSRSBinding.nextStates` 用 `inference.rs::tests::PARAMETERS` 的 19 参数向量
  验证，`again/hard/good/easy` 的 stability、difficulty、interval 与
  `fsrs/model.ts` **逐位相等**（`fsrs-service.test.ts`）。
- `model_v6.rs` 的 `power_forgetting_curve_scalar`、`next_state_scalar`、
  `check_and_fill_parameters_fsrs6` 与 6.6.2 的同名公式一致。

优化器不满足等价条件，差异在 `training.rs`：

- `HostAdam` 从 6.6.2 的 f64 矩估计、`beta1=0.9`/`beta2=0.999` 改为 **f32**
  矩估计、`ADAM_BETA_1=0.70`/`ADAM_BETA_2=0.98`、f32 epsilon。
- L2 权重改为 `training_v6::PENALTY_W_L2 = 0.5` 再乘 `gamma`；6.6.2 的
  `add_l2_gradient` 直接使用 `gamma`（默认 1.0）。
- 解析梯度在 `fsrs6_batch_grad` 中逐元素 `f64 -> f32` 后才进入 Adam；
  6.6.2 全程 f64。
- `compute_parameters_inner` 只拒绝 `is_infinite()`，不再拒绝 NaN；
  6.6.2 检查 `!is_finite()`。

这些差异会改变每个 epoch 的参数轨迹，不能把 binding 的输出当作 6.6.2 的
优化结果。小于 8 条/小于 64 条训练集时 binding 与 6.6.2 都直接返回初始化参数，
可能偶然一致，但真实数据集会进入上述 Adam 路径，因此不注册“仅小数据集正确”的
`optimize`。若未来 binding 回到 6.6.2 的优化器数学，再补 Rust 输出向量并注册。

## 尚未实现的能力与真实阻塞

### 2026-11-04 Office 生成行为清单

DOCX 来源：document_parser.rs:2151–2321、docx_handout.rs:29–400。
`nativeOfficeWriter.generateDocx(spec)` 用 `docx@9.15.2` 生成OOXML，业务VFS交付不搬到平台。
输入采用 serde_json::Value 的字段提取默认：非字符串取空、非数组取空、无符号level默认1。
默认模板：标题Heading1/48半磅；heading≤6，level0保持Heading0与24半磅；paragraph24半磅，
bold/italic/left|center|right|both；table只保留字符串单元格；list为普通文本前缀（不是自动编号）；
code20半磅/Courier New；pagebreak；未知块有字符串text则普通段落。
handout/official：A4 11906×16838 twips，页边2098/1984/1587/1474；西文Times New Roman，
东亚仿宋；正文32半磅、exact560、首行640、both；标题44宋体居中、段前240/后480；
subtitle/date32楷体居中；heading一级黑体/二级楷体/其他加粗仿宋，keepNext；note楷体，
caption24楷体居中；列表●或序号；table21半磅，表头黑体粗体居中，表宽8845twips；
code按Rust lines逐段；未知块非空text正文。图片先严格Base64（允许data URL/White_Space），
同crate解码、最大边2000 Triangle、PNG重编码、按9525EMU/px限制版心（整数除法）；
成功居中+caption keepNext，失败按Rust静默降为[alt]/[image]，图注仍保留。
无日志、DB、事件或事务；生成错误保留“DOCX解析错误: DOCX 生成失败: …”上下文，
库错误部分来自npm引擎，不冒充docx-rs Display；ZIP字节/关系ID/metadata不要求相等。

PPTX 来源 document_parser.rs:2773–2887 / ppt-rs 0.2.14：title默认Presentation；
title页subtitle为一个bullet，content仅取字符串bullet，table列数取headers/首行最大/至少1，
总宽8000000EMU均分、非字符串cell为空，unknown/blank仅有标题；空slides创建一张标题页。
PptxGenJS 4.0.1 写10×7.5in（9144000×6858000EMU），44pt粗标题/28pt要点；表格不自动分页。
无日志/事件/DB，错误保留PPTX生成上下文；文本/表格/页数尺寸等价，不声明theme关系ID恒等。

XLSX 来源 document_parser.rs:3185–3340 / umya-spreadsheet 2.3.3：非空sheets否则spec自身；
最多256表，名称31码点；第一表默认Sheet1，后续空名SheetN；headers存在即占一行并粗体；
rows必须数组，≤16384列，沿用原源码1048575减header计数的行限制（不修off-by-one）。
单元格仅string/number/bool/null；累计≤1000000、每格UTF8≤8MiB、总文本≤64MiB。
移植umya guess_typed_data 的空值/bool/error/number识别，数据行先parse f64；非有限数的
OOXML拼写由ExcelJS决定，与umya实产物尚无动态向量，不声明该库Display逐字一致。
写出通过有界Writable限制200MiB（不是生成超大Buffer后才检查）。无日志/事件/DB。
库错误加“Excel解析错误: XLSX 生成失败: …”；安全读取/编辑preflight归L18。

`nativeOfficeWriter.editXlsxCells` 对应document_parser.rs:3452–3485,3559–3598：
前置L18门禁后接收bytes，最多10000编辑，sheet/cell UTF8长度255/32，单值8MiB/总64MiB；
精确区分工作表名大小写；缺表warn `[DocumentParser] XLSX 编辑：工作表 'X' 不存在，跳过`；
赋值按parse-f64/umya typed-data规则，覆盖旧formula；返回真实bytes和editCount。
序列化200MiB硬上限，保存错误保留“XLSX 保存失败”上下文。F7不绕过L18的encryption/
ZIP-bomb/fidelity门禁，也不把此codec入口标成完整DocumentParser测试已移植。

XLSX读取/替换增补（document_parser.rs:3383–3447,3487–3556,3602–3753）：
`readXlsxSpec`以第一行为headers、其余dense补空；空sheet保留空spec；`readXlsxTables`
跳过空sheet，返回sheet_name/row_count/col_count/rows；`readXlsxMetadata`返回sheet_count/
total_rows求和/total_cols最大/sheets/format=xlsx，不执行dense展开。
累计dense上限1M、单格8MiB、总输出64MiB；提前拒绝稀疏XFD1048576的展开。
按umya raw-value读取：bool大写TRUE/FALSE，formula取cached值，rich text拼接，日期转回
raw serial；合并proxy不重复顶左单元格，style-only地址计入范围。ExcelJS读取容器时的
异常上下文为Excel解析错误/XLSX读取失败；具体库Display仍需真实文档C级对照。
`replaceXlsxText`限制256条、find非空、单条find/replacement64KiB、总8MiB；规则按顺序
执行，每步按UTF8预测输出≤8MiB；只扫描已存在单元格≤1M，不遍历dense范围；累计
变更文本≤64MiB；计数是变更单元格数而非occurrence数；回写用umya typed-data规则，
保存200MiB有界。没有日志/DB/事件；读取前L18必须执行其已有安全门禁。

以下能力没有**等价**运行时实现，因此对应服务/方法未注册（已注册服务的局部缺口
单独注明）；不以 mock/stub/近似算法替换：

- `vector`：2026-11-04 Arrow18.1.0已安装，新增真实 `dstu.vector` provider。
  `createTableWithSchema` 接受业务方显式列/schema（f32固定长向量、可空性、Int64无损bigint），
  不根据表名猜业务schema，不复制L12的VFS/legacyKB/chat建表逻辑。数据存储版本显式2.0，
  与Rust lance0.37稳定格式一致。connect按绝对目录缓存，失败不缓存；close释放并移除，
  provider卸载关闭连接；openTable保留原接口“不存在抛库错误”，L12自己转null。
  append不merge；filter/select/limit/metric/bypassVectorIndex/refineFactor均委托同源绑定，
  ArrowInt64原样bigint，向量转number[]；metadata不改写。
  C2增量实际1792/2560维测试发现：Node table.add的fromDataToBuffer(schema)会把错维数组
  静默转成固定长度（短数组补值/长数组截断），原测试Node/Electron均exit1。Rust VFS
  build_batch:1048–1055先检查长度并拒绝，之后才构造FixedSizeListArray；平台必须保持该
  schema不变量而不能依赖JS转换。现在add先从真实table.schema读取FixedSizeList列，
  逐批校验实际数组长度，错维在任何write前抛RangeError；错误标明列/expected/got，
  不复制L12业务表/错误封装。混合批次尾行错维也不写入前面的合法行。成功仍普通append。
  `schema/addColumns/createIndex/fullTextSearch/optimizeAll/hasTableDirectory`均真实执行。
  FTS完全沿Rust的ngram2..4/nonprefix/max64/lowercase/noStem/noStop/asciiFolding；
  scalar btree/bitmap；IVF-PQ cosine；replace=false。日志由L12业务层保持，原生binding自身
  的Lance日志不改文案。写盘在各原生操作完成时；不访问SQLite、不发事件。
  **待L12接线**：createTable(name,dimension)须改用自己的schema调用createTableWithSchema；
  fullTextSearch返回原始_score，search返回_distance，L12负责VfsLanceSearchResult映射；
  scanMetadata用query({columns:['metadata']})。不能把本adapter的原始行伪装成业务结果。
  **真实binding缺口**：@lancedb/lancedb0.22.1 NativeTable.optimize仅暴露all-actions，
  没有Rust独立Compact/Prune/Index。只发布optimizeAll，不把compact静默替换成all；
  L12的三步优化还需原生binding暴露独立动作（node_modules/.../dist/native.d.ts:514）。
  新平台插件需协调者重新生成desktop profile（本lane禁止写host/profiles）。
- （**已被 2026-11-04 `nativeOffice` 行为清单取代**：8 种格式现由同 crate WASI 引擎提供；以下为当时的历史结论，`extractTables` 仍未提供。）
  `nativeOffice.extractText/extractTables`：`exceljs@4.4.0`/`jszip@3.10.1` 已在
  `package.json` 声明，但它们只覆盖 xlsx/zip 容器的一部分，不能覆盖 Rust
  `docx-rs`/`umya-spreadsheet`/`zip` 的 docx/pptx/rtf/ods/xlsb 语义与错误路径；
  缺少 docx/pptx/rtf 引擎，因此仍不注册二进制 Office 抽取。
  下列为本轮逐格式核查的不可行结论（在现有依赖与禁止编译/装包约束内），不是未来永远不可实现：

  | 格式 | Rust必须保留的语义 / 缺失能力 |
  |---|---|
  | docx | document_parser.rs:1447–1595，docx-rs0.4.19读取document children，段落Run/Hyperlink/Insert/Delete及Text/DeleteText/Tab/Break，TOC，表格按最大列补空并首行后插Markdown分隔；npm docx9.15.2是生成器，当前没有同等读取树 |
  | xlsx/xls/xlsb/ods | :2479–2632，calamine0.26.1自动识别四格式，worksheet_range含范围/日期序列6位小数/小写bool/#ERR:Debug、首行表头判断及字节/单元格上限；ExcelJS只读xlsx，已有readXlsxTables按umya的原始值/坐标语义（大写bool、日期原始序列等），不能改名复用当calamine |
  | pptx | :2640–2751，pptx-to-md0.2.0 parse_all→convert_to_md，extract_images(false)，bytes路径先写临时文件；pptxgenjs4.0.1只生成，没有该解析/Markdown引擎 |
  | rtf | :4012–4025，rtf-parser0.3.0 Lexer::scan→Parser::parse→get_text（不同词法/语法错误上下文）；当前没有该解析器，不能用去控制符正则替代 |
  | html | :2430–2441，UTF8有损解码后html2text0.16.7 from_read(...,80)，含布局/宽度/链接等渲染行为；当前没有同等引擎，jsdom的textContent不等价 |

  `nativeOffice`依旧只是待实现契约；index.ts只provide nativeOfficeText/nativeOfficeWriter，
  不发布统一抛unsupported或空字符串的伪provider。无法承诺provide日期；最直接的同算法路径
  是由获授权产物维护方提供上述锁定crate和对应胶水的预编译抽取入口（目前WASI main.rs仅有
  regex/audio/image/starlark四引擎，完全没有Office op），或另行批准成熟抽取库后按格式差分验证。
  `extractTables`的docx/xlsx/pptx结构抽取也必须实际提供，不用已有XLSX-only方法冒充全能力。
  file-size/encryption/ZIP-bomb与路径/base64/教材业务编排仍归L18；此结论已通知L18/C2。
- `nativePdfium`候选诊断已提供、JPEG可由nativeImage编码；仍缺表单数据绘制
  （pdfium-render默认do_render_form_data=true，而@embedpdf包的公开FPDF wrapper未导出
  FPDFDOC_InitFormFillEnvironment/FPDF_FFLDraw/FORM_OnAfterLoadPage等完整表单生命周期）；
  不能把annotations=true当form-data已绘制。L18页间取消/300DPI编排归其page_rasterizer。
  按D5，PDFium7350与7689代表性真实PDF golden差异仍为C级：仓库只有Windows/macOS/
  Android旧引擎，没有可在本Linux执行的7350 .so；当前测试使用合成PDF，不能冒充两版本对照。
- `nativeFsrs.optimize`：见上节。

### WP-058 / D29：`mindmapXml`（roxmltree 0.20.0）——WP-095 已交付（下节），本节保留为原阻塞记录

需求：L13 `host/plugins/vfs/native-needs.md:3–10`，类型 `host/plugins/vfs/src/tools/mindmap-import-xml.ts:5–12`
（`MindmapXmlParser.parse(text): MindmapXmlNode`，**同步**；`importToolMindmap` 与四个格式函数均为同步），
消费方 `host/plugins/vfs/index.ts:216–217` 经 `ctx.inject([... 'mindmapXml' ...])` 取用。Rust 调用点
`src-tauri/src/chat_v2/tools/builtin_resource_executor.rs:3252,3437,3822,3944`（文件末次提交 9338197b5），
均为 `roxmltree::Document::parse(text)`，即 `ParsingOptions::default()`；`src-tauri/Cargo.lock:10606` 为 roxmltree 0.20.0。

**既有产物核查（结论：无可复用入口）**
- `wasm/f7-native-wasm.wasm`（sha256 见 `.sha256`，rustc 1.98.1）的 Wasm 导出只有 `memory`、`_start`、`__main_void`；
  请求分派 `wasm/src/main.rs:50–60` 只有 regex/audio/image/office/starlark/fsrs 六个 engine，`office_engine.rs:891–917`
  只有 Office op，没有任何返回 XML 树的 op。
- `wasm/Cargo.lock:1886` 的 roxmltree 0.20.0 只是 `pptx-to-md` 的传递依赖（`Cargo.lock:1634–1642`），在
  pptx 解析内部使用，release 配置 `lto = true`/`strip = true`，没有对外可达的通用解析路径。
- 宿主侧 `wasm/loader.ts:87` 只有异步 `runWasm()`（Worker 中执行），而 L13 接口是同步的；新增 op 还需要一个
  同步执行入口（同一已编译 module，在调用线程用 `node:wasi` 运行，输入受 L13 `MAX_IMPORT_BYTES = 32 MiB` 约束）。
  这部分是 F7 TS 胶水，构建获批后由本 lane 完成，不需要 L13 改接口。

**roxmltree 0.20.0 必须保留、而现有 npm 解析器做不到的行为**（源码 `roxmltree-0.20.0/src/parse.rs`）
- `ParsingOptions::default()` 中 `allow_dtd: false`（:345），任何 `<!DOCTYPE` 返回 `Error::DtdDetected`，Display
  `XML with DTD detected`（:253）。
- CDATA 并入相邻文本节点（`append_text` :1030–1052 在 `after_text` 时拼接），`<r>a<![CDATA[b]]>c</r>` 只有一个
  文本子节点 `"abc"`；CDATA 中 `\r` 规范化（:1000–1027）。
- 错误 Display 带 `TextPos`（`行:列`）位置，模板如 `expected '{}' tag, not '{}' at {pos}`、`unknown entity reference '{}' at {pos}`、
  `attribute 'a' at … is already defined`、`an unknown namespace prefix 'x' at …`、`the document does not have a root node`（:186–275）。
- 节点只有 Root/Element/PI/Comment/Text 五类，XML 声明被跳过（`lib.rs:78–92`）。

对照（作业 20261105151410-b5b855，`node_modules/@xmldom/xmldom` 0.8.15，仅为 electron-builder 传递依赖）：
CDATA 拆成 `text "a"`/`cdata "b"`/`text "c"` 三个节点；接受 `<!DOCTYPE map>`；`&foo;` 只打印 error 后保留字面文本；
`<a></b>` 只打印 warning 后返回 `<a>` 树；未绑定前缀 `x:a` 不报错；重复属性抛 `Attribute a redefined`；空串返回 null 文档。
因此 xmldom 不等价；jsdom/saxes 同样不复现 DTD 拒绝与 Display 文案。不申请 npm 库，也不手写解析器。

**最窄构建需求（交架构师/产物维护方批准后由 F7 按 `wasm/build-wasm.sh` 增量构建，不 clean）**
1. `wasm/Cargo.toml` `[dependencies]` 增 `roxmltree = "=0.20.0"`（与 src-tauri 与现有 wasm lock 同版本，lock 不新增包）。
2. 新增 `wasm/src/xml_engine.rs`，`main.rs` 分派加 `Some("xml") => xml_engine::run(&request)`。op `parse`：
   读 `request["text"]`，`roxmltree::Document::parse(text)`；失败返回 `{"ok":false,"message": e.to_string()}`（原 Display）；
   成功返回 `{"ok":true,"root": node(doc.root_element())}`，其中 `node(n)`：
   - Element：`{"kind":"element","localName":n.tag_name().name(),"attributes":[{"localName":a.name(),"namespace":a.namespace(),"value":a.value()}…（文档顺序）],"children":[n.children() 逐个 node()],"text":n.text()}`
   - Text：`{"kind":"text","localName":"","attributes":[],"children":[],"text":n.text()}`
   - Comment/PI：`{"kind":"other","localName":"","attributes":[],"children":[],"text":null}`
   该形状逐字段对应 L13 `MindmapXmlNode`；L13 的 `descendants(root)` 从根元素开始，与 Rust `doc.descendants()`
   多出的 Root 节点不是元素，`find/filter(is_element)` 结果相同。
3. F7 随后：`loader.ts` 增同步执行入口；新增 `host/platform/native/xml/` provider `mindmapXml`，`api.ts` 增
   `declare module` 的 `mindmapXml: MindmapXmlParser`（类型从 L13 api 引入，不另造）；测试用真实入口跑上面
   的 CDATA/DTD/实体/命名空间属性/错误 Display/节点顺序向量，以及 OPML/.mm/.xmind/.mmap 原样本。

在此之前不 provide `mindmapXml`；`host/plugins/vfs/index.ts:216–217` 的 import-only `BuiltinResourceExecutor(xml, true)` 因 inject 依赖未满足而不注册，不发布 jsdom 或正则替身。

### WP-095：`mindmapXml` 已交付（C1 批准的一次增量 WASI 构建）

- 构建：`wasm/Cargo.toml` 增 `roxmltree = "=0.20.0"`；`wasm/Cargo.lock` 只多根包依赖行 `"roxmltree"`（包本身原已在 lock，
  版本/校验和不变）。命令 `env CARGO_BUILD_JOBS=12 cargo build --offline --release --target wasm32-wasip1
  --manifest-path host/platform/native/wasm/Cargo.toml`，作业 20261105165453-467913（rust 类）exit 0，6m39s，复用已有
  target（只重编 `f7-native-wasm` 本身）。产物按 `build-wasm.sh` 拷出：sha256
  `6bd0472ce3e46e64888a45d6f3cbe8b248de4dc1cd07007016b41a065653d272`，rustc 1.98.1。
- 引擎：`wasm/src/xml_engine.rs`，`main.rs` 分派 `Some("xml")`。op `parse` 调 `roxmltree::Document::parse(text)`
  （默认 `ParsingOptions`）；失败 `{"ok":false,"message": e.to_string()}`（原 Display，含 `行:列`）。成功时返回
  `doc.root_element().descendants()` 的**先序扁平列表** `nodes`，每项带 `parent` 下标（根为 -1），字段同上节 `node(n)`
  （Element 的 `text` 为 `n.text()`，即首个子节点为文本时的文本；Comment/PI 记为 `other`、`text:null`）。与上节草案的
  嵌套形状相比只改了传输形状：serde_json 编码与 JS 重建都不随嵌套深度递归，TS 侧按 `parent` 迭代重建成 L13
  `MindmapXmlNode` 树，字段值不变。
- Host：`wasm/loader.ts` 新增 `runWasmSync(request)`（同一 wasm 文件，`new WebAssembly.Module` 同步编译后缓存，
  调用线程上 `node:wasi` 运行，同样只预打开临时 `/out`，stderr 同样转给 `setWasmLogSink`；无 worker，故不可取消，
  L13 接口本身同步、无 signal）。`xml/index.ts` 的 `mindmapXml.parse` 失败时抛 `Error(message)`，由 L13 加
  `OPML 解析失败: ` 等前缀，与 Rust `format!("…: {}", e)` 一致。`xml/api.ts` 从 `host/plugins/vfs/api.ts` 引入
  `MindmapXmlParser`/`MindmapXmlNode`（不另造），并 `declare module` `Context.mindmapXml`；`index.ts` 在 `dstu.native`
  的 `provides` 中注册并 `ctx.provide('mindmapXml', mindmapXml)`。
- 测试 `tests/xml.test.ts`：经 `createTestHost({ plugins: [native] })` 取 `ctx.mindmapXml`，向量取自 roxmltree 0.20.0 自带语料
  `tests/files/*.xml/.yaml`（只用不含 `<!DOCTYPE` 的文件，其结果与语料 harness 的 `allow_dtd:true` 无关）：CDATA 合并
  （cdata_001/002/004/005）、CDATA `\r` 规范化、字符/预定义实体（text_009、attrs_003/004）、命名空间属性与文档顺序
  （ns_002/005/007）、节点顺序与声明/外部注释丢弃（tree_001、text_010）、15 条错误 Display（attrs_err/elems_err/
  entity_err/ns_err/tree_err），以及 DTD 拒绝、空串 `NoRootNode`、非 BMP 文本，和 L13 `mindmap-import.test.ts` 的
  OPML/.mm/.xmind/.mmap 样本树。Node 作业 20261105171145-909371 11 passed；Electron（`ELECTRON_RUN_AS_NODE=1`）作业
  20261105171145-05b4f1 11 passed。原 native 全目录回归作业 20261105170416-7af0aa：30 文件通过（六引擎 regex/starlark/audio/image/
  office/fsrs 全绿），唯一失败是本文件深度断言的错误类别，已按实测改正后由上两作业复验。

**已知偏差（实测，未修）**：roxmltree 的 tokenizer（`tokenizer.rs` `parse_element`→`parse_content`）按嵌套层递归。
直接用 `node` 运行时实测最多 3000 层，3001 层起 guest 的 1 MiB 栈溢出，`parse` 抛 `WebAssembly.RuntimeError`
（`memory access out of bounds`）；vitest 的 Node 与 Electron worker 中 V8 宿主栈先耗尽，5000 层抛 `RangeError: Maximum call
stack size exceeded`（作业 20261105170416-7af0aa / 20261105170417-8d370b），3000 层两者都能解析。两种情况都是同步抛错，
下一次调用正常；L13 会包装成 `OPML 解析失败: …` 返回。Rust 原生在同类输入下会在更深处耗尽线程栈并
中止整个进程（阈值未测，不运行 Rust）。L13 的 `MAX_MINDMAP_DEPTH = 100` 在解析之后才检查，所以合法导图不受影响。
改栈大小需要再次构建，不在本包授权内；是否调整交 C1。

### WP-085 / D17 / D-022：`nativeSqliteBusy`（同一 better-sqlite3 连接上的 `sqlite3_busy_handler`）

**实际产物（已提交，仅 linux-x64）**

- 接缝：better-sqlite3 13.0.3 打开连接时已经执行 `sqlite3_db_config(SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 1)`
  （`node_modules/better-sqlite3/src/objects/database.cpp:170`），并公开 `Database#loadExtension(file, entryPoint)`
  （`database.cpp:371-396`）。SQLite 把**这个连接自己的** `sqlite3*` 和它的 API 表 `pApi` 传给扩展入口，
  所以入口里 `pApi->busy_handler(db, cb, state)` 装的就是同一指针上的 handler。没有 fork 驱动，
  没有改 node_modules/vendor/package.json/构建配置，也没有另开连接。
- `sqlite-busy/busy_handler.c` 编出一个文件，同时充当 N-API addon（导出 `arm`/`disarm`）和 SQLite 扩展
  （入口 `sqlite3_f7busy_init`）。Node 的 `dlopen` 和 SQLite 的 `unixDlOpen`（`sqlite3.c:47239`，
  `RTLD_NOW|RTLD_GLOBAL`）用同一个绝对路径，所以拿到同一个已加载映像。`arm` 把 JS 函数引用写进每线程一个的
  槽，入口读取这个槽；入口在没有 arm 时返回 `SQLITE_ERROR`，消息为 `f7 busy handler: extension entry point
  called without arm()`，better-sqlite3 抛 `error during initialization: …`。这条只在 smoke 脚本里实测过：
  TS 包装总是先 arm，vitest 走不到它。
- 回调：SQLite 在命中锁的 `sqlite3_step` 里同步调用 `busy_callback(state, nBusy)`，线程就是连接所在的 JS
  线程。回调打开 handle scope，用 `napi_call_function(global, fn, [priorInvocations])` 调用，返回 bool 的值。
  `priorInvocations` 就是 SQLite 的 `nBusy`，和 rusqlite `busy_handler_callback(p_arg, count)` 收到的
  `count` 相同（rusqlite 0.40.1 `busy.rs:57-69`）。
- 释放：状态挂在 `sqlite3_set_clientdata(db, "f7.busy_handler", state, destroy_state)` 上。替换时先把
  `busy_handler` 指向新状态，再 `set_clientdata`，旧状态的析构在这一步调用（`sqlite3.c:191303-191340`）。
  传 null 时执行 `busy_handler(db,NULL,NULL)` 并 `set_clientdata(...,NULL)`。close 时 `sqlite3_close`
  按 `sqlite3.c:188699` 调析构。三种情况都会执行 `napi_delete_reference`。env 销毁时由
  `napi_set_instance_data` 的 finalizer 删除剩余引用并断开状态，之后的 close 只释放内存，迟到的回调返回 0。
- TS：`sqlite-busy/api.ts` 定义 `NativeSqliteBusy.setBusyHandler(db, handler | null)`，加
  `Context.nativeSqliteBusy` 增强（WP-161 删去 `throwPendingHandlerError`，见下）。`sqlite-busy/index.ts` 用
  `createRequire` 加载 `prebuilds/f7-sqlite-busy.<platform>-<arch>.node`。没有预编译产物的平台抛
  `nativeSqliteBusy: no prebuilt f7-sqlite-busy binding for <platform>`。`dstu.native` 已 provide 这个服务。
  WP-161 起，用户 handler 直接交给原生层：抛错时 `busy_callback` 用 `napi_get_and_clear_last_exception`
  清掉 JS 异常并向 SQLite 返回 0（false）；返回值不是 `true`（含非 boolean）也按 0。不保存、不重抛。
- 构建：`sqlite-busy/build.sh`，作业 20261105175214-71fa3e，exit 0。编译参数为
  `cc -std=c11 -O2 -fPIC -shared -fvisibility=hidden -Wall -Wextra -Werror`，头文件来自 Node 26.5.0
  `include/node`（N-API 8）和 better-sqlite3 自带的 `deps/sqlite3/sqlite3ext.h`（SQLite 3.53.4）。不链接
  SQLite，也没有下载任何东西。产物 16840 B，sha256
  `e9ea87e83e8ea655fd8ebe417860e0b78f7fde7b9faf120fc6ba722190664474`。打包不需要改配置：
  `electron/electron-builder.config.cjs` 设了 `asar:false`，`files` 也已包含 `host/**/*`。
- 测试：`tests/sqlite-busy.test.ts` 加 worker `tests/fixtures/sqlite-busy-worker.ts`。WP-085 时 12 条
  （Node 作业 20261105175747-1ca4af、Electron 45.2.1 作业 20261105175747-caeb47 各 12 passed）；WP-161 后
  13 条（Node 作业 20261105185220-0f8ca6、Electron 作业 20261105185220-7b0ba0 各 13 passed）。各条覆盖：
  - 握手：worker 在 handler **内部**发出 `waiting`，此时它的 `inTransaction=false`，`priorInvocations=0`。
    主线程随后 `COMMIT` 成功，说明 contender 不持读锁。用 Atomics 放行后，contender 读到 count=1，
    invocations 为 `[0]`。这条在形状上对应 Rust `state.rs:597-664`，但它不是 L20b 那条的移植。
  - 取消：control=2 时 handler 返回 false，worker 得到 `SQLITE_BUSY`，writer 的锁仍然有效。
  - 返回 true 时 SQLite 重试，计数依次为 0,1,2,3 且都在同一线程；返回 false 时得到 `SQLITE_BUSY`。安装 handler
    会把 5000 ms timeout 清零。
  - 传 null 后不再调用 handler，立即 BUSY，`busy_timeout` 仍为 0。
  - `PRAGMA busy_timeout=20` 会替换 handler。
  - （WP-161）handler 抛错：这一步得到 `SQLITE_BUSY`/`database is locked`，不是抛出的值；随后普通语句和下一次
    `setBusyHandler` 都正常，说明没有遗留的 JS 异常。handler 内重入 `setBusyHandler` 时，绑定抛
    `TypeError: This database connection is busy executing a query`。
  - （WP-161）handler 抛错时 `PRAGMA wal_checkpoint(RESTART)` 不报错，返回 `busy = 1` 的结果行，handler 只被调用一次。
  - （WP-161）非 boolean 返回值（如 `1`）按 false：BUSY，调用一次，不报错。
  - （WP-161）抛错 handler 之后替换的新 handler 正常安装并在下一次争用时被调用（计数 0,1）。
  - replace、null、close 三种情况下，`WeakRef` 加强制 gc 能证明引用已释放；释放前同样做 gc 作为对照，确认
    native 引用让函数保持存活。
  - 已关闭的连接和非函数参数各自得到绑定的错误。
- 许可：`busy_handler.c` 是本仓库代码。`sqlite3ext.h`/`sqlite3.h` 属于公有领域，编译时只从 better-sqlite3
  读取，不复制进仓库。`node_api.h` 是 MIT。运行时依赖 better-sqlite3（MIT），已经是 root 依赖。

**与 Rust/D-022 的差异（如实记录）**

- 异常（WP-161 按 C1 新裁定改为与 Rust 一致）：rusqlite 0.40.1 `busy.rs:57-60` 用
  `catch_unwind(|| handler_fn(count)).unwrap_or_default()`，panic 视为 false，不延后重抛。WP-085 brief 写的
  "语句返回后安全重抛"是协调 brief 的错误，已撤销。现在原生层清掉 JS 异常并返回 false，后续 step 结果就是
  SQLite 自己的结果（一般 `SQLITE_BUSY`；`wal_checkpoint` 返回 busy=1 的正常行）。F3 不需要在
  get/all/run/pragma 之后加重抛包装。非法参数、已关闭连接、重入调用仍由 `setBusyHandler` 同步抛绑定错误。
  剩余差异：Rust 的 panic 会先经过进程 panic hook（`src-tauri/src/crash_logger.rs:30` 写崩溃日志并上报
  Sentry），再被 catch_unwind 吞掉；JS 异常没有对应的全局 hook，本服务不记录。dstu-sync 的 handler 是普通
  `fn(i32)->bool`，正常不会 panic。
- `PRAGMA busy_timeout` 替换之后，SQLite 不发通知。函数引用要等到下一次 `setBusyHandler` 或 `close()` 才释放。
  如果 F3 在自己的 `busy_timeout` pragma 包装里先调用 `setBusyHandler(db, null)`，释放就是即时的。
- 每调用一次 `setBusyHandler`，就走一次 `loadExtension`。连接的扩展句柄表因此多一项（引用计数上的 dlopen），
  close 时由 `sqlite3CloseExtensions` 释放。这个调用频率很低，不影响行为。
- 只能在连接空闲时调用，这是 better-sqlite3 自己的 busy/iterators 守卫。Rust 那条测试是在执行语句之前
  安装 handler 的，不受影响。

**方案（未交付，需授权）**

| 项 | 需要 | 授权 |
|---|---|---|
| darwin-x64 / darwin-arm64 产物 | 在 mac runner 上运行 `build.sh`（`-dynamiclib -undefined dynamic_lookup`）；PLATFORMS 加上这两项；在 mac 上跑同一测试文件的 Node 与 Electron 版本 | C2 目标 runner（无下载） |
| win32-x64 产物 | MSVC `cl /LD`，加 Node 的 `node.lib`，或用 delay-load hook 把 `node.exe` 重定向到宿主 exe（node-gyp `win_delay_load_hook` 做法，否则 Electron 下找不到 napi_*）；需要 node-gyp 头文件包/`node.lib`（下载） | C2：下载头文件 + Windows runner |
| F3 接线 | `Connection.setBusyHandler(handler)` 委托给 `nativeSqliteBusy.setBusyHandler(this.raw, handler)`；StartupDatabase 公开接口（WP-161 后不需要执行后重抛） | F3（storage） |
| L20b S06 | 用 F3 的接口移植 `tombstone_sequence_waits_for_writer_before_reading` | L20b，等 F3 |

本节不表示 D17 已经 provided，也不表示 S06 已经 ported。linux-x64 能力已经真实可用，但 mac/win 产物、F3 接线和
L20b 移植都没有完成。

## WASI 引擎（已实现）

2026-11-04 worker增补：Rust的spawn_blocking执行模型对应每次WASI请求一个worker_threads
worker（没有新增池/队列框架）；父线程编译缓存WebAssembly.Module并clone给worker，
worker只接收原preopens/stderr路径，算法/请求JSON/重放记录不变。AbortSignal触发时
终止worker并等待exit，再读stderr/删除临时目录，绝不在WASI仍读写时清理文件。
starlark将该取消映射到原“ptc_run script error: Evaluation cancelled”；audio映射
AudioDecodeError(cancelled,已取消)。宿主call尚未返回时也响应signal，但宿主回调本身的
副作用/取消合作仍由业务owner负责；不重复call或伪造返回。音频progress仍按原产生顺序
在本次解码结束后回放（尚未变成实时流式回调），不隐瞒此剩余差异。

协调者裁定（`decisions.md` 2026-11-03）：Starlark、音频解码与原生正则不能换成
不同实现，必须把 Rust 后端使用的同一批 crate 编译成 `wasm32-wasip1` 预编译产物。
图像沿用同一原则（`sharp` 不等价），也编译 `image` crate。

- crate：`host/platform/native/wasm/`（独立 crate，不在 `src-tauri` workspace，
  自己的 `Cargo.lock`）；依赖 `starlark =0.14.2`、`symphonia =0.5.5`
  （features 与 `src-tauri/Cargo.toml` 相同）、`regex =1.12.3`、
  `image =0.24.9`（默认 features 去掉 `jpeg_rayon`；解码结果与并行版相同）。
- 构建：`host/platform/native/wasm/build-wasm.sh`；产物
  `f7-native-wasm.wasm`、`f7-native-wasm.wasm.sha256`、`toolchain.txt`
  一并入库。当前产物由 rustc 1.98.1 构建，sha256 见同名文件。
- 加载：Node `node:wasi`（`version: 'preview1'`），每次请求只 preopen 一个
  临时 `/out`（音频额外只读 preopen 源文件所在目录为 `/media`）。模块只编译
  一次，请求间复用；请求/响应走 JSON 文件，避免把大块 PCM 放进 stdout。
  打包时必须把 `f7-native-wasm.wasm` 与 `wasm/loader.ts` 放在同一目录（Host
  以 `import.meta.url` 解析），Electron 的 `asar: false` 源码布局满足这一点。
- 协议：regex/audio/image 为一次性 JSON 请求（image 的输入与 RGBA 走 `/out`
  文件，不塞进 JSON）；starlark 为“遇到宿主函数即写出
  `host_call` 并中止，宿主回填应答后从头重放”的确定性协议。
- 产物是逻辑等价而非“重新实现”：正则错误文案、Starlark 的 tick/堆/栈错误、
  Symphonia 的坏包/时间戳/重采样数值都来自同一 crate 版本。
- **日志**：wasm 内没有 logger，复制而来的 `log::warn!`（decoder 的尾部截断/
  demux 错误）与 `log::debug!`（PDFium 单页文本失败）改为 `eprintln!`/未格式化
  路径后，由 `runWasm` 捕获 stderr 并通过 `setWasmLogSink` 转发到
  `ctx.logger('dstu_media::media::decoder')`/`ctx.logger('dstu_agent::chat_v2::tools::ptc_runtime')`；
  `nativePdfium` 的单页失败经 `setPdfiumLogSink` 记 `dstu_docs::pdfium_utils` 的
  debug 日志。`dstu.native` 在 `apply` 时安装这些 sink，避免 §7 的静默丢弃。
- **执行模型**：2026-11-04已移入worker（见本节首段）；`_start`只阻塞worker，
  不占Host事件循环。打包必须同时保留`wasm/worker.mjs`、loader.ts与wasm产物。

Windows/macOS/Linux 的 Node/Electron 都支持 `node:wasi`；旧会话在mac-arm64、本次在linux-x64
运行过完整Node/Electron测试，其余两个目标仍需在发布前跑 `audio.test.ts`/`starlark.test.ts`/
`regex.test.ts`/`image.test.ts`（见 TESTMAP 的 C 级项）。

## 依赖/版本结论

| 能力 | Rust 版本 | 候选 | 状态 |
|---|---|---|---|
| LanceDB | lancedb 0.22.1 / lance 0.37.0 | `@lancedb/lancedb@0.22.1` + `apache-arrow@18.1.0` | 已实现真实provider；独立优化动作binding仍缺失 |
| Tokenizer | tiktoken cl100k/o200k | `tiktoken@1.0.22`（同发布方Rust/WASM替代纯JS核心） | 已实现并注册；原4条Rust测试完整输入/断言通过，需新依赖 |
| PDFium | pdfium_7350 | `@embedpdf/pdfium@2.15.1`（chromium/7689） | 已实现并注册；`@hyzyla/pdfium@3.0.0` 可卸载 |
| Starlark | 0.14.2 (Rust) | `starlark =0.14.2` -> wasm32-wasip1 | 已实现并注册 |
| FSRS 模型 | fsrs 6.6.2 | 本 lane 纯 TS 移植 | 已实现并注册 |
| FSRS 优化器 | fsrs 6.6.2 | `fsrs =6.6.2` -> wasm32-wasip1 | 已实现并注册（optimize/evaluate） |
| 音频解码 | Symphonia 0.5.5 | `symphonia =0.5.5` -> wasm32-wasip1 | 已实现并注册 |
| 正则 | regex 1.12.3 | `regex =1.12.3` -> wasm32-wasip1 | 已实现并注册 |
| 图像 | image 0.24 | `image =0.24.9` -> wasm32-wasip1 | 已实现并注册 |
| 图像编码 | image 0.24 PNG/JPEG | pngjs7.0.0 / jpeg-js0.4.4 | 新增依赖申请；PNG像素无损、JPEG质量/格式/大小门禁对齐，非字节恒等 |
| HEIC | libheif（移动端平台解码） | 无桌面等价引擎 | 已实现并注册（桌面按 Rust 返回 `HEIC_UNSUPPORTED_PLATFORM`） |
| 压缩 | flate2/zstd | Node 内置 zlib/zstd | 已实现 |
| protobuf | prost | 手写 codec | 已实现 |
| Office 纯文本/CSV | encoding_rs/csv-core | 内置 TextDecoder + 移植 | 已实现 |

`@open-spaced-repetition/binding@0.6.0` 要求 Node.js >=24，当前仅用于测试中的
Rust 二进制交叉核对，生产 `nativeFsrs` 不 import 它；若 Electron 内置 Node 低于
24，不能把它带入运行时依赖。

## 测试与动态证据

Host 测试：`npx vitest run -c vitest.host.config.ts host/platform/native`。
新增/更新的等价性测试：

- `tokenizer.test.ts`：cl100k/o200k token id、`pick_encoding` 家族与词边界、
  f32 启发式、8,000 字符精确路径、>8,000 字符首/中/尾采样与“稠密段不被平均掉”。
- `image.test.ts`：PNG/BMP 的宽高与 RGBA 像素、未知字节的 crate Display 文案、
  `dstu.native` 注册（BMP 是 sharp 路线无法解码的格式）。
- `pdfium.test.ts`：3 页 PDF 的页数/页尺寸、页序文本与 `\f`、RGBA 白底/蓝色矩形/
  字形像素、损坏输入、重复 close、`dstu.native` 注册。
- `fsrs.test.ts`：6.6.2 数值向量、参数补全、f32 间隔。
- `fsrs-service.test.ts`：`nativeFsrs.nextStates` 与 binding 的 FSRS-6
  `nextStates` 逐位一致；`optimize` 不存在。
- `regex.test.ts`：`regex::Error` 的逐字文案、Unicode `\w`/`\p{So}`、
  UTF-16 偏移（含非 BMP）、可选捕获组、Rust `$name`/`${1}`/`$$` 替换、
  `Regex::split` 末尾空串、内联 `(?i)`/`(?m)`。
- `starlark.test.ts`：顶层语句/JSON/StructType、宿主调用重放且每次只回调一次、
  tool failure envelope、硬错误中止、`ptc_run` 自递归拒绝、非法 JSON 参数、
  object_read/object_write 默认参数、load 禁用、callstack/heap/tick 限制、
  绝对 deadline 取消、已 abort signal、非 JSON 结果。
- `audio.test.ts`：44.1 kHz 立体声 2.5 s → 40,000 采样/2500 ms/峰值
  `0.3*32767±600`、16k 分块、进度以 1.0 结束、8 kHz probe、垃圾输入
  `media-unsupported` 含 MP4、缺失文件 `io-failed`、预取消 `cancelled`、
  三个 WASI 服务在 `dstu.native` 插件中的注册。
- `api.test.ts`：Rust 引擎版本来源（fsrs 6.6.2、starlark 0.14.2、pdfium_7350、
  lancedb 0.22.1）。

仍需真实引擎/环境才能给出的动态证据：Zstd/flate2 压缩字节与 Rust 产物逐字节对照；
PDFium 7350 逐像素/逐字体对照（当前只有 7689）；Lance 0.37 双向读写（arrow 安装后）；
FSRS 优化器 Rust 输出向量；Office 真实文档；四目标平台（win-x64/linux-x64/
mac-x64/mac-arm64）的 wasm 加载与音频/Starlark/正则测试。
