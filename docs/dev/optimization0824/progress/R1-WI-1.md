# R1-WI-1：移除未使用的 @anthropic-ai/claude-code 生产依赖

> 子代理：SA-R1-01  
> 模型：`claude-fable-5-thinking-xhigh`  
> 分支：`cursor/optimization0824-5575`  
> Work Item：WI-1（移除未使用的 @anthropic-ai/claude-code）

## 调查结论

`rg "claude-code" src scripts dstu-test .skills`：**零匹配**（exit 1）。

全库范围内仅以下位置提及，均非代码引用：

| 文件 | 性质 |
| --- | --- |
| `package.json` / `package-lock.json` | 依赖声明本身（本 WI 移除对象） |
| `public/legal/THIRD_PARTY_NOTICES.txt` | 由 lockfile 生成的许可证清单（随移除重新生成） |
| `docs/dev/optimization0824/INITIAL-RESEARCH.md`、`COORDINATION.md` | 优化计划文档自述 |

该依赖是 CLI 工具（含 8 个平台二进制 optionalDependencies），装进前端应用的
`dependencies` 纯属误加：vite 构建不会打包它，但它污染依赖树、拖慢 `npm ci`、
并让第三方许可证清单多背 9 个组件条目。

## 修改清单

- `package.json`：从 `dependencies` 移除 `"@anthropic-ai/claude-code": "^2.1.220"`
- `package-lock.json`：移除对应 lock 条目（-140 行，含 8 个平台二进制包）
- `public/legal/THIRD_PARTY_NOTICES.txt`：`npm run licenses:generate` 重新生成，
  移除 `@anthropic-ai/claude-code@2.1.220` 及 8 个 `claude-code-<platform>` 条目
  （1871 → 1862 个组件）

## 验收结果

| 检查 | 结果 |
| --- | --- |
| `rg "claude-code" src scripts dstu-test .skills` | 零匹配 |
| `npm uninstall @anthropic-ai/claude-code` | removed 2 packages |
| `npm run licenses:generate` | Wrote public/legal/THIRD_PARTY_NOTICES.txt (1862 components) |
| `npm run licenses:check` | `[license-compliance] OK` |
| `npm run typecheck` | 通过（tsc --noEmit，exit 0） |

环境备注：licenses:generate 需要 `cargo metadata`，VM 预装 cargo 1.83 无法解析
workspace（依赖需要 edition2024），已 `rustup default stable`（1.98.0）并
`cargo fetch --locked` 后正常运行。此为 VM 环境操作，不影响仓库内容。

## 提交归属说明（并发协作）

本 WI 与其他子代理共享同一工作区。`package.json` / `package-lock.json` 的移除
改动在本地完成后、尚未由本代理提交前，被并发子代理的提交
`39579e63 fix(pdf): remove duplicate pdf.worker and unify on .mjs` 用 `git add`
全量暂存顺带带上（该提交的 stat 中可见 package.json -1 / package-lock.json -140）。
内容正确且已在分支上，为避免改写历史未做拆分。

本代理的提交 `chore(deps): remove unused @anthropic-ai/claude-code` 包含：

- 重新生成的 `public/legal/THIRD_PARTY_NOTICES.txt`——**这是 CI 修复项**：
  39579e63 改了 lockfile 但未重新生成许可证清单，`licenses:check` 的
  lockfile-hash 校验在该提交上会失败，本提交补齐后恢复 OK
- 本报告
