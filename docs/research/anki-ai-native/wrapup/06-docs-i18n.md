# 收尾 #6：文档与 i18n 终检

> 2026-08-24 · 分支 `cursor/anki-ai-native-research-bfca` ·
> PR [#215](https://github.com/helixnow/deep-student/pull/215)

## 范围

本次只检查和修订中英文 i18n、用户指南与调研收口文档，不修改 Rust 业务逻辑。
核对真源为当前分支的 ChatAnki skill、预览块组件与已落地的 Round 4/5 提交。

## 核对结果

### ChatAnki 工具面

- `chatAnkiSkill.embeddedTools` 当前包含 **29 个** `builtin-chatanki_*` 工具。
- 用户指南中的“29 项制卡专用能力”与该清单一致。
- Round 5 skill 契约测试使用显式工具清单做双向 diff，避免只写死数量后漏报增删。

### i18n

- `src/locales/zh-CN/anki.json`：1019 个叶子 key。
- `src/locales/en-US/anki.json`：1019 个叶子 key。
- 两侧 key 集合完全相等，无 `zhOnly` / `enOnly`。
- 卡片预览块混用两个命名空间：
  - 卡片内联编辑、QA 徽标等使用 `anki`；
  - 块级进度、操作与 APKG 媒体报告使用 `chatV2`。
- 预览块实际引用的两组 key 在中英文资源中均存在；`chatV2.json` 也保持
  1838 / 1838 个叶子 key 对称。因此本次没有为未使用路径追加冗余翻译。

### 用户指南

- 现行入口只描述 ChatAnki 对话制卡、任务看板和模板管理。
- 工具数量、transform ops/script 双模式、生成调优参数、QA 徽标、媒体报告、
  FSRS 回流与偏好记忆限制均与当前代码一致。
- critic 仍未暴露为用户可触达的 ChatAnki 参数。图像遮挡在终检期间新增了
  “VlmFull 直接图片 → 启发式 `_occlusion` 草稿”的最小后端路径，但没有真实
  grounding、PDF 页图支持或预览/编辑入口，因而不把两者写成完整用户功能。

### Round 4/5 状态

- Round 4 的能力扩展已完成盘点。
- Round 5 当前分支已交付：
  - run/start 生成调优参数的 skill schema 对齐；
  - 同文档用户修正对接入 opt-in LLM critic，缺参照时回退规则 rubric；
  - eval lint 与生产 `anki_qa_lint` 对齐；
  - VlmFull 直接图片的启发式图像遮挡草稿最小接线；
  - 文档、用户指南与 i18n 终检。
- 仍明确保留为未完成：偏好记忆写入侧、图像遮挡完整闭环
  （PDF 页图、真实 grounding、预览/编辑）、Sidekick Planner/Vlm 分槽，
  以及 `_original_generation` 稳定埋点。Generator / Critic 路由已接。

## 修改文件

- `docs/user-guide/12-Anki制卡与模板.md`
- `docs/research/anki-ai-native/README.md`
- `docs/research/anki-ai-native/progress-log.md`
- `docs/research/anki-ai-native/wrapup/06-docs-i18n.md`

`anki.json` 与预览块所需 `chatV2` key 已满足对称和可达性要求，终检未做无效改写。
