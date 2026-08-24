# Wrap-up #17：transform script 可移植资源上限

## 结论

`builtin-chatanki_transform` 的 script 模式现在把资源边界作为执行前的
fail-closed 合同，而不只依赖各平台沙箱的隐含实现。macOS Seatbelt、Linux
bwrap、Windows AppContainer/Job Object 都必须同时声明硬沙箱、断网、进程组
隔离和有限进程数；缺少任一项即返回 `script_sandbox_unavailable`，不会降级执行。

本轮没有放宽文件系统、网络、环境变量或解释器隔离。脚本仍只可写 job 目录，
job 外业务文件不可读，网络恒禁，Python 仍使用 `-I`。

## 统一合同

| 资源 | 上限 | 强制方式 |
|---|---:|---|
| wall-clock | `timeoutMs` 1–120 秒，默认 30 秒 | Tokio 看门狗；到期终止整个进程组 |
| stdout | 最多消费 1 MiB；报告保留已接受内容末尾 16 KiB | 读取第 1 MiB 后仅多读 1 byte 判定超限，随后关闭管道 |
| stderr | 最多消费 1 MiB；报告保留已接受内容末尾 16 KiB | 同 stdout |
| `CHATANKI_OUTPUT.json` | 32 MiB | metadata 快速拒绝 + `limit + 1` 有界读取双闸门 |
| 活跃进程 | 后端必须报告 `1..=2048` | Unix 当前 `RLIMIT_NPROC=2048`；Windows Job Object 当前为 128 |

`script.resourceLimits` 会返回本次实际合同，包括
`wallClockTimeoutMs`、`stdoutMaxBytes`、`stderrMaxBytes`、
`stdoutTailBytes`、`stderrTailBytes`、`outputFileMaxBytes`、
`sandboxFileMaxBytes` 和 `activeProcessesMax`。日志另返回
`stdoutBytesRead` / `stderrBytesRead` 与 `stdoutTruncated` /
`stderrTruncated`，避免把被截断日志误当完整输出。

## 文件大小语义

32 MiB 是跨平台一致的输出验收和宿主内存分配上限。读取不再采用
“metadata 检查后 `std::fs::read`”的无界路径，因此即使检查后文件大小变化，
Rust 也最多读取 32 MiB + 1 byte。

Unix 后端另有 4 GiB `RLIMIT_FSIZE`，作为 job 内任意单文件的纵深防御；
Windows Job Object 没有等价的通用单文件配额，因此
`sandboxFileMaxBytes` 在 Windows 为 `null`。这不影响 32 MiB 输出读取硬上限，
但它不是 Windows job 目录的磁盘配额，文档不把两者混为一谈。

前台解释器退出后，Rust 会在读取输出前再次清理同一进程组的后台后代，关闭
后代继续改写输出或长期持有日志管道的窗口。Windows helper 的 kill-on-close
Job Object 已覆盖同一语义。

## 回归测试

- `stream_capture_stops_after_budget_and_keeps_bounded_tail`
- `bounded_output_reader_accepts_exact_limit_and_rejects_limit_plus_one`
- `bounded_output_reader_rejects_missing_and_non_regular_paths`
- `resource_contract_exposes_portable_stream_file_and_process_limits`
- `resource_contract_fails_closed_without_bounded_process_tree`
- 既有 timeout、超大输出、symlink 输出、断网和 job 外文件不可读 e2e 继续保留。

## 残留边界

本轮没有声称提供统一的进程树内存配额；该能力仍需 Linux cgroup、
Windows Job aggregate memory 与 macOS 对等机制共同落地。现有高风险审批、
wall-clock/CPU/进程/文件/输出边界和逐卡 CAS 不因本项变化而减弱。
