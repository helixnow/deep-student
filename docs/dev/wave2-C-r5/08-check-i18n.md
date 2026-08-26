# 0824 Wave2-C R5 · 08 check-i18n 接线

- 基线：`cf8eb9e8`（/tmp/0824-wave2-c-r5-check-i18n，改动未提交）
- 约束遵守：未执行 node/npm；未 git commit；未触碰 .github/workflows

## 改动清单

| 文件 | 变更 |
|---|---|
| `scripts/check-i18n.mjs` | 接线退出语义 + 新增叶子类型检查与 t() 引用键双语检查（+286/-9 行） |
| `package.json` | 新增 `"check:i18n:strict": "node scripts/check-i18n.mjs --strict"`（`check:i18n` 原样保留） |
| `tests/vitest/check-i18n.script.source.test.ts` | 新建，源码级契约测试（不 spawn、不执行脚本） |

## 退出语义（脚本头部注释同步声明）

| 问题类别 | 默认模式 | --strict |
|---|---|---|
| 跨语言缺键（zh-CN ⇄ en-US 键不对称） | exit 1 | exit 1 |
| 叶子非字符串（number/boolean/null） | exit 1 | exit 1 |
| locale JSON 解析失败 | exit 1 | exit 1 |
| 对应语言 locale 文件缺失 | exit 1 | exit 1 |
| t() 引用键在任一语言缺失 | 仅告警 | exit 1 |
| ALL_NS 声明命名空间缺 locale 文件 | 仅告警 | exit 1 |
| 检查过程抛异常 | exit 1 | exit 1 |

实现要点：模块级 `summary` 计数器 → `computeExitCode()`（`hardErrors > 0` 恒失败；`STRICT && strictErrors > 0` 追加失败）→ `generateSummary(exitCode)` 打印分类计数与通过/未通过 → `process.exit(exitCode)`。原脚本各节只打印不设 exit code，任何情况都返回 0，本轮修复了这一点。

## t() 引用键双语检查（新第 5 节）

- 提取：`t('key')` / `i18n.t(...)` / `i18next.t(...)`（前置边界排除 `props.t(` 等成员调用）+ `<Trans i18nKey="...">`；先剥离块注释/行注释。
- 键过滤：`KEY_CANDIDATE_RE` 只接受「可选 ns 前缀 + 点分路径」的静态键；含空格/中文/`${}` 插值的字符串视为 fallback 文案而非键，动态键天然跳过。
- 解析判定：`defaultNS: 'common'` + `fallbackNS: 其余全部命名空间`（src/i18n.ts）意味着运行时键在任一命名空间存在即可解析，故按每语言全命名空间并集索引判断，避免误报。索引包含中间对象节点（`returnObjects: true`）和 i18next 复数基名（`_one/_other/...` 剥后缀）。
- `keyPrefix` 文件（全库仅 2 个）：裸键无法静态还原完整路径，只校验其显式 `ns:key` 引用。
- 扫描范围：`src/**/*.{ts,tsx}`，排除 `__tests__`、`*.test.*`、`*.stories.*`、`dev/`、`style-lab`、`locales/`。

## 叶子类型判定说明

数组按合法结构化叶子放行（现有 locale 中 `review.weekdaysShort`、`template` 示例数组是 `returnObjects: true` 的正当消费，且数组内含 `order: 1` 之类结构对象）；对象位置上的 number/boolean/null 计为「叶子非字符串」失败。

## 测试（tests/vitest/check-i18n.script.source.test.ts）

纯源码断言，符合库内 `*.source.test.ts` 风格，不执行脚本：

1. 脚本文件存在；
2. 解析 `--strict` 标志；
3. summary 含默认失败四类 + strict 两类计数字段；
4. `collectNonStringLeaves` 存在且数组放行、非字符串判定在位；
5. `checkUsedTranslationKeys` / `T_CALL_RE` / `I18N_KEY_ATTR_RE` / 双语索引构建在位；
6. `computeExitCode` 语义（hard 恒失败、strict 门控、`process.exit(exitCode)`）；
7. 异常路径 `process.exit(1)`；
8. package.json `check:i18n` 与 `check:i18n:strict` 接线正确。

vitest include 模式 `tests/vitest/**/*.{test,spec}.{ts,tsx}` 覆盖该文件。

## 本会话未运行的验证（留给后续轮次/CI）

- `npm run check:i18n`：预期在当前基线可能非 0——第 2 节若存在跨语言缺键即失败（此前脚本恒 exit 0，问题被吞）。
- `npm run check:i18n:strict`：额外暴露 t() 引用键缺失。
- `npx vitest run tests/vitest/check-i18n.script.source.test.ts`。
- 备注：`.github/workflows` 目前无任何 job 调用 `check:i18n`（rg 确认），故退出码收紧不会立即改变 CI 行为；接入 CI 时建议先跑默认模式，缺口清零后再切 strict。
