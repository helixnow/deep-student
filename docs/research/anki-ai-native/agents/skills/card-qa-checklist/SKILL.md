---
name: card-qa-checklist
description: 卡片质检清单：重复（D1-D3）、粒度（G1-G4）、Cloze 规范（C1-C6）三类规则的判定标准、严重级别与补丁输出格式
version: 0.1.0
author: Deep Student Research
skillType: standalone
tags: [anki, card-making, qa, cloze, lint]
---

# 卡片质检清单（card-qa-checklist）

本技能沉淀 `card-qa` 子代理的判定规则，可独立激活用于主代理自检，也可作为未来确定性 lint（Rust 侧 `chatanki` 质检管线）的规则来源。

## 规则总表

| 编号 | 类别 | 判定标准 | 级别 | 可确定性检测 |
|------|------|---------|------|--------------|
| D1 | 重复 | 正面归一化（去空白/标点/大小写）后相同 | error | ✅ 字符串比对 |
| D2 | 重复 | 语义重复：同一事实的不同措辞 | warn | ❌ 需 LLM/嵌入 |
| D3 | 重复 | 与工作区存量笔记/卡片重复 | warn | ⚠️ 需检索 + 相似度阈值 |
| G1 | 粒度 | 一卡多事实（并列考点、多段背面） | error | ⚠️ 启发式（并列连词/列表项数） |
| G2 | 粒度 | 空泛提问（简述/介绍/谈谈 X） | warn | ✅ 问法黑名单 |
| G3 | 粒度 | 背面过载（> 3 句或 > 60 汉字且可分割） | warn | ✅ 长度阈值 |
| G4 | 粒度 | 离开材料无法唯一作答（缺限定词） | warn | ❌ 需 LLM |
| C1 | Cloze | `{{c1::答案}}` / `{{c1::答案::提示}}` 语法合法，无嵌套、花括号配对 | error | ✅ 正则/解析器 |
| C2 | Cloze | c 编号从 1 起连续无跳号 | error | ✅ 解析器 |
| C3 | Cloze | 单卡挖空组 ≤ 3 | warn | ✅ 计数 |
| C4 | Cloze | 不整句挖空、不挖虚词、答案 ≤ 15 字 | warn | ⚠️ 长度可测，虚词需词表 |
| C5 | Cloze | 挖空语法与卡型互相匹配（Cloze 卡必有挖空，Basic 卡必无） | error | ✅ 卡型 × 正则 |
| C6 | Cloze | 提示不包含答案本体 | warn | ✅ 子串比对 |

「可确定性检测」列标 ✅ 的规则是 Round 2 「确定性质检 lint」候选：可以在 Rust 管线（或 `chatanki_transform` 脚本）中零 LLM 成本实现，LLM 只兜底 ❌ 项。

## 裁决规则

- 存在任一 `error` → 整批 `FAIL`，父代理必须先修复再导出/同步。
- 仅有 `warn`/`info` → `PASS_WITH_WARNINGS`，父代理可带着警告征询用户。
- 全清 → `PASS`。

## 补丁输出格式

与 `builtin-chatanki_batch_update_cards` / `builtin-chatanki_delete_cards` / `builtin-chatanki_add_cards` 的入参形状对齐（详见 `card-qa.md` 输出契约），使父代理可以零改写直接套用。
