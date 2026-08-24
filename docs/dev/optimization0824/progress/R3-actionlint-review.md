# R3 复审：actionlint 全量 lint（workflow 文件）

> 子代理：SA-R3-10  
> 模型：`claude-fable-5-thinking-xhigh`  
> 分支：`cursor/optimization0824-5575`  
> 状态：✅ 完成 —— **R1/R2 引入的 actionlint 告警数为 0，无需修复任何 workflow**

## 任务与范围

对 `.github/workflows/*.yml` 全量跑 actionlint，修复 R1/R2 两轮引入的任何告警
（仅限 workflow 文件）。存量（main 上已有）的告警不在本次范围。

## 环境

- actionlint **v1.7.12**（静态二进制，linux/amd64）
- shellcheck **v0.9.0** 集成生效（本次全部发现均来自 shellcheck 通道，可证明集成在工作）
- pyflakes 未安装，但 workflow 中无 `shell: python` 步骤（`rg` 核验），无覆盖缺口

## 方法

三层交叉验证，确保"R1/R2 引入 0 告警"的结论不是巧合：

1. **基线对比**：`git archive` 提取 merge-base `0e4c9fad`（分支起点，即 main 基线）
   的 `.github/workflows/`，与 R1/R2 完成态（`1bf03a24`，工作树干净时）分别全量 lint。
   两侧各 **36 条**发现。
2. **归一化多重集比对**：剥离 workflow 文件内行列号（脚本内相对位置与规则码、
   消息保留），`comm` 双向比对 —— **完全相同的多重集**，新增 0 条、消失 0 条。
   即使 R1/R2 有移动/复制脚本的情况也能被脚本相对位置捕获。
3. **逐条 blame 核验**：对当前 36 条发现所在的每个脚本区域 `git blame`，
   归属提交为 `f473a6d6`、`aef636c3`、`de1159c1`、`336f0851`、`c273c1e3` 等
   （2026-07~08 的 main 历史），经 `git merge-base --is-ancestor` 逐一确认
   均为 merge-base 的祖先 —— **没有任何一条落在本分支的改动行上**。

R1/R2 涉及 workflow 的提交（`edc626be`、`39579e63`、`2d06d6d5`、`f3f96557`、
`fb06ad30`、`1aa834b2`、`765032dd`、`2ee0039d`）共改动 11 个 workflow 文件
（+584/-50），其中新增文件 `reusable-build-frontend.yml`（122 行）**0 条发现**；
其余文件的新增脚本（sccache 设置与统计、apt 缓存、dist 工件复用、bundle 体积
门禁调用、路径过滤等）也全部干净。

## 结论

**R1/R2 引入的 actionlint 告警：0 条。无 workflow 文件需要修复，本次提交仅含本报告。**

附带核验：报告撰写时同分支已落地的 R3 workflow 提交
（`a7de3302` android mobile-slim、`504202b9` frontend 三 leg 并行）再次全量 lint，
发现集合与 R1/R2 完成态仍逐条一致 —— 目前已提交的 R3 workflow 改动同样 0 新增。

## 存量告警清单（main 已有，超出本次范围，仅记录）

共 36 条，全部为 shellcheck 通道的 info/style 级，无 actionlint 核心错误
（表达式类型、needs 引用、action 版本等均为 0）：

| 规则 | 级别 | 条数 | 涉及文件 |
| --- | --- | --- | --- |
| SC2086（变量未加引号） | info | 17 | release.yml ×7、reusable-build-android.yml ×6、rebuild-android.yml ×3、upload-r2.yml ×1 |
| SC2012（用 find 替代 ls） | info | 16 | ci.yml ×4、rebuild-android.yml ×4、reusable-build-android.yml ×2、reusable-publish.yml ×2、upload-r2.yml ×2、reusable-build-linux.yml ×1、reusable-migration-gate.yml ×1 |
| SC2129（合并重定向） | style | 2 | rebuild-android.yml、reusable-build-android.yml |
| SC2002（无用 cat） | style | 1 | hotfix-linux-release.yml |

SC2012 的 16 条几乎全是 `ls -lh … \| awk` 打印工件体积的日志性用法，
SC2086 多为 `$GITHUB_OUTPUT`/体积变量拼接 —— 实际风险低，但数量可观。
如后续想清零，建议单独开一个 `chore(ci)` 工作项统一治理（或在
`.github/actionlint.yaml` 显式豁免），不与优化轮次混在一起。

## 复现

```bash
/tmp/actionlint -no-color .github/workflows/*.yml   # 仓库根目录执行
```
