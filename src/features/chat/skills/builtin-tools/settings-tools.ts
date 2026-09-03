/**
 * Agent-safe settings and model assignment tools.
 *
 * The schemas intentionally expose only an explicit low-risk allowlist. OAuth,
 * cloud credentials, MCP and approval policy stay in the human-operated
 * Settings UI. The single credential-bearing exception is
 * `builtin-model_profile_add` (High sensitivity): it lets the agent add a new
 * vendor/model entry from a user-supplied config, always behind an explicit
 * per-call user approval that is never remembered.
 */

import type { SkillDefinition } from '../types';

const safeSettingKeys = [
  'theme',
  'theme_palette',
  'language',
  'enableNotifications',
  'maxChatHistory',
  'markdownRendererMode',
  'auto_save',
  'macos.native_font_smoothing',
  'sidebar.translucent',
  'ui.pointer_cursor',
  'thinking.auto_collapse',
  'textbook.max_pages',
] as const;

const safeSettingPrefixes = [
  'theme',
  'language',
  'enableNotifications',
  'maxChatHistory',
  'markdownRendererMode',
  'auto_save',
  'macos.',
  'sidebar.',
  'ui.',
  'thinking.',
  'textbook.',
] as const;

const modelAssignmentSlots = [
  'model2_config_id',
  'review_analysis_model_config_id',
  'anki_card_model_config_id',
  'qbank_ai_grading_model_config_id',
  'chat_title_model_config_id',
  'translation_model_config_id',
  'memory_decision_model_config_id',
  'exam_sheet_ocr_model_config_id',
  'reranker_model_config_id',
  'vl_reranker_model_config_id',
  'voice_input_asr_model_config_id',
  'image_generation_model_config_id',
] as const;

const nullableConfigId = {
  anyOf: [
    { type: 'string' as const, minLength: 1, maxLength: 200, pattern: '.*\\S.*' },
    { enum: [null] },
  ],
};

const booleanSettingSchema = (key: (typeof safeSettingKeys)[number]) => ({
  type: 'object' as const,
  additionalProperties: false,
  required: ['key', 'value'],
  properties: {
    key: { type: 'string' as const, enum: [key] },
    value: { type: 'boolean' as const },
  },
});

export const settingsToolsSkill: SkillDefinition = {
  id: 'settings-tools',
  name: 'settings-tools',
  description:
    '安全读取和修改少量低风险应用设置，读取或按乐观锁修改模型职责分配，并可新增模型配置（必经用户逐次审批）。OAuth、云凭据、MCP、权限与审批策略始终只能由用户在 Settings 中操作。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 8,
  location: 'builtin',
  sourcePath: 'builtin://settings-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 设置与模型分配

本技能只开放经过显式枚举的低风险设置、已配置模型的职责分配，以及新增模型配置这一个凭据入口。它不是通用设置数据库入口。

## 工具

- **builtin-settings_get**（Low）：按安全 prefix 读取最多 20 个允许项；每个值最多返回 2000 字符并标记 truncated。
- **builtin-settings_set**（Medium）：只写安全 key，value 类型与范围由 key 决定。
- **builtin-model_assignments_get**（Low）：读取当前职责分配和严格脱敏、每页最多 20 项的可选模型目录。
- **builtin-model_assignments_set**（Medium）：用 OCC 原子修改一个 slot；必须传 expected_current_config_id，未知当前值时先 get。
- **builtin-model_profile_add**（High，每次必经用户审批且审批不可记住）：把用户提供的一段模型配置（base_url + api_key + model）新增进设置。仅当用户在对话中明确给出配置并要求添加时才调用；绝不自行编造 api_key。传 vendor_id 可挂到已有供应商；省略时按 base_url + provider_type 去重复用，都没有则新建供应商。同 vendor 同 model 重复添加会报 MODEL_PROFILE_EXISTS。

## 安全边界

除 model_profile_add 的 api_key 入参外，API key、token、OAuth、password、secret、credential、private/access key、Authorization、cookie/session、MCP、cloud storage/WebDAV、tool approval 与 permission 不可通过本技能读取或写入；伪装成 prefix/key 或额外参数都会被 executor 硬拒。model_profile_add 的 api_key 只用于执行期写入加密存储，事件流、审批展示与持久化的工具块中一律脱敏为 <redacted>。模型目录只返回 ID、名称、provider、类型、enabled 和能力布尔值，不返回 api_key、base_url、headers、auth_mode 或原始配置。

## 新增模型配置工作流

1. 用户在消息里给出配置（如 "base_url=https://api.deepseek.com/v1, key=sk-..., model=deepseek-chat"）。只在用户明确要求添加时才调用 model_profile_add。
2. 参数：model 必填；vendor_id 省略时必须给 vendor_name + base_url，provider_type 缺省为 openai。能力布尔值（is_multimodal/supports_tools 等）按模型真实能力填写，不确定就省略（默认 false）；embedding/reranker/image_generation 互斥且不能与文本能力共置。
3. 用户审批通过后，返回 profile_id/vendor_id；vendor_reused=true 表示复用了已有供应商，api_key_applied 表示凭据是否写入。
4. 要让新模型承担某类职责，再走 model_assignments_get → model_assignments_set 流程。

## 模型修改工作流

1. 先调用 model_assignments_get，确认 slot 当前值以及候选模型的 enabled/capabilities。
2. 调用 model_assignments_set 时，把读取到的当前值原样传为 expected_current_config_id（当前为空则传 null）。
3. config_id 可传 null 表示清空；非空模型必须存在、启用并满足该 slot 的能力要求。并发冲突时重新 get，不要覆盖别处刚完成的修改。

文本、OCR、reranker、语音转写和图片生成 slot 的能力规则不同，不能仅凭模型名称猜测。已废弃且无消费链的 embedding_model_config_id/vl_embedding_model_config_id 不开放；translation_display_mode 不是模型 slot。
`,
  allowedTools: [
    'builtin-settings_get',
    'builtin-settings_set',
    'builtin-model_assignments_get',
    'builtin-model_assignments_set',
    'builtin-model_profile_add',
  ],
  embeddedTools: [
    {
      name: 'builtin-settings_get',
      description: '按安全前缀读取白名单设置（Low，最多 20 项，绝不返回密钥）。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['prefix'],
        properties: {
          prefix: {
            type: 'string',
            enum: [...safeSettingPrefixes],
          },
        },
      },
    },
    {
      name: 'builtin-settings_set',
      description:
        '修改一个白名单低风险设置（Medium）；value 约束由 key 的 oneOf 分支决定。密钥、MCP、审批永不开放。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', enum: [...safeSettingKeys] },
          value: {},
        },
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'value'],
            properties: {
              key: { type: 'string', enum: ['theme'] },
              value: { type: 'string', enum: ['light', 'dark', 'auto'] },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'value'],
            properties: {
              key: { type: 'string', enum: ['theme_palette'] },
              value: {
                type: 'string',
                enum: ['default', 'purple', 'green', 'orange', 'pink', 'teal', 'muted', 'paper', 'custom'],
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'value'],
            properties: {
              key: { type: 'string', enum: ['language'] },
              value: { type: 'string', enum: ['zh-CN', 'en-US'] },
            },
          },
          booleanSettingSchema('enableNotifications'),
          {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'value'],
            properties: {
              key: { type: 'string', enum: ['maxChatHistory'] },
              value: { type: 'integer', minimum: 10, maximum: 1000 },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'value'],
            properties: {
              key: { type: 'string', enum: ['markdownRendererMode'] },
              value: { type: 'string', enum: ['legacy', 'enhanced'] },
            },
          },
          booleanSettingSchema('auto_save'),
          booleanSettingSchema('macos.native_font_smoothing'),
          booleanSettingSchema('sidebar.translucent'),
          booleanSettingSchema('ui.pointer_cursor'),
          booleanSettingSchema('thinking.auto_collapse'),
          {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'value'],
            properties: {
              key: { type: 'string', enum: ['textbook.max_pages'] },
              value: { type: 'integer', minimum: 1, maximum: 50 },
            },
          },
        ],
      },
    },
    {
      name: 'builtin-model_assignments_get',
      description: '读取模型职责分配与分页脱敏模型目录（Low，每页最多 20 项）。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          page_size: { type: 'integer', minimum: 1, maximum: 20, default: 20 },
        },
      },
    },
    {
      name: 'builtin-model_assignments_set',
      description:
        '按 OCC 修改一个模型职责 slot（Medium）；模型须启用且满足能力，冲突须重新 get。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['slot', 'config_id', 'expected_current_config_id'],
        properties: {
          slot: {
            type: 'string',
            enum: [...modelAssignmentSlots],
          },
          config_id: {
            ...nullableConfigId,
            description: 'null=清空该 slot',
          },
          expected_current_config_id: {
            ...nullableConfigId,
            description: 'get 读到的当前 ID；空传 null',
          },
        },
      },
    },
    {
      name: 'builtin-model_profile_add',
      description:
        '把用户提供的模型配置新增进设置（High，每次必经用户审批）。仅在用户明确给出配置并要求添加时调用；不得编造 api_key。省略 vendor_id 时按 base_url+provider_type 去重复用或新建供应商。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['model'],
        properties: {
          model: {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            description: '模型 ID，如 deepseek-chat、gpt-4o',
          },
          label: {
            type: 'string',
            maxLength: 200,
            description: '显示名，缺省取 model',
          },
          vendor_id: {
            type: 'string',
            maxLength: 200,
            description: '挂到已有供应商；省略时必须给 vendor_name + base_url',
          },
          vendor_name: { type: 'string', maxLength: 200 },
          provider_type: {
            type: 'string',
            maxLength: 40,
            pattern: '^[A-Za-z0-9._-]+$',
            description: '缺省 openai；按真实服务商填（anthropic/gemini/deepseek/...）',
          },
          base_url: {
            type: 'string',
            maxLength: 300,
            description: '绝对 http(s) URL，如 https://api.deepseek.com/v1',
          },
          api_key: {
            type: 'string',
            maxLength: 500,
            description: '用户提供的密钥；仅执行期使用，展示与持久化均脱敏',
          },
          is_multimodal: { type: 'boolean' },
          is_reasoning: { type: 'boolean' },
          is_embedding: { type: 'boolean' },
          is_reranker: { type: 'boolean' },
          is_image_generation: { type: 'boolean' },
          supports_tools: { type: 'boolean' },
          context_window: { type: 'integer', minimum: 1, maximum: 10000000 },
          max_output_tokens: { type: 'integer', minimum: 1, maximum: 1000000 },
        },
      },
    },
  ],
};
