# R2-apt-nightly：migration nightly / release gate 的 apt 缓存

> 子代理：SA-R2-03（模型 `claude-fable-5-thinking-xhigh`）  
> 分支：`cursor/optimization0824-5575`  
> 日期：2026-08-24  
> 前置：R1-apt-cache（`ci.yml` 中已验证的 `awalsh128/cache-apt-pkgs-action` 模式）

## 范围

R1 报告"未覆盖（后续候选）"清单中的前两项，本任务补齐：

| 文件 | job | 原状 |
| --- | --- | --- |
| `migration-nightly.yml` | `full-fixture-gate` | `apt-get update` + 5 包冷装 |
| `migration-nightly.yml` | `scale-fixture-gate` | 同上 |
| `reusable-migration-gate.yml` | `gate` | 同上 |

三处的包列表与 `ci.yml` 完全一致（逐字保留）：
`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
protobuf-compiler`。

`reusable-build-linux.yml`（R1 清单第三项）包列表不同且更长，需单独
评估，本任务不动。

## 改动

三个 job 均替换为 R1 在 `ci.yml` 验证过的两步模式，action 版本与
SHA pin 完全一致（`awalsh128/cache-apt-pkgs-action` v1.6.3 =
`553a35bb8ebd9fcabcb1c9451aa4c98e1b4ca8a9`）：

```yaml
- name: Resolve runner image scope for apt cache
  run: echo "APT_CACHE_SCOPE=${ImageOS:-unknown}-${ImageVersion:-unknown}" >> "$GITHUB_ENV"

- name: Install system dependencies (cached)
  uses: awalsh128/cache-apt-pkgs-action@553a35bb8ebd9fcabcb1c9451aa4c98e1b4ca8a9 # v1.6.3
  with:
    packages: libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf protobuf-compiler
    version: ${{ env.APT_CACHE_SCOPE }}
    execute_install_scripts: true
```

镜像作用域（`ImageOS`/`ImageVersion` 须经 `GITHUB_ENV` 中转）与
`execute_install_scripts: true`（恢复路径重放 postinst/dpkg 触发器）
的完整动机见 `ci.yml` backend job 注释与 R1-apt-cache 报告，不重复。

附带一处诚实性修正：`reusable-migration-gate.yml` 的
"Print gate tool manifest" step 打印本 gate 使用的 action 清单，
已补上 `cache-apt-pkgs v1.6.3`。

## 缓存共享与命中路径

- 该 action 的缓存 key = 包名列表 + `version` 输入。三个新 job 与
  `ci.yml` 的 5 个 Rust job 包列表相同、镜像作用域相同 ⇒ **共享同一
  缓存条目**，nightly / release gate 几乎不需要自己冷装。
- GitHub Actions 缓存可见性：默认分支（main）上保存的缓存对所有
  ref 可见。`ci.yml` 在 push main 时运行并保存缓存 ⇒
  `migration-nightly.yml`（schedule/push main）与
  `reusable-migration-gate.yml`（release/rebuild，tag 或 main 触发）
  的恢复路径均能命中。

## release gate 的 fail-closed 语义（R1 曾按谨慎原则跳过）

R1 报告对 `reusable-migration-gate.yml` 标注"fail-closed 语义，
谨慎起见不顺手改"，本任务按指示落地，确认语义不受影响：

1. **不引入静默降级**。缓存未命中时 action 内部执行真实
   `apt-get install`；恢复或安装任一环节失败都会让该 step 失败，
   进而让 gate 红掉——不存在"包没装上但 gate 继续跑"的路径。
2. **checkout tag、workflow 取 caller revision 的组合不受影响**。
   该 workflow 以 `inputs.tag_name` 检出旧 tag，但 step 定义来自
   caller revision；包列表是 step 常量而非源码派生，与被测 tag 无关。
3. 缓存内容按镜像标识（`ImageVersion` 每周滚动）刷新，release 复用的
   永远是同一 base 镜像上生成的快照，无 ABI 漂移。

## 预期收益

- 每个 job 命中时省 1–2 分钟的 `apt-get update` + 100+ 包安装：
  - nightly：2 job/天 ≈ 2–4 Linux 分钟/天（频次低，收益为次要目标；
    主要价值是三层迁移门禁与 ci.yml 模式统一，只维护一份写法）。
  - release/rebuild gate：每次发布省 1–2 分钟，release 关键路径上的
    真实墙钟收益。
- 冷装仅发生在每周镜像滚动后、且通常已由当周首个 ci.yml run 承担。

## 验证

- `python3 yaml.safe_load`：两个文件解析通过。
- `actionlint 1.7.7`：两个文件无告警。
- 真实命中数据需观察：nightly 下次 schedule 触发（或对 main push
  迁移相关路径），release gate 于下次 release/rebuild。

## 回滚

改动完全局部于 3 个 step（外加 manifest 打印一行）：任一 job 出问题
时把该处还原为原 `run:` 两行 `apt-get` 命令即可，互不影响。
