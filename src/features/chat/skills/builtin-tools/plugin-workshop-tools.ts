/**
 * 插件工坊技能组（自主插件工坊闭环）
 *
 * 让普通会话里的主 Chat Agent 在一次 `load_skills` 后就能拿到工具工坊的
 * 全部 `dstu_plugin_*` schema：发现 SDK、生成源码、编译修复、读取/写入任意
 * 插件配置、热启用/停用，以及用户明确要求时的重启。
 *
 * 后端 executor：`host/plugins/plugin-workshop/src/tools.ts`
 * （前端工具名带 `builtin-` 前缀，路由时剥离）。
 * 安装本身仍只能由用户在确认卡片上点击完成；Agent 工具没有安装权限。
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

/** 内置工具组技能的公开契约别名。 */
export type BuiltinToolSkill = SkillDefinition;

const PLUGIN_WORKSHOP_TOOL_NAMES = [
  'builtin-dstu_plugin_api_list',
  'builtin-dstu_plugin_api_read',
  'builtin-dstu_plugin_propose_install',
  'builtin-dstu_plugin_status',
  'builtin-dstu_plugin_validate',
  'builtin-dstu_plugin_diagnose',
  'builtin-dstu_plugin_write_source',
  'builtin-dstu_plugin_rollback',
  'builtin-dstu_plugin_export',
  'builtin-dstu_plugin_inventory',
  'builtin-dstu_plugin_config_get',
  'builtin-dstu_plugin_configure',
  'builtin-dstu_plugin_set_enabled',
  'builtin-dstu_plugin_app_restart',
] as const;

export const pluginWorkshopToolsSkill: BuiltinToolSkill = {
  id: 'plugin-workshop-tools',
  name: 'plugin-workshop-tools',
  description:
    'DSTU 插件工坊工具组：发现真实 SDK/service/slot、生成并编译插件源码、诊断与回滚、列出已安装插件、读取与热更新插件配置、热启用/停用插件。用户要求“做一个插件/改这个插件/调整插件配置”时使用；安装必须由用户在确认卡片上点击，Agent 无安装权限。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 3,
  location: 'builtin',
  sourcePath: 'builtin://plugin-workshop-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  relatedSkills: ['ask-user'],
  content: `# DSTU 插件工坊技能

插件在应用进程内运行，安装即授予完整信任——这不是沙箱。Agent 不能安装、
启用或删除插件；只有用户在确认卡片上点击才能安装。你可以生成、编译、诊断源码，
以及在用户要求下读取和修改**已安装**插件的配置。

## 闭环（安装与配置都热加载，无需重启应用）

1. **极速三步走（常规 \`learning-tool\` / \`host-tool\` 无需反复调 \`api_read\` 或开子代理）**：
   - 第一步：调用 \`builtin-dstu_plugin_propose_install\`（推荐传 \`autoGenerate: false\`，新建插件不传 \`pluginId\`，升级已有工坊插件时传其 \`workshop.plugin-...\`），拿到 Host 分配的 \`id\`、\`pluginId\`、\`serviceName\` 与 \`revision\`。
   - 第二步：调用 \`builtin-dstu_plugin_write_source\` 一次性写入 \`package.json\`、\`index.ts\`（及 \`ui.tsx\`）。源码中可直接使用 \`__PLUGIN_ID__\` 与 \`__SERVICE__\` 占位符（Host 会自动替换为真实的 \`pluginId\` 与 \`serviceName\`），在 \`ui.tsx\` 中通过 \`ctx.ui.i18n.addBundles({ 'zh-CN': { title: '中文名称' } })\` 注册中文导航名。
   - 第三步：调用 \`builtin-dstu_plugin_validate\` 编译并自检生命周期；通过后会自动冻结候选包并转为 \`pending-confirmation\`，聊天流内会直接展示交互式「插件工坊确认」卡片。
2. 如需探查特殊扩展点，再用 \`builtin-dstu_plugin_api_list\` / \`builtin-dstu_plugin_api_read\` 按需读取。
3. **用户在卡片上点击确认后立即热加载**：写入 profile、装载插件、刷新 UI manifest，
   不需要重启应用，也不需要手动拖拽文件夹；卡片上直接提供「试用（跳转打开）」、「撤销」、「恢复」、「让 AI 修改」按钮。
4. 需要配置时先用 \`builtin-dstu_plugin_config_get\` 读取 schema 和当前值，
   再用 \`builtin-dstu_plugin_configure\` 提交完整 values；运行中的插件 fiber 会
   立刻热更新（不需要重启）。
5. \`builtin-dstu_plugin_set_enabled\` 热启用/停用托管插件；\`builtin-dstu_plugin_inventory\`
   查看所有插件的运行状态、信任级别与是否有可配置项。

## 工具与敏感度

- \`builtin-dstu_plugin_api_list\` / \`builtin-dstu_plugin_api_read\`：Low，只读 API 发现。
- \`builtin-dstu_plugin_status\` / \`builtin-dstu_plugin_diagnose\`：Low，只读本会话作品与诊断。
- \`builtin-dstu_plugin_inventory\` / \`builtin-dstu_plugin_config_get\`：Low，只读插件清单与配置。
- \`builtin-dstu_plugin_write_source\` / \`builtin-dstu_plugin_validate\` /
  \`builtin-dstu_plugin_rollback\` / \`builtin-dstu_plugin_export\`：Medium。
- \`builtin-dstu_plugin_propose_install\` / \`builtin-dstu_plugin_configure\` /
  \`builtin-dstu_plugin_set_enabled\` / \`builtin-dstu_plugin_app_restart\`：High，需要用户批准。

## 边界

- 只能改 Host 分配的会话源码根；不得触碰 profile、应用包、SDK 文件或已安装版本。
- 生成结束停在 pending-confirmation；\`write_source\` 不能改动已冻结的候选构建。
- \`builtin-dstu_plugin_export\` 只写本地 \`.dstuplugin\`，不发布。
- 视觉未实际观察时如实说“视觉未验证”。
- \`builtin-dstu_plugin_app_restart\` 只在用户明确要求重启应用时使用；安装与配置
  本身已经热加载，不需要重启。
`,
  allowedTools: [...PLUGIN_WORKSHOP_TOOL_NAMES],
  embeddedTools: [
    {
      name: 'builtin-dstu_plugin_api_list',
      description:
        '列出真实的 dstu SDK、service、slot、config、theme、模板与随包资源（Low，只读）。选择扩展点前先调用。',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['sdk', 'services', 'slots', 'config', 'theme', 'examples', 'resources'],
            description: '要列举的类别；省略=全部',
          },
        },
      },
    },
    {
      name: 'builtin-dstu_plugin_api_read',
      description:
        '按 api_list 返回的准确 id 读取一条 API 或资源详情（Low，只读）。不会执行业务方法。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, description: 'api_list 返回的准确条目 id' },
        },
        required: ['id'],
      },
    },
    {
      name: 'builtin-dstu_plugin_propose_install',
      description:
        '提出一个托管插件作品；autoGenerate=true 时自主生成、编译、最多三轮修复并停在用户确认卡片（High，需要用户批准）。Agent 永不安装。',
      inputSchema: {
        type: 'object',
        properties: {
          autoGenerate: { type: 'boolean', description: 'true=立即开始生成；省略只创建草稿卡片' },
          title: { type: 'string', minLength: 1, description: '插件名称' },
          description: { type: 'string', minLength: 1, description: '要解决的问题与一个可观察的验收标准' },
          template: {
            type: 'string',
            enum: ['learning-tool', 'host-tool'],
            description: 'learning-tool=Host+UI；host-tool=仅 Host',
          },
          changes: { type: 'array', items: { type: 'string' }, description: '计划改动的条目' },
          capabilities: { type: 'array', items: { type: 'string' }, description: '需要的能力/服务' },
          pluginId: { type: 'string', description: 'Host 已分配的插件 id；新作品省略' },
        },
        required: ['title', 'description', 'template', 'changes', 'capabilities'],
      },
    },
    {
      name: 'builtin-dstu_plugin_status',
      description:
        '读取本会话的插件工坊作品（Low，只读）。省略 id 时列出本会话全部作品。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '作品 id；省略=本会话全部' },
        },
      },
    },
    {
      name: 'builtin-dstu_plugin_validate',
      description:
        '编译并试装载/卸载一个托管作品（Medium）。不安装；视觉仍未验证。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1, description: '作品 id' } },
        required: ['id'],
      },
    },
    {
      name: 'builtin-dstu_plugin_diagnose',
      description:
        '读取托管源码、编译错误、上一个可用版本与当前 Host 运行状态（Low，只读）。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1, description: '作品 id' } },
        required: ['id'],
      },
    },
    {
      name: 'builtin-dstu_plugin_write_source',
      description:
        '只修改本会话草稿/失败作品的源码文件（Medium）。不能安装，也不能改动已冻结的候选构建。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, description: '作品 id' },
          revision: { type: 'integer', description: 'status 返回的当前 revision' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', minLength: 1, description: '源码根内的相对路径' },
                content: { type: 'string', description: '完整文件内容' },
              },
              required: ['path', 'content'],
              additionalProperties: false,
            },
          },
        },
        required: ['id', 'revision', 'files'],
      },
    },
    {
      name: 'builtin-dstu_plugin_rollback',
      description:
        '把失败作品恢复到上一个用户已批准的可用版本（Medium）。不能安装 Agent 新代码。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, description: '作品 id' },
          revision: { type: 'integer', description: 'status 返回的当前 revision' },
        },
        required: ['id', 'revision'],
      },
    },
    {
      name: 'builtin-dstu_plugin_export',
      description:
        '把已校验作品导出为 Host 管理的本地 .dstuplugin 路径（Medium）。不发布。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1, description: '作品 id' } },
        required: ['id'],
      },
    },
    {
      name: 'builtin-dstu_plugin_inventory',
      description:
        '列出所有已安装插件（builtin / workshop / community）的运行状态、信任级别，以及是否有可配置项（hasConfig）（Low，只读）。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'builtin-dstu_plugin_config_get',
      description:
        '按 pluginId 读取插件配置 schema 与当前值（Low，只读）。先读再改，不要猜测字段。',
      inputSchema: {
        type: 'object',
        properties: {
          pluginId: { type: 'string', minLength: 1, description: '如 workshop.plugin-xxx 或内置插件 id' },
        },
        required: ['pluginId'],
      },
    },
    {
      name: 'builtin-dstu_plugin_configure',
      description:
        '按 pluginId 提交完整配置值，运行中的插件 fiber 立即热更新，不需要重启应用（High，需要用户批准）。',
      inputSchema: {
        type: 'object',
        properties: {
          pluginId: { type: 'string', minLength: 1, description: '目标插件 id' },
          values: {
            type: 'object',
            additionalProperties: true,
            description: '完整配置对象（按 config_get 的 schema）；整体替换当前值',
          },
        },
        required: ['pluginId', 'values'],
      },
    },
    {
      name: 'builtin-dstu_plugin_set_enabled',
      description:
        '按 pluginId 热启用或停用托管插件，立即装载/卸载（High，需要用户批准）。',
      inputSchema: {
        type: 'object',
        properties: {
          pluginId: { type: 'string', minLength: 1, description: '目标插件 id' },
          enabled: { type: 'boolean', description: 'true=启用并热装载；false=停用并卸载' },
        },
        required: ['pluginId', 'enabled'],
      },
    },
    {
      name: 'builtin-dstu_plugin_app_restart',
      description:
        '在用户明确确认后重启整个应用（High，需要用户批准）。注意：插件安装与配置都会自动热加载，不需要重启；仅当用户明确要求重启时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '用户要求重启的原话或原因' },
        },
      },
    },
  ],
};
