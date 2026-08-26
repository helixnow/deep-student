# Wave2-C R9 coarse-touch-target 白名单加载记录

日期：2026-08-26（UTC）

## 范围与改动

- 仅修改 `eslint-rules/coarse-touch-target.js` 的 allowlist 加载边界：
  - `import.meta.url` 为 `file:` 时继续使用原有相对 `URL`。
  - 非 `file:` 时使用 `import.meta.dirname` 拼接文件路径；其不可用时回退到当前仓库工作目录下的 `eslint-rules`。
  - 读取或解析失败时输出 `console.warn`，并用 `{ files: [] }` 空白名单继续加载，不再让测试收集直接抛错。
- 未改 `coarse-touch-target.allowlist.json` 内容、规则匹配语义或 `eslint.config.js` 严重级。
- 未改产品 UI。

## 指定 Vitest

命令：

```bash
npx vitest run tests/vitest/coarseTouchTargetRule.test.ts
```

结果：退出码 `1`，**未转绿**。

- 原 R8 阻塞已解除：测试文件成功收集并执行，共 `34` 个测试；不再出现 `TypeError: The URL must be of scheme file`。
- 当前结果为 `2 passed / 32 failed`。
- 新红灯发生在测试调用 `Linter.verify` 后：每个 `.tsx` filename 都返回
  `No matching configuration found for ...`，因此消息的 `ruleId/messageId` 为空，规则断言无法运行。
- 当前安装版本为 ESLint `9.39.4`（`package.json` 范围为 `^9.18.0`）；这是收集完成后的测试配置匹配问题，不是 allowlist loader 再次抛错。按本轮指令停止，未修改测试配置或继续复跑。

## 声明

- 未 commit、未 push。
- 模型降级：否；本轮未触发到 `gpt-5.6-sol-high-fast` 的显式降级。Cloud run 元数据仍为 `originalModelName: null`，因此无法从运行内独立核验 `xhigh-fast` 子档位标签。
