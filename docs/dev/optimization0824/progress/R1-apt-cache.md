# R1-apt-cache：CI Rust job 的 apt 依赖安装加缓存

> 子代理：SA-R1-07（模型 `claude-fable-5-thinking-xhigh`）  
> 分支：`cursor/optimization0824-5575`  
> 日期：2026-08-24

## 问题

`ci.yml` 中 5 个 Rust 相关 job 各自重复执行：

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf protobuf-compiler
```

`libwebkit2gtk-4.1-dev` 传递依赖 100+ 包，每次冷装 1–2 分钟。由于
`rust-tests` 是 8 路矩阵，**每次完整 CI run 实际有 12 个 runner 实例**
重复这一安装（backend、provider-contract、rust-test-build、rust-tests×8、
migration-gate）。

## 改动

5 个 job 定义（12 个 runner 实例/run）统一替换为
[`awalsh128/cache-apt-pkgs-action`](https://github.com/awalsh128/cache-apt-pkgs-action)
v1.6.3，SHA-pinned 为 `553a35bb8ebd9fcabcb1c9451aa4c98e1b4ca8a9`（与仓库
所有 action 的 pin 约定一致）：

| job | 说明 |
| --- | --- |
| `backend` | fmt + clippy（完整注释锚点在此 job） |
| `provider-contract` | 云 provider 合约测试 |
| `rust-test-build` | nextest archive 编译 |
| `rust-tests`（×8 矩阵） | 运行期共享库，收益最大 |
| `migration-gate` | 迁移门禁 |

包列表逐字保留：`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev
patchelf protobuf-compiler`。5 个 job 同包列表 + 同镜像，共享同一份缓存条目
（首个完成安装的 job 保存，其余命中）。

## 关键设计决策

1. **缓存 key 补上 runner 镜像作用域**。该 action 的缓存 key 只含
   包名列表 + `version` 输入，不含 OS/镜像信息；它缓存的是"新装包的
   文件快照"，恢复到不同 base 镜像上有 ABI 漂移风险（快照不含镜像
   预装库，二者组合必须与快照生成时一致）。而 `ImageOS`/`ImageVersion`
   是 runner 注入的机器级变量，**不在 `${{ env }}` 表达式上下文里**
   （直接写 `${{ env.ImageOS }}` 会静默展开为空），因此每个 job 先用
   一个 1 行 step 将其导出到 `GITHUB_ENV`，再作为 `version` 传入：
   `ubuntu24-20260817.1.0` 这类值随镜像每周滚动，缓存自然刷新，
   永远不会把旧镜像的快照恢复到新镜像上。
2. **`execute_install_scripts: true`**。缓存恢复路径默认只解包文件、
   不执行 postinst/dpkg 触发器（ldconfig、gdk-pixbuf loaders、glib
   schemas 等）。`rust-tests` 在运行期动态加载 webkit2gtk 系共享库，
   为与真实 apt 安装行为保持一致，恢复时同样执行安装脚本（Tauri 社区
   对同一组包的通用配置）。
3. **恢复路径不再执行 `apt-get update`**——这正是省时来源之一；
   缓存未命中路径由 action 内部完成安装（runner 镜像的 apt 列表
   每周随镜像刷新，与镜像作用域的 version 键同步）。

## 预期收益

- 命中路径：`apt-get update` + 100+ 包下载/解包/configure（1–2 分钟）
  → 单个缓存 tar 下载 + 解包 + 脚本重放（~20–40 秒）。
- 全 run 合计：12 个 runner 实例 × ~1–1.5 分钟 ≈ **12–18 Linux 分钟/run**。
- 每周镜像更新后的首个 run 为冷装（与现状等价，外加一次缓存保存），
  之后整周命中。

## 兼容性与回滚

- 仅 GitHub 托管 `ubuntu-latest` x86_64 runner 受影响；action 对非
  x86_64 架构会自动在 key 中加入架构后缀，未破坏未来 arm runner 的
  可能性。
- 若某包的安装脚本在恢复路径出问题：把该包拆回独立的
  `apt-get install` step 即可（action 官方建议的兜底），或整体
  还原为原 `run:` 两行命令——改动完全局部于 5 个 step。
- 强制刷新缓存：任意修改 `version`（现为镜像标识，可临时加后缀）。

## 验证

- `python3 yaml.safe_load` 通过；`actionlint 1.7.7` 无告警。
- 真实命中/耗时数据需在 PR CI run 中观察（本分支 push 即触发）。

## 未覆盖（后续候选）

同一安装模式还出现在（本任务按指示优先 ci.yml，未动）：

- `migration-nightly.yml` ×2（nightly 触发，频次低收益小）
- `reusable-migration-gate.yml` ×1（release/rebuild 路径，fail-closed
  语义，谨慎起见不顺手改）
- `reusable-build-linux.yml` ×1（release 构建，包列表不同且更长，
  需单独评估）
