/**
 * 翻译领域工具组
 *
 * 翻译计算与 VFS 入库是两个独立步骤。长译文通过后端短期结果引用
 * 在步骤间传递，避免把超长正文注入工具上下文。
 */

import type { SkillDefinition } from '../types';

const termSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    src: {
      type: 'string' as const,
      minLength: 1,
      maxLength: 200,
      description: '源语言术语，必须是非空文本',
    },
    dst: {
      type: 'string' as const,
      minLength: 1,
      maxLength: 200,
      description: '该术语必须采用的目标语言译法',
    },
  },
  required: ['src', 'dst'],
};

const saveCommonProperties = {
  title: {
    type: 'string' as const,
    minLength: 1,
    maxLength: 200,
    description: '入库标题（可选）',
  },
  folder_id: {
    type: 'string' as const,
    minLength: 1,
    maxLength: 128,
    description: '目标 VFS 文件夹 ID（可选）；文件夹不存在时拒绝保存',
  },
  engine: {
    type: 'string' as const,
    minLength: 1,
    maxLength: 200,
    description: '翻译引擎标识（可选，仅在已知真实值时填写）',
  },
  model: {
    type: 'string' as const,
    minLength: 1,
    maxLength: 200,
    description: '翻译模型标识（可选，仅在已知真实值时填写）',
  },
};

export const translationToolsSkill: SkillDefinition = {
  id: 'translation-tools',
  name: 'translation-tools',
  description:
    '批量、术语约束与可入库翻译工具。把最长 500000 字符的文本按段交给真实翻译模型，支持正式度、领域和内联术语；长结果以短期引用传给独立保存步骤。普通聊天中的一句即时翻译通常直接回答即可。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 7,
  location: 'builtin',
  sourcePath: 'builtin://translation-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 翻译工具

用于需要真实翻译管线的批量翻译、术语约束或翻译库入库。用户只要求翻译聊天中的一句短文本、且不要求术语约束或保存时，直接在对话中回答即可，不必加载本技能。

## 工具

- **builtin-translate_text**（Low）：调用翻译专用模型，聚合返回译文结果。单段最多 100000 个 Unicode 字符；总输入最多 500000 字符，超出单段时由后端自动分段并按原顺序合并。
- **builtin-translation_save**（Medium，仅前台对话）：把一次成功翻译的完整结果或用户提供的成对原文/译文保存为真实 VFS 翻译资源，可指定 folder_id。

## 标准工作流

1. 从用户文本或资源读取工具取得原文。用户指定资源库文档或页范围时，先 \`load_skills(["learning-resource"])\`，再用 \`builtin-resource_read\` 的 \`page_start/page_end\` 读取正文；不要把文件路径当成待翻译文本。
2. 调用 translate_text。术语约束只使用内联 \`terms: [{src, dst}]\`；仓库没有可供 Agent 使用的 glossary 存取后端，因此不存在 \`glossary_id\` 参数，也不得编造该 ID。
3. 检查返回的 \`translated_preview\`、\`translated_truncated\`、字符数与分段数。完整译文不超过安全输出上限时，返回还会带 \`translated\`；长译文不直接注入上下文。
4. 只有用户明确要求入库时才调用 translation_save。长译文优先原样传入 translate_text 返回的 \`translation_result_id\`；这是会话绑定、进程内、有界的短期引用，有效期见 \`expires_in_seconds\`（当前 1800 秒）。应立即保存；保存成功后引用即被消费，不得重复使用。应用重启或引用过期后必须重新翻译。
5. translation_save 的两种输入互斥：
   - 翻译结果路径：传 \`translation_result_id\`，可附 title/folder_id；
   - 显式文本路径：传完整 \`source/translated/source_lang/target_lang\`，用于保存已经存在的短文成对译文（source/translated 各最多 2000 字符）。

translate_text **不会自动入库**，translation_save **不会重新翻译**。不得在翻译失败、取消或只有截断预览时把预览冒充完整译文保存。

## 参数与拒绝规则

- \`source_lang\`/\`target_lang\` 使用 ASCII BCP47-like 语言代码；自动检测源语言时可传 \`source_lang="auto"\`，\`target_lang\` 不允许 auto。
- \`formality\` 仅支持 formal/casual；\`domain\` 仅支持 general/academic/technical/literary/casual/legal/medical。
- \`terms\` 最多 100 项，src/dst 都必须非空；同一源术语不要给出互相冲突的译法。
- 空文本、超过 500000 字符、无效枚举、畸形 terms、未知/过期 result_id、混用两种保存路径、目标文件夹不存在都会被拒绝。
- 保存是持久化写入（Medium），不向无人值守 headless 自动化运行器暴露。

错误统一返回 \`code/message/message_key/hint/retryable\`。可见 code 包括 \`INVALID_ARGUMENT\`、\`GLOSSARY_ID_UNSUPPORTED\`、\`TRANSLATION_CANCELLED\`、\`TRANSLATION_RESULT_TOO_LARGE\`、\`DEPENDENCY_UNAVAILABLE\`、\`TRANSLATION_FAILED\`、\`EMPTY_TRANSLATION\`、\`TRANSLATION_RESULT_NOT_FOUND\`、\`FOLDER_NOT_FOUND\` 和 \`TRANSLATION_SAVE_FAILED\`。不要对非 retryable 错误盲目重试。
`,
  allowedTools: [
    'builtin-translate_text',
    'builtin-translation_save',
  ],
  embeddedTools: [
    {
      name: 'builtin-translate_text',
      description:
        '使用真实翻译专用模型翻译文本（Low）。总输入最多 500000 个 Unicode 字符，后端按每段最多 100000 字符自动分段并聚合。返回 translation_result_id、source_lang、target_lang、translated_preview（最多 2000 字符）、translated_truncated、source_chars、translated_chars、segment_count、expires_in_seconds、consumed_after_successful_save；仅译文不超过 2000 字符时额外返回完整 translated。不会写入翻译库。',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            minLength: 1,
            maxLength: 500000,
            description: '【必填】待翻译原文；按 Unicode 字符计最多 500000',
          },
          source_lang: {
            type: 'string',
            minLength: 1,
            maxLength: 32,
            pattern: '^(?:auto|[A-Za-z]+(?:-[A-Za-z0-9]{1,8})*)$',
            description: '【必填】源语言代码，如 auto、en、zh-CN',
          },
          target_lang: {
            type: 'string',
            minLength: 1,
            maxLength: 32,
            pattern: '^(?!auto$)[A-Za-z]+(?:-[A-Za-z0-9]{1,8})*$',
            description: '【必填】目标语言代码，如 zh-CN、en、ja；不允许 auto',
          },
          formality: {
            type: 'string',
            enum: ['formal', 'casual'],
            description: '正式度（可选）',
          },
          domain: {
            type: 'string',
            enum: ['general', 'academic', 'technical', 'literary', 'casual', 'legal', 'medical'],
            description: '翻译领域（可选，默认 general）',
          },
          terms: {
            type: 'array',
            maxItems: 100,
            items: termSchema,
            description: '内联术语约束（可选）；不存在 glossary_id 路径',
          },
        },
        required: ['text', 'source_lang', 'target_lang'],
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-translation_save',
      description:
        '把完整翻译结果保存为真实 VFS 翻译资源（Medium，仅前台对话）。使用会话绑定的短期 translation_result_id，或直接提供各不超过 2000 字符的 source/translated 及语言代码，两条路径严格互斥。支持 title 与 folder_id。成功返回 translation_id、resource_id、path、title、folder_id、source_lang、target_lang、engine、model、created_at、updated_at、source_chars、translated_chars、source_mode、translation_result_consumed、reversible=true，以及 undo={tool_name:"builtin-dstu_delete",arguments:{path},effect:"soft_delete_to_trash"}。不会调用模型或重新翻译。',
      inputSchema: {
        type: 'object',
        properties: {
          translation_result_id: {
            type: 'string',
            minLength: 1,
            maxLength: 80,
            description: 'translate_text 返回的短期结果引用；与显式文本路径互斥',
          },
          source: {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
            description: '显式保存路径的完整短原文',
          },
          translated: {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
            description: '显式保存路径的完整短译文',
          },
          source_lang: {
            type: 'string',
            minLength: 1,
            maxLength: 32,
            pattern: '^(?:auto|[A-Za-z]+(?:-[A-Za-z0-9]{1,8})*)$',
            description: '显式保存路径的源语言代码',
          },
          target_lang: {
            type: 'string',
            minLength: 1,
            maxLength: 32,
            pattern: '^(?!auto$)[A-Za-z]+(?:-[A-Za-z0-9]{1,8})*$',
            description: '显式保存路径的目标语言代码；不允许 auto',
          },
          ...saveCommonProperties,
        },
        oneOf: [
          {
            type: 'object',
            properties: {
              translation_result_id: {
                type: 'string',
                minLength: 1,
                maxLength: 80,
              },
              ...saveCommonProperties,
            },
            required: ['translation_result_id'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              source: { type: 'string', minLength: 1, maxLength: 2000 },
              translated: { type: 'string', minLength: 1, maxLength: 2000 },
              source_lang: {
                type: 'string',
                minLength: 1,
                maxLength: 32,
                pattern: '^(?:auto|[A-Za-z]+(?:-[A-Za-z0-9]{1,8})*)$',
              },
              target_lang: {
                type: 'string',
                minLength: 1,
                maxLength: 32,
                pattern: '^(?!auto$)[A-Za-z]+(?:-[A-Za-z0-9]{1,8})*$',
              },
              ...saveCommonProperties,
            },
            required: ['source', 'translated', 'source_lang', 'target_lang'],
            additionalProperties: false,
          },
        ],
        additionalProperties: false,
      },
    },
  ],
};
