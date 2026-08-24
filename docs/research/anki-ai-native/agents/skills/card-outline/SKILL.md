---
name: card-outline
description: 制卡大纲方法论：从学习材料抽取最小知识单元、决策卡型、切分粒度并排优先级，产出可直接喂给 chatanki_run 的结构化大纲
version: 0.1.0
author: Deep Student Research
skillType: standalone
tags: [anki, card-making, outline, curation]
---

# 制卡大纲方法论（card-outline）

本技能沉淀 `content-curator` 子代理的方法论，也可被主代理直接激活使用。

## 最小知识单元（Minimum Information Principle）

一个知识单元 = 一个可独立判定对错的事实。切分检验法：

1. **单问单答**：能用一个不含并列连词的问句问出来。
2. **答案封闭**：答案唯一或有限枚举，不是开放式论述。
3. **出处可溯**：能指到材料的具体章节/页码。

不满足任一条 → 继续拆分或放弃入卡。

## 卡型决策

- **Basic**：术语↔定义、因果、对比差异点。定义类默认建议正反双向（term→def、def→term 各一张）。
- **Cloze**：陈述句中有天然空位（公式变量、参数值、步骤名、专名）。每卡挖空组 ≤ 3；整句挖空 = 反模式。
- **多步流程**：N 步流程拆成 N 张「第 k 步是什么」或一组顺序 Cloze，禁止单卡背整表。
- **图形/结构**：标注 `vlm_light` / `vlm_full` 路由建议，交由 chatanki 管线处理，大纲层不做图像切分。

## 去重策略

- 先在大纲内部去重（同义改写合并），再对工作区存量（`rag_search` / `unified_search`）标注 `dup_risk`。
- 去重只标注不删除：删除决策权在父代理/用户。

## 优先级

`P0` = 材料反复强调 + 高遗忘代价（公式、参数、易混点）；`P1` = 常规考点；`P2` = 背景/扩展。生成时建议按 P0→P1 顺序入卡，P2 由用户决定。

## 输出

统一使用 `content-curator.md` 中的「输出契约」表格结构：材料概览 → 知识点清单 → 建议 goal 文本 → 风险与遗留。
