# R1-provider-contract：provider-contract job PR 路径过滤降频

> 子代理：SA-R1-06  
> 模型：`claude-fable-5-thinking-xhigh`  
> 分支：`cursor/optimization0824-5575`

## 问题

`ci.yml` 的 `provider-contract`（Cloud Provider Contract Gate）是全 workflow 最重的
job：120 分钟预算，Docker 起 MinIO/WebDAV/FTP 三个真实 provider，编译后单线程串行跑
全部 ignored 契约测试。它在每个 PR 上无条件运行，但其验证的唯一信号是
`cloud_storage` / `data_governance::sync` 对真实 provider 的行为契约 —— 纯前端或
无关后端改动的 PR 拿不到任何增量信号（编译回归已由 `backend` / `rust-tests` 覆盖），
却每次烧掉最长的 CI 队列时间。

## 修改

文件：`.github/workflows/ci.yml`

1. **新增 `changes` 前置探测 job**（`dorny/paths-filter`，pin 到 v4.0.3 commit SHA
   `ceb8a2b8…`，遵循 repo 全部 action 按 SHA pin 的风格；v4 相对 v3 唯一 breaking
   change 是 node24 运行时，hosted runner 支持）。`pull_request` 事件走 GitHub API
   比对变更文件、无需 checkout；push 事件跳过过滤步骤。

2. **`provider-contract` 增加 `needs: [changes]` 与条件**：

   ```yaml
   if: github.event_name != 'pull_request' || needs.changes.outputs.provider-contract == 'true'
   ```

   push（main/develop/nightly 分支）恒跑全量，与改动前行为完全一致；仅 PR 受过滤。

## 过滤规则（PR 触发路径）

| 路径 | 理由 |
| --- | --- |
| `src-tauri/src/cloud_storage/**` | provider 实现（webdav/s3/ftp/sync_manager/traits/config） |
| `src-tauri/src/data_governance/**` | 契约测试依赖 `data_governance::sync` 与 `::migration` |
| `src-tauri/src/crypto/**` | 测试直接调用 `crypto::backup_crypto` |
| `src-tauri/tests/sync_provider_contract_tests.rs` | 契约测试本体 |
| `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` | 依赖升级可能改变 provider 客户端行为 |
| `scripts/dev/docker-compose.sync-test.yml` | provider 环境唯一事实源 |
| `dstu-test/docker/**` | FTP 镜像 build context（Dockerfile.ftp / ftp_server.py）+ compose include 引用方 |
| `.github/workflows/ci.yml` | workflow 自身变更需自证 |

## 设计说明

- **不用 workflow 级 `paths:`**：ci.yml 是多 job 单 workflow，顶层 `paths:` 会把
  frontend/backend 等所有 job 一起过滤掉。migration-nightly.yml 的顶层 `paths:` 模式
  只适用于单一职责 workflow，故此处用 `dorny/paths-filter` 做 job 级过滤。
- **fail-closed，不是假绿**：`provider-contract` 的 `if` 不含状态函数
  （无 `always()`/`!cancelled()`），保留对 `changes` 的隐式 `success()` 依赖 ——
  过滤 job 失败（如 API 出错）时 provider-contract 被跳过、workflow 整体标红，
  不会静默放行。
- **分支保护兼容**：若 `provider-contract` 被设为 required check，路径未命中时
  job 结论为 `skipped`，GitHub 视为满足 required check，不会卡死 PR。

## 验证

- `python3 -c "yaml.safe_load(...)"` — YAML 解析通过，job 拓扑
  （`needs: [changes]` + `if`）符合预期。
- `actionlint`（最新版）全文件扫描零告警。
- `dorny/paths-filter` v4.0.3 tag SHA 经 GitHub API 核实为
  `ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d`。

## 提交

- commit：`ci: path-filter provider-contract job on PRs`
