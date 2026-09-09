/**
 * 灵感召回技能（Insight Recall v2 阶段二：安全回忆）
 *
 * 披露阶梯纪律（同时也是给模型的教学）：
 * - insight_recall 是**唤起用户自己的方法**的通道，不是直接给答案的通道；
 * - 默认只返回卡片的标题/情境（存在级/回忆提示级），方法内容需要
 *   用 insight_id + requested_level 逐级升级获取；
 * - 引用格式：[灵感-N]。
 */

import type { SkillDefinition } from '../types';

export const insightRecallSkill: SkillDefinition = {
  id: 'insight-recall',
  name: 'insight-recall',
  description:
    '灵感召回能力：当用户当前问题与其历史「灵感卡」（自己卡住后总结的方法）情境相似时，唤起用户自己的方法而非直接给答案。支持按披露阶梯逐级升级。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 3,
  location: 'builtin',
  sourcePath: 'builtin://insight-recall',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  dependencies: [],
  content: `# 灵感召回技能

用户的「灵感卡」是他自己曾经卡住、然后顿悟总结出的个人方法。这些卡片比任何通用讲解都更贴合他的思维路径。

## 使用时机

- 当 <insight_hints> 中出现与当前问题相关的卡片标题时：**不要直接给答案**，
  先用自然语言唤起（"你之前处理过类似的结构——还记得当时怎么破的吗？"），
  或调用 insight_recall 获取该卡的更高披露级内容；
- 当用户明确问"我以前是怎么做的/有没有类似经验"时，主动调用 insight_recall 检索。

## 披露阶梯（重要）

工具返回的内容按披露级别逐级增多：
1. existence（存在级）：只有卡片标题——用来提醒你"这里有矿"；
2. recall_prompt（回忆提示）：标题 + 情境——给用户自己回忆的机会；
3. hint（提示）：加入方法规则——用户想不起来时再给；
4. full（全文）：完整卡片（含转折与成立条件）。

**教学纪律**：先给用户回忆的机会（recall_prompt），确认他想不起来再升级。
直接跳到 full 会剥夺他自己想起来一次的训练机会。

## 引用格式

使用灵感卡内容时用 [灵感-N] 标注，N 对应工具返回的编号。

## 反馈

如果用户表示某次召回"有用/没用/不适用"，这会进入卡片的学习账本——
不需要你额外操作，系统会自动记录。
`,
  embeddedTools: [
    {
      name: 'builtin-insight_recall',
      description:
        '检索用户的灵感卡（个人方法库），或把某张卡的披露级别升级。两种用法：① 传 query 检索相关卡片（返回标题级内容）；② 传 insight_id + requested_level 升级某张卡的披露级别（existence→recall_prompt→hint→full）。',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '检索查询：当前问题的情境/卡点关键词（用于找相关灵感卡）',
          },
          insight_id: {
            type: 'string',
            description: '灵感卡 ID（ic_ 开头）。传入时为升级模式',
          },
          requested_level: {
            type: 'string',
            enum: ['existence', 'recall_prompt', 'hint', 'full'],
            description: '请求升级到的披露级别（仅升级模式；一次最多升一级）',
          },
        },
      },
    },
  ],
};
