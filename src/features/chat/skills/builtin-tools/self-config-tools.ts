/**
 * Agent 自配置工具组（Self-Configuration）
 *
 * 让 Agent 在用户明确授权后自行完成：LLM 供应商/密钥/模型档案维护、连接与模型
 * 目录探测、Failover 与注入预算、通用/语音/记忆/AnkiConnect/流式/自动化设置、
 * Web 搜索引擎与密钥、以及自动备份策略。所有写操作都是 High 敏感度并逐次审批；
 * 密钥写入后只返回 key_present，不返回明文。
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition, ToolSchema } from '../types';

const llmConfigTools: ToolSchema[] = [
  {
    name: 'builtin-llm_config_vendors_list',
    description:
      '列出全部 LLM 供应商（Low，只读）。返回 id/name/provider_type/base_url/auth_mode/enabled/key_present/keys_count，绝不返回 api_key。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'builtin-llm_config_vendor_upsert',
    description:
      '新增或更新 LLM 供应商（High，逐次审批）。传 vendor_id 更新已有供应商；省略时用 vendor_name+provider_type+base_url 新建。'
      + 'api_key 可选，仅用于写入加密存储，事件与工具块中一律脱敏为 <redacted>；不得传 <redacted> 或 *** 占位。'
      + 'enabled 控制该供应商业已存在模型档案的启用状态。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        vendor_id: { type: 'string', minLength: 1, maxLength: 200 },
        vendor_name: { type: 'string', minLength: 1, maxLength: 200 },
        provider_type: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[A-Za-z0-9._-]+$' },
        base_url: { type: 'string', minLength: 1, maxLength: 300 },
        api_key: { type: 'string', minLength: 1, maxLength: 500 },
        auth_mode: { type: 'string', maxLength: 40 },
        headers: { type: 'object', additionalProperties: { type: 'string', maxLength: 4000 } },
        enabled: { type: 'boolean' },
      },
    },
  },
  {
    name: 'builtin-llm_config_vendor_key_set',
    description:
      '为已有 LLM 供应商设置或轮换 API Key（High，逐次审批）。api_key 仅写入加密存储，事件与持久化中脱敏为 <redacted>；拒绝 <redacted>/*** 占位。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['vendor_id', 'api_key'],
      properties: {
        vendor_id: { type: 'string', minLength: 1, maxLength: 200 },
        api_key: { type: 'string', minLength: 1, maxLength: 500 },
      },
    },
  },
  {
    name: 'builtin-llm_config_models_fetch',
    description:
      '从供应商远程 API 拉取可用模型目录（Low，只读）。传 vendor_id 使用已保存凭据；否则需 provider_type+base_url，api_key 可选。'
      + '返回 {vendor_id, models:[{id,label,context_window,max_output_tokens}]}。api_key 在事件中脱敏。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        vendor_id: { type: 'string', minLength: 1, maxLength: 200 },
        provider_type: { type: 'string', minLength: 1, maxLength: 40 },
        base_url: { type: 'string', minLength: 1, maxLength: 300 },
        api_key: { type: 'string', maxLength: 500 },
      },
    },
  },
  {
    name: 'builtin-llm_config_test',
    description:
      '测试模型连通性（Low，只读）。传 profile_id，或 vendor_id+model。返回 {success, latency_ms, message, model}，不返回密钥。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        profile_id: { type: 'string', minLength: 1, maxLength: 200 },
        vendor_id: { type: 'string', minLength: 1, maxLength: 200 },
        model: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
  },
  {
    name: 'builtin-llm_config_profiles_list',
    description:
      '列出全部模型档案（Low，只读）：id/vendor_id/name/model/enabled/is_multimodal/supports_thinking/supports_function_calling/context_window/max_output_tokens。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'builtin-llm_config_profile_upsert',
    description:
      '新增或更新模型档案（High，逐次审批）。传 profile_id 更新；否则需 vendor_id+model，已存在则更新、不存在则创建。'
      + '可设置 name/enabled/能力开关/context_window/max_output_tokens；context_window 传 null 表示清空。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        profile_id: { type: 'string', minLength: 1, maxLength: 200 },
        vendor_id: { type: 'string', minLength: 1, maxLength: 200 },
        model: { type: 'string', minLength: 1, maxLength: 200 },
        name: { type: 'string', minLength: 1, maxLength: 200 },
        label: { type: 'string', minLength: 1, maxLength: 200 },
        enabled: { type: 'boolean' },
        is_multimodal: { type: 'boolean' },
        supports_thinking: { type: 'boolean' },
        supports_function_calling: { type: 'boolean' },
        context_window: { type: 'integer', minimum: 1, maximum: 10000000 },
        max_output_tokens: { type: 'integer', minimum: 1, maximum: 1000000 },
      },
    },
  },
  {
    name: 'builtin-llm_config_profile_delete',
    description:
      '按 profile_id 删除模型档案（High，逐次审批），并清空 model_assignments 中引用它的 slot；返回 cleared_slots。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['profile_id'],
      properties: { profile_id: { type: 'string', minLength: 1, maxLength: 200 } },
    },
  },
  {
    name: 'builtin-llm_config_failover_get',
    description: '读取 llm_failover_policy（Low，只读）；未配置时返回默认策略。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'builtin-llm_config_failover_set',
    description:
      '写入 llm_failover_policy（High，逐次审批）。policy 为完整对象：enabled/autoDegradeChat/defaultFallbacks/taskFallbacks/purposeModels/keyCooldownSecs/rateLimitBackoffMs。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['policy'],
      properties: { policy: { type: 'object', additionalProperties: true } },
    },
  },
  {
    name: 'builtin-llm_config_budget_get',
    description: '读取 injection_budget.config（Low，只读）；未配置时 config 为 null。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'builtin-llm_config_budget_set',
    description:
      '写入注入预算配置 injection_budget.config（High，逐次审批）。config 必须含 total_budget/reserved_for_user_input/reserved_for_system/type_limits/priority_weights/enable_smart_truncation。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['config'],
      properties: { config: { type: 'object', additionalProperties: true } },
    },
  },
  {
    name: 'builtin-settings_domains_list',
    description:
      '按域读取结构化设置（Low，只读）：general（12 个安全 UI 设置）/voice_input/memory/anki_connect/chat_stream/automation。省略 domain 返回全部域。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        domain: { type: 'string', enum: ['general', 'voice_input', 'memory', 'anki_connect', 'chat_stream', 'automation'] },
      },
    },
  },
  {
    name: 'builtin-settings_apply',
    description:
      '按域写入结构化设置（High，逐次审批），写入后广播 settings_changed。general 只接受 12 个安全 UI 键；'
      + 'voice_input 传 {config} 对象；memory 接受 root_folder/privacy_mode/auto_create_subfolders/default_category/auto_extract_frequency；'
      + 'anki_connect 接受 url/deck/enabled；chat_stream 接受 timeout_ms(0-86400000 或 null)/auto_cancel_on_timeout；'
      + 'automation 接受 background_enabled。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['domain', 'values'],
      properties: {
        domain: { type: 'string', enum: ['general', 'voice_input', 'memory', 'anki_connect', 'chat_stream', 'automation'] },
        values: { type: 'object', additionalProperties: true },
      },
    },
  },
];

const searchConfigTools: ToolSchema[] = [
  {
    name: 'builtin-dstu_config_search_get',
    description:
      '读取 Web 搜索配置（Low，只读）：engine、cn_whitelist(enabled/use_default/domains)、provider_strategies，以及 tavily/serpapi/brave/zhipu/bocha/deepseek/google_cse/searxng 的 configured/key_present（绝不返回密钥）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'builtin-dstu_config_search_set',
    description:
      '修改 Web 搜索配置（High，逐次审批）并广播 settings_changed。支持 engine、cn_whitelist_enabled、cn_whitelist_use_default、cn_whitelist_domains、provider_strategies；至少传一项。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        engine: {
          type: 'string',
          enum: ['bing_rss', 'tavily', 'serpapi', 'brave', 'zhipu', 'bocha', 'deepseek', 'google_cse', 'searxng'],
        },
        cn_whitelist_enabled: { type: 'boolean' },
        cn_whitelist_use_default: { type: 'boolean' },
        cn_whitelist_domains: { type: 'array', items: { type: 'string' }, maxItems: 200 },
        provider_strategies: { type: 'object', additionalProperties: true },
      },
    },
  },
  {
    name: 'builtin-dstu_config_search_key_set',
    description:
      '为搜索供应商设置 API Key（High，逐次审批），写入安全存储并广播 settings_changed；事件与工具块中 api_key 脱敏为 <redacted>，拒绝 <redacted>/*** 占位。'
      + 'google_cse 还需 cx；searxng 可附带 endpoint。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['engine', 'api_key'],
      properties: {
        engine: {
          type: 'string',
          enum: ['tavily', 'serpapi', 'brave', 'zhipu', 'bocha', 'deepseek', 'google_cse', 'searxng'],
        },
        api_key: { type: 'string', minLength: 1, maxLength: 1000 },
        cx: { type: 'string', minLength: 1, maxLength: 200 },
        endpoint: { type: 'string', minLength: 1, maxLength: 500 },
      },
    },
  },
  {
    name: 'builtin-dstu_config_search_test',
    description: '对指定搜索引擎做一次真实连通性测试（Low，只读），返回 success/message/latency_ms。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['engine'],
      properties: {
        engine: {
          type: 'string',
          enum: ['bing_rss', 'tavily', 'serpapi', 'brave', 'zhipu', 'bocha', 'deepseek', 'google_cse', 'searxng'],
        },
      },
    },
  },
];

const backupConfigTools: ToolSchema[] = [
  {
    name: 'builtin-backup_config_get',
    description:
      '读取备份配置 backup.config（Low，只读）：auto_backup_enabled、interval_hours、max_backups、include_assets、backup_directory、backup_tiers。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'builtin-backup_config_set',
    description:
      '校验并保存自动备份策略（High，逐次审批）并广播 settings_changed：auto_backup_enabled、interval_hours(1-168)、max_backups(1-100) 或 null、include_assets。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        auto_backup_enabled: { type: 'boolean' },
        interval_hours: { type: 'integer', minimum: 1, maximum: 168 },
        max_backups: { type: 'integer', minimum: 1, maximum: 100 },
        include_assets: { type: 'boolean' },
      },
    },
  },
];

export const SELF_CONFIG_EMBEDDED_TOOLS: ToolSchema[] = [
  ...llmConfigTools,
  ...searchConfigTools,
  ...backupConfigTools,
];

export const SELF_CONFIG_TOOL_NAMES: readonly string[] = SELF_CONFIG_EMBEDDED_TOOLS.map(tool => tool.name);

/** Alias matching the builtin-tools skill vocabulary used by the loader/registry. */
export type BuiltinToolSkill = SkillDefinition;

export const selfConfigToolsSkill: BuiltinToolSkill = {
  id: 'self-config-tools',
  name: 'self-config-tools',
  description:
    'Agent 自配置能力组：在用户明确授权后自行查看/配置 LLM 供应商与 API Key、模型档案、连接测试与模型目录、Failover 与注入预算、'
    + '通用/语音/记忆/AnkiConnect/流式/自动化设置、Web 搜索引擎与密钥、自动备份策略。所有写操作 High 敏感度、逐次审批；密钥只写不读。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 8,
  location: 'builtin',
  sourcePath: 'builtin://self-config-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  relatedSkills: ['settings-tools', 'llm-usage-tools', 'data-governance-tools', 'self-service-tools'],
  content: `# Agent 自配置技能

本技能让 Agent **在用户明确要求或确认后**自行完成应用配置，而不是把用户推回 Settings 页面。
每个写操作都是 High 敏感度并逐次审批；读操作都是 Low/只读。凡是涉及密钥的工具，
返回值只含 key_present/keys_count，绝不含明文。

## 何时使用

- 用户说"帮我加一个 DeepSeek 供应商 / 换 key / 测一下这个模型能不能用"
- 用户说"把默认搜索换成 Tavily / 配一下博查的 key / 打开 CN 白名单"
- 用户说"把自动备份改成每 12 小时、保留 10 份 / 包含附件"
- 用户说"打开/关闭语音输入、改记忆隐私模式、开 AnkiConnect、调流式超时、开后台自动化"
- 需要先了解当前配置再决定下一步时，先调用对应的 *_get / *_list 只读工具

## LLM 供应商与密钥

1. \`builtin-llm_config_vendors_list\` 或 \`builtin-llm_config_profiles_list\` 先看清现状（key_present 只表示是否已配置）。
2. 新供应商用 \`builtin-llm_config_vendor_upsert\`（vendor_name + provider_type + base_url，api_key 可选）。
3. 只换密钥用 \`builtin-llm_config_vendor_key_set\`。**绝不要**把聊天里显示的 \`<redacted>\` 或 \`***\` 当真 key 传入；必须让用户重新粘贴。
4. \`builtin-llm_config_models_fetch\` 可拉取远端模型清单；选定后用 \`builtin-llm_config_profile_upsert\` 建档。
5. \`builtin-llm_config_test\` 验证连通性；\`builtin-llm_config_profile_delete\` 会同时清空引用该档案的职责分配。
6. 要让模型承担职责，继续使用 \`settings-tools\` 的 \`model_assignments_get/set\`（OCC）。

## 搜索配置

- 先 \`builtin-dstu_config_search_get\`；改引擎/白名单/策略用 \`builtin-dstu_config_search_set\`；
- 改密钥用 \`builtin-dstu_config_search_key_set\`（同样的占位符拒绝规则）；
- 改完用 \`builtin-dstu_config_search_test\` 验证真实连通性。

## 设置与备份

- 先 \`builtin-settings_domains_list\` 看当前值，再 \`builtin-settings_apply\`。
- general 只开放 12 个安全 UI 键；凭据、MCP、权限、审批策略仍只能在 Settings 中修改。
- \`builtin-backup_config_get/set\` 只管理自动备份策略，不触发立即备份（立即备份用 \`backup_create\`）。

## 确认与安全规则

- 任何 High 写操作前，先用一句话说明将修改什么、影响哪些模型/搜索/备份行为；审批不可复用。
- 不得编造 API Key、base_url 或模型名；不确定时先调用 fetch/test 或询问用户。
- 不得把密钥写入普通设置、文件、消息或技能内容；密钥只经本技能的安全存储接口写入。
- 删除模型档案、改 Failover、改注入预算都可能影响正在运行的任务；先说明影响再执行。`,
  allowedTools: [...SELF_CONFIG_TOOL_NAMES],
  embeddedTools: SELF_CONFIG_EMBEDDED_TOOLS,
};
