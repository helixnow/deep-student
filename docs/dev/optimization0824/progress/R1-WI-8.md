# R1-WI-8：bundle 体积门禁脚本（warn 模式）

> 子代理：SA-R1-08（模型 `claude-fable-5-thinking-xhigh`）  
> 日期：2026-08-24  
> 分支：`cursor/optimization0824-5575`  
> 状态：✅ 完成（warn 模式接入，两周后转阻塞）

## 交付物

| 文件 | 变更 |
| --- | --- |
| `scripts/check-bundle-size.mjs` | 新增。测量 dist/assets 关键 JS chunk 的 gzip(level 9) 体积，与基线 +5% 阈值比对；支持 `--warn-only`（或 `BUNDLE_SIZE_WARN_ONLY=1`）；GitHub Actions 下输出 `::warning::`/`::error::` 注解 + job summary 表格 |
| `package.json` | 新增 `"check:bundle-size": "node scripts/check-bundle-size.mjs"` |
| `.github/workflows/ci.yml` | frontend job 在 `Build production bundle` 之后新增 `Bundle size check (warn mode)` 步骤，跑 `--warn-only`（exit 0 但打 warning） |

## 基线（阈值来源）

环境：commit `73c05860`，本地 `node scripts/generate-version.mjs && npx vite build`（无 sourcemap），
Node v22.14.0，`zlib.gzipSync(level 9)` 实测。仓库无既有 dist，故按任务预案现场构建取基线。

| 监控项 | 基线 gzip (bytes) | 基线 gzip (KiB) | 阈值（+5%，KiB） | 备注 |
| --- | ---: | ---: | ---: | --- |
| entry `index-*.js` | 1,217,878 | 1,189.3 | 1,248.8 | 从 `dist/index.html` 的 `<script>` 解析，不受多份同名 `index-*` chunk 干扰 |
| `init-*.js` | 1,430,457 | 1,396.9 | 1,466.8 | 当前最大单 chunk（raw 6.6 MB） |
| `vendor-mermaid-*.js` | 734,883 | 717.7 | 753.5 | |
| `vendor-pptx-*.js` | 436,147 | 425.9 | 447.2 | 含 echarts |
| `vendor-milkdown-*.js` | 396,386 | 387.1 | 406.5 | |
| `vendor-exceljs-*.js` | 269,554 | 263.2 | 276.4 | |
| total JS（`dist/assets/*.js` 求和） | 8,544,326 | 8,344.1 | 8,761.3 | 961 个文件；兜底防未列名 chunk 漂移 |

阈值在脚本内以 `baselineBytes × HEADROOM(1.05)` 计算，基线数值即 `BUDGETS` 表的唯一维护点。

## 设计要点

- **入口识别**：多份 chunk 都叫 `index-*.js`（不同目录 index.ts），故 entry 直接解析 `dist/index.html` 的 script 标签，而不是文件名 glob。
- **模式多匹配**：命名 chunk 模式若匹配多个文件取最大者比对（hash 变化不影响、不漏超限者）。
- **fail-visible**：模式匹配不到文件（chunk 改名/拆分导致门禁失效）会显式报 violation 提示更新 BUDGETS，不静默跳过；dist 缺失恒 exit 1（属流水线配置错误，非体积回归）。
- **CI 风格对齐**：job summary + `::warning::` 注解，与本仓库 npm audit / cargo audit 的"非阻塞但红字可见"约定一致。

## 验证

- 通过路径：当前 dist 全部 `ok`，exit 0 ✅
- 超限（阻塞模式）：人为压低 init 基线后 `::error::` + exit 1 ✅
- 超限（`--warn-only`）：`::warning::` + exit 0 ✅
- dist 缺失：明确报错 + exit 1 ✅
- `GITHUB_STEP_SUMMARY` 表格写入 ✅；`npm run check:bundle-size` ✅；ci.yml YAML 解析通过、步骤顺序正确 ✅

## 后续（转阻塞条件）

1. warn 模式观察两周（约至 2026-09-07），确认无误报后从 ci.yml 步骤去掉 `--warn-only` 转阻塞。
2. R1 其他 WI 落地后（如 WI-1 移除 `@anthropic-ai/claude-code`）主动收紧对应基线，避免"降了体积、门禁却停在旧水位"。
3. `init-*.js`（gzip 1.4 MB）与 entry（gzip 1.2 MB）是后续 WI-9/pdfjs 按需化与首屏拆包的主要目标，本门禁提供回归防线。
