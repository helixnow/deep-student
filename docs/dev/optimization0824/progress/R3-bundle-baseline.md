# R3 收紧 bundle-size 基线（SA-R3-06 / WI-8）

> 分支：`cursor/optimization0824-5575`
> 日期：2026-08-24
> 子代理：SA-R3-06（模型 `claude-fable-5-thinking-xhigh`）
> 前置：`R1-WI-8.md`（门禁引入）、`R2-wallpapers.md` / `R2-pdfjs-subset.md` / `R2-dnd-migration.md`（R2 优化）
> 状态：✅ 完成（CI 仍 warn 模式）

## 0. TL;DR

R2 优化落地后在 commit `1bf03a24`（"mark R2 complete"）重新构建实测，
`scripts/check-bundle-size.mjs` 的 7 项 `baselineBytes` 全部刷新为新实测值，
且 `HEADROOM` 由 **1.05 收紧为 1.03**（阈值 = 基线 +3%）。双重收紧后
total JS 阈值 **8,761.3 KiB → 8,560.6 KiB（−200.7 KiB）**。CI 步骤不动，
仍 `--warn-only` warn 模式；新阈值对当前构建全部 `ok`（0.0% vs baseline）。

## 1. 新基线（阈值来源）

环境：commit `1bf03a24`，`npx vite build`（无 sourcemap），Node v22.14.0，
`zlib.gzipSync(level 9)` 实测——与 R1 取基线方法完全一致。

| 监控项 | 旧基线 (B) | 新基线 (B) | Δ | 新阈值（+3%，KiB） |
| --- | ---: | ---: | ---: | ---: |
| entry `index-*.js` | 1,217,878 | 1,212,646 | −5,232 (−0.43%) | 1,219.8 |
| `init-*.js` | 1,430,457 | 1,430,414 | −43 | 1,438.8 |
| `vendor-mermaid-*.js` | 734,883 | 734,881 | −2 | 739.2 |
| `vendor-pptx-*.js` | 436,147 | 436,143 | −4 | 438.7 |
| `vendor-milkdown-*.js` | 396,386 | 396,367 | −19 | 398.7 |
| `vendor-exceljs-*.js` | 269,554 | 269,554 | 0 | 271.1 |
| total JS（`dist/assets/*.js`） | 8,544,326 | 8,510,689 | **−33,637 (−0.39%)** | 8,560.6 |

文件数 961 → 960。vendor 各 chunk 的个位数字节差为 chunk hash 引用变化带来的
gzip 噪声，非真实变更。

### 为什么 JS 侧降幅只有 −0.39%

R2 三项优化里只有 dnd 迁移直接作用于 JS 预算面：

- **dnd-kit 迁移**（`R2-dnd-migration.md`）：`@hello-pangea/dnd`（gzip ≈29.4 KiB
  及其 redux / react-redux / css-box-model 传递依赖）被 tree-shake，
  是 total −32.8 KiB 与 entry −5.1 KiB 的主要来源。
- **壁纸重压缩**（−3.6 MB）与 **pdfjs cmaps/wasm 裁剪**（−0.97 MB）作用于
  `dist/wallpapers/`、`dist/cmaps/`、`dist/wasm/` 等静态资产与 `.mjs` worker，
  不在本门禁的 `dist/assets/*.js` 口径内（安装包体积收益见各自报告）。

## 2. 变更内容

| 文件 | 变更 |
| --- | --- |
| `scripts/check-bundle-size.mjs` | `BUDGETS` 7 项 `baselineBytes` 刷新为上表新值；`HEADROOM` 1.05 → 1.03；头部注释、违规消息与控制台标题的 "+5%" 同步改为 "+3%" 并记录新基线 commit |

CI（`.github/workflows/ci.yml` 的 `Bundle size check (warn mode)` 步骤）**不改动**：
仍 `node scripts/check-bundle-size.mjs --warn-only`，超限只打 `::warning::` + job
summary，exit 0。

## 3. 实测过程备注

- 取数构建用 `npx vite build`（与脚本头部声明的基线方法、R1 流程一致）。
  当时 `npm run build` 的 prebuild `licenses:check` 短暂红灯：并行子代理
  SA-R3-01 正在移除 `@hello-pangea/dnd` 依赖，工作区 `package-lock.json`
  与 notices 记录的 SHA256 瞬时不一致；该状态已由 commit `01c79d15`
  （依赖删除 + notices 再生成）收敛，非本任务引入的问题。
- 该依赖删除不影响本次测量：R2 已把 `src/` 内全部真实 import 迁走
  （仅剩注释提及），构建产物与 `1bf03a24` 提交态一致。

## 4. 验证

- 新阈值下全部预算 `ok`，7 项 Δ 均为 0.0%，阻塞模式 exit 0 ✅
- `--warn-only` exit 0 ✅
- 输出标题与超限消息已显示 "+3%" ✅

## 5. 后续

1. `ci.yml` 步骤注释仍写 "+5%"（脚本才是阈值唯一维护点）；按 R1 计划
   ~2026-09-07 去掉 `--warn-only` 转阻塞时一并更新该注释。
2. R3 在途工作（如 SA-R3-05 第二批 schema 精简）落地后会继续压低
   entry/init，届时可再次刷新基线，避免门禁停在旧水位。
