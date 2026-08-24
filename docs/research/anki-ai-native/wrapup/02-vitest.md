# Anki / ChatAnki Vitest 收尾检查（子代理 #2）

日期：2026-08-24

## 范围

执行以下定向回归：

```bash
npx vitest run \
  tests/vitest/chat-v2/skills/chatAnki*.test.ts \
  tests/vitest/anki \
  tests/vitest/flashcards/ankiTemplateCardFace.test.tsx \
  tests/vitest/chat-v2/plugins/blocks/AnkiCardsBlock.test.tsx \
  tests/vitest/chat-v2/plugins/events/ankiCards.test.ts
```

## 修复

- 移除 `chatAnkiAgentLoop.test.ts` 对 ChatAnki 工具总数 `29` 的硬编码断言。
- allowlist、embedded schemas 与 CRUD 必需工具均改为双向清单差异断言；失败时直接列出缺失项。
- 移除 `chatAnkiRound4Contract.test.ts` 的历史工具数下限 `29`，重复项检查改为输出重复名称清单。
- 实现契约在本次定向回归中没有发现错误，因此未修改生产代码。

## 结果

- 测试文件：18 通过，0 失败。
- 测试用例：172 通过，0 失败。
- 首次启动时本地依赖尚未安装，Vitest 未进入测试收集；执行锁文件安装后，定向回归通过。
