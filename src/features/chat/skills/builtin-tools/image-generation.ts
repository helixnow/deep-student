/**
 * 图片生成技能组
 *
 * 通过 Chat V2 内置工具生成学习图片，并保存到 VFS。
 */

import type { SkillDefinition } from '../types';

export const imageGenerationSkill: SkillDefinition = {
  id: 'image-generation',
  name: 'image-generation',
  description: '图片生成能力。用于生成学习插图、概念图、知识卡片配图、题目配图、封面图等视觉材料。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 8,
  location: 'builtin',
  sourcePath: 'builtin://image-generation',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'composite',
  dependencies: ['ask-user'],
  relatedSkills: ['ask-user'],
  allowedTools: ['builtin-ask_user', 'builtin-image_generate'],
  content: `# 图片生成技能

当用户希望“生成图片 / 画一张图 / 做概念图 / 配图 / 封面图 / 知识卡片插图”时，调用 \`builtin-image_generate\`。

当用户给的信息还不足以影响成图效果时，先调用 \`builtin-ask_user\` 做一次轻量澄清，再生成图片。

## 工具

- **builtin-ask_user**: 当关键信息缺失时，向用户提出一个轻量级选择题，用于澄清用途、版式或风格。
- **builtin-image_generate**: 根据文本描述生成 1 张图片。生成结果会保存到 VFS 的“AI 生成图片”文件夹，并在聊天中展示。

## 参数

\`\`\`json
{
  "prompt": "光合作用概念图，清晰标注阳光、水、二氧化碳、叶绿体和葡萄糖",
  "aspectRatio": "1:1",
  "quality": "auto",
  "purpose": "概念图"
}
\`\`\`

## 使用规则

1. \`prompt\` 必填，应该把学习目标、主体、风格、标注要求写清楚。
2. \`aspectRatio\` 只能是 \`1:1\`、\`4:3\`、\`3:4\`、\`16:9\`、\`9:16\`。
3. \`quality\` 只能是 \`auto\`、\`low\`、\`medium\`、\`high\`。
4. 第一版固定生成 1 张图；不要请求批量生成。
5. 若用户没有指定比例，学习卡片/概念图默认用 \`1:1\`，封面图默认用 \`16:9\`，手机海报或竖版封面默认用 \`9:16\`。
6. 只有在信息不足且会明显影响结果时，才调用 \`builtin-ask_user\`。一次最多问 1 个问题。
7. \`builtin-ask_user\` 只问语义问题，例如“方图 / 横图 / 竖图”、“封面图 / 概念图 / 卡片配图”、“写实 / 插画 / 教学示意图”。
8. 不要询问底层尺寸、模型白名单或供应商参数。不要询问“1536x2752 还是 2048x2048”这类底层尺寸。
9. 如果用户没有明确比例但用途已经足够清晰，优先直接推断，不要多问。
10. 生成请求中的供应商兼容参数由执行层处理；skill 只负责组织语义参数。
`,
  embeddedTools: [
    {
      name: 'builtin-ask_user',
      description:
        '当图片用途、比例或风格信息不足时，向用户提出一个轻量级问题进行澄清。只问语义选择，不问底层接口参数。',
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: '【必填】需要用户回答的问题，保持简洁明确。',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            maxItems: 6,
            description: '【必填】2-6 个候选项。推荐项放在第一位并以 (Recommended) 结尾。',
          },
          multiple: {
            type: 'boolean',
            default: false,
            description: '是否允许多选。图片澄清场景通常保持 false。',
          },
          allowCustom: {
            type: 'boolean',
            default: true,
            description: '是否允许用户自由输入额外说明。',
          },
          context: {
            type: 'string',
            description: '为什么需要这个选择的简短说明。',
          },
        },
        required: ['question', 'options'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-image_generate',
      description:
        '根据文本提示生成一张图片，适合学习插图、题目配图、知识卡片插图、概念图、封面图等。结果会保存到 VFS 并以 image_gen 块展示。',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '【必填】图片生成提示词。请包含主体、学习用途、风格、标注和构图要求。',
          },
          aspectRatio: {
            type: 'string',
            description: '图片比例。',
            enum: ['1:1', '4:3', '3:4', '16:9', '9:16'],
            default: '1:1',
          },
          quality: {
            type: 'string',
            description: '生成质量。auto 通常最合适；high 成本和等待时间更高。',
            enum: ['auto', 'low', 'medium', 'high'],
            default: 'auto',
          },
          purpose: {
            type: 'string',
            description: '学习场景用途，例如：知识卡片插图、题目配图、概念图、封面图。',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
  ],
};
