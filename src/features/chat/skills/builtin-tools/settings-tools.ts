/**
 * Agent-safe settings and model assignment tools.
 *
 * The schemas intentionally expose only an explicit low-risk allowlist. API
 * credentials, OAuth, cloud credentials, MCP and approval policy stay in the
 * human-operated Settings UI.
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
    '安全读取和修改少量低风险应用设置，并读取或按乐观锁修改模型职责分配。密钥、OAuth、云凭据、MCP、权限与审批策略始终只能由用户在 Settings 中操作。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 8,
  location: 'builtin',
  sourcePath: 'builtin://settings-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 设置与模型分配

本技能只开放经过显式枚举的低风险设置，以及已配置模型的职责分配。它不是通用设置数据库入口。

## 工具

- **builtin-settings_get**（Low）：按安全 prefix 读取最多 20 个允许项；每个值最多返回 2000 字符并标记 truncated。
- **builtin-settings_set**（Medium）：只写安全 key，value 类型与范围由 key 决定。
- **builtin-model_assignments_get**（Low）：读取当前职责分配和严格脱敏、每页最多 20 项的可选模型目录。
- **builtin-model_assignments_set**（Medium）：用 OCC 原子修改一个 slot；必须传 expected_current_config_id，未知当前值时先 get。

## 安全边界

API key、token、OAuth、password、secret、credential、private/access key、Authorization、cookie/session、MCP、cloud storage/WebDAV、tool approval 与 permission 不可通过本技能读取或写入。即使伪装成 prefix/key 或添加到参数里，executor 也会硬拒；请把用户带到 Settings 由其手工操作。模型目录只返回 ID、名称、provider、类型、enabled 和能力布尔值，不返回 api_key、base_url、headers、auth_mode 或原始配置。

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
  ],
  embeddedTools: [
    {
      name: 'builtin-settings_get',
      description:
        '按显式安全前缀读取应用设置（Low）。最多返回 20 项，每项含 key/value/updated_at/truncated；安全词与非白名单键会在 Rust 层再次拒绝或过滤。不是通用 get_setting，绝不返回密钥或凭据。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['prefix'],
        properties: {
          prefix: {
            type: 'string',
            enum: [...safeSettingPrefixes],
            description: '要读取的安全设置前缀；返回结果仍会按精确 key 白名单二次过滤',
          },
        },
      },
    },
    {
      name: 'builtin-settings_set',
      description:
        '修改一个显式允许的低风险设置（Medium）。schema 按 key 约束 value 类型/枚举/范围；返回 previous_value、changed 和刷新事件名。API key、OAuth、云凭据、MCP、权限/审批设置永不开放。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', enum: [...safeSettingKeys] },
          value: { description: '设置值；具体类型与范围由所选 key 的 oneOf 分支约束' },
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
      description:
        '读取模型职责分配与分页的脱敏可选模型目录（Low）。目录每页最多 20 项，只含 id/name/provider/model_type/enabled/capabilities，不含 api_key、base_url、headers、auth_mode 或原始配置。',
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
        '按 OCC 原子修改一个模型职责 slot（Medium）。config_id 与 expected_current_config_id 都必须显式提供且可为 null；非空模型必须存在、启用并满足 slot 能力。冲突返回当前值，须重新读取后再决定。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['slot', 'config_id', 'expected_current_config_id'],
        properties: {
          slot: {
            type: 'string',
            enum: [...modelAssignmentSlots],
            description: '要修改的真实 ModelAssignments 字段',
          },
          config_id: {
            ...nullableConfigId,
            description: '新模型配置 ID；null 表示清空该 slot',
          },
          expected_current_config_id: {
            ...nullableConfigId,
            description: '刚由 get 读到的当前 ID；当前为空时必须传 null',
          },
        },
      },
    },
  ],
};
