/**
 * 插件工坊技能组（自主插件工坊闭环）
 *
 * 让普通会话里的主 Chat Agent 拿到插件工坊的全部 `dstu_plugin_*` schema。用户一句“给我做个…小应用 /
 * 选中时多一个…按钮 / 以后我说…就…”就能进入工坊：发送前的意图预加载见 `../workshopIntent.ts`。
 *
 * 唯一路径：Agent 提出作品（卡片）→ 用户在卡片上点「开始做」（批准生成与试装载）→ Host 生成、编译、自检、修复
 * → 卡片「等你确认」→ 用户点「安装」。Agent 工具没有安装权限，也不能在用户点「开始做」之前写或校验源码。
 *
 * 后端 executor：`host/plugins/plugin-workshop/src/tools.ts`（前端工具名带 `builtin-` 前缀，路由时剥离）。
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
    'DSTU 插件工坊：把用户想要的、能留下来反复用的功能做成插件并装进应用。用户说“给我做个…小应用/小工具/插件”“想要一个…工具”“给…加个按钮/选中文字时多一个…按钮”“以后我说『…』就去…”“每次…自动…”“每天晚上帮我…”，或“改这个插件/把『X』改成…/调整插件配置”时使用（一次性的讲解、图表、练习不用它）。用户在卡片上点「开始做」才生成，点「安装」才安装。',
  version: '1.2.0',
  author: 'Deep Student',
  priority: 3,
  location: 'builtin',
  sourcePath: 'builtin://plugin-workshop-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  relatedSkills: ['ask-user'],
  content: `# DSTU 插件工坊技能

插件在应用进程内运行，安装即授予完整信任——这不是沙箱。只有用户在卡片上点击才会生成（「开始做」）和安装（「安装」）。

## 先判断，再提

0. **对照真实能力**：先 \`builtin-dstu_plugin_api_list\`（services / slots / examples）看有没有对应的服务、界面位置和配方。只使用 SDK 支持且插件已声明的能力。
   真做不到的（某个内置界面没有插槽、只在手机上用……）写进 \`limits\`，并把最接近的可行方案写进
   \`alternatives\`，不要装一个空壳。
   - **对照内置功能**：先 \`builtin-dstu_plugin_inventory\`。内置已经有类似功能（如专注计时之于番茄钟）时，在 \`builtinDifference\` 里用一句话写清
     「和内置『X』的区别」；完全重复就先告诉用户内置的在哪，问要不要还做。
   - **需要用户决定时**用 \`ask-user\` 选择卡澄清，其他细节按目标直接提案。
   - **第三方 API**：优先 \`service:pluginModel\`（用户当前的对话模型，不需要密钥）；必须用别家 API 时，加一个 \`kind: "secret"\` 的设置
     让用户在卡片上填，插件里用 \`ctx.pluginSecrets.get(key)\` 读。**用户在对话里贴出的密钥、token 绝不能抄进** \`title\` / \`description\` /
     \`changes\` / \`capabilities\` 或源码；请用户在卡片的密码框里填。
   - **改已有作品**：\`builtin-dstu_plugin_status\` 列出所有对话的作品（\`ownedHere\`）。用户说「把『X』改成…」「那个按钮…」「X 插件…」时找到它，
     用它的 \`pluginId\` 提出修改；不属于本对话时卡片会显示「在这个对话里修改『X』」，请用户点一下，再用同一个 \`pluginId\` 重新提出。

## 唯一路径（和用户看到的卡片一致）

1. **马上提出作品**：调用 \`builtin-dstu_plugin_propose_install\`，写清 \`title\`（简短中文名）、\`description\`（目标 + 一个可观察的验收标准）、
   \`template\`（\`learning-tool\` = Host + 界面；\`host-tool\` = 仅 Host，例如教 AI 助手一个新工具）、\`changes\`、\`capabilities\`（照实写）。
   新作品不传 \`pluginId\`；修改已有工坊作品时传 \`dstu_plugin_status\` 里的 \`workshop.plugin-...\`。
   只有用户知道的值（如课表 .ics 地址）放进 \`settings\`：\`[{"key":"calendarUrl","title":"课表日历地址（.ics）","kind":"ics-url"}]\`；
   用户已经说过才带 \`value\`，绝不编造地址。卡片会在里面向用户要缺的值。
2. **然后停下**：用一句话请用户看卡片并点「开始做」（有输入框就先填）。点「开始做」就是批准生成代码并在应用里试装载；
   在那之前 \`write_source\` / \`validate\` 会被拒绝。不要轮询。
3. **Host 来做**：用模型写源码、编译、试装载/卸载，按确切错误最多修三轮，卡片上实时显示进度；课表地址会被真实读取一次
   （必须是 VCALENDAR），用户地址的 \`net:<主机>\` 由 Host 声明，修改作品的新版本号也由 Host 生成——你不用改版本号。
4. **一次点击安装**：卡片显示「等你确认」、能做什么、装好后在哪里找到它和「安装」；用户点击后立即热加载，不需要重启。
5. **改或修**：用同一个 \`pluginId\` 再提一次（写清 \`changes\`），用户再点「开始做」。只有已经开始过、失败了的作品，才可以自己
   \`builtin-dstu_plugin_diagnose\` → \`builtin-dstu_plugin_write_source\`（最小修改）→ \`builtin-dstu_plugin_validate\`；期间卡片会显示“AI 正在改代码”。

## 三类常见作品（Host 生成时照配方写）

- **速查/参考小应用**（公式速查、单词表）：\`learning-tool\`；界面用 \`DsSearchInput\`、\`DsCard\`、\`DsListItem\`、\`DsBadge\`，公式用 \`MathText\`
  （安全 KaTeX，不要 dangerouslySetInnerHTML）。配方 \`examples:resources/dstu-workshop/recipes/reference-app/ui.tsx\`。
- **选中文字后的按钮调用模型**（编成口诀）：\`learning-tool\` + \`service:pluginModel\`；往 \`editor.selectionToolbar\` 贡献
  \`showLabel: true\` 的按钮，结果显示在 \`createPluginOverlay(ctx)\` 里。装好后已打开的笔记也会立刻出现按钮。配方 \`.../recipes/selection-model/ui.tsx\`。
- **教 AI 助手新本事**（“以后我说『查课表』就去读…”）：\`host-tool\` + \`agentTools\` + \`agent:tools\`；联网只能 \`tool.fetch\`；地址从插件配置
  \`apply(ctx, config)\` 的 \`config.calendarUrl\` 读，缺了就给出清楚的提示。配方 \`.../recipes/agent-tool/index.ts\`。

## 安装之后

- 配置：\`builtin-dstu_plugin_inventory\` → \`builtin-dstu_plugin_config_get\` → \`builtin-dstu_plugin_configure\`（整体提交，立即热更新）。
- \`builtin-dstu_plugin_set_enabled\` 热启用/停用；\`builtin-dstu_plugin_export\` 只写本地 \`.dstuplugin\`；
  \`builtin-dstu_plugin_app_restart\` 只在用户明确要求重启应用时使用。

## 工具与敏感度

- Low（只读）：\`api_list\` / \`api_read\` / \`status\` / \`diagnose\` / \`inventory\` / \`config_get\`。
- Medium：\`propose_install\`（只建卡片，不写不跑代码；真正的批准在卡片上）、\`write_source\` / \`validate\` / \`rollback\` / \`export\`。
  “问一问”模式会拦下它们；“想一想”模式按计划确认；谨慎预设会逐次询问；默认预设不弹审批条。
- High（需要用户批准）：\`configure\` / \`set_enabled\` / \`app_restart\`。

## 边界

- 只能改 Host 分配的源码根；不得触碰 profile、应用包、SDK 文件或已安装版本；\`write_source\` 不能改动已冻结的候选。
- 视觉未实际观察时如实说“视觉未验证”。
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
        '提出一个托管插件作品，在对话里显示卡片（Medium，只建卡片）。用户点「开始做」后 Host 生成、编译、试装载、最多三轮修复，停在「安装」确认。Agent 永不生成后直接安装。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, description: '插件名称' },
          description: { type: 'string', minLength: 1, description: '要解决的问题与一个可观察的验收标准' },
          template: {
            type: 'string',
            enum: ['learning-tool', 'host-tool'],
            description: 'learning-tool=Host+UI；host-tool=仅 Host',
          },
          changes: { type: 'array', items: { type: 'string' }, description: '计划改动的条目' },
          capabilities: { type: 'array', items: { type: 'string' }, description: '需要的能力/服务' },
          settings: {
            type: 'array',
            description: '只有用户知道的值（如课表 .ics 地址）；卡片会向用户要缺的值，安装后成为插件配置 config[key]',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: '配置键，如 calendarUrl；密钥用 kind "secret"（如 apiKey）' },
                title: { type: 'string', description: '给用户看的名称，如「课表日历地址（.ics）」' },
                kind: { type: 'string', enum: ['ics-url', 'https-url', 'text', 'secret'], description: 'ics-url 会被真实读取一次并要求是日历；secret 由用户在卡片上填，存进系统安全存储，插件用 pluginSecrets.get(key) 读' },
                value: { type: 'string', description: '仅用于非密钥字段；secret 必须省略 value' },
              },
              required: ['key', 'title', 'kind'],
              additionalProperties: false,
            },
          },
          pluginId: { type: 'string', description: 'Host 已分配的插件 id；新作品省略' },
          limits: { type: 'array', items: { type: 'string' }, description: '真做不到的部分（人话），卡片显示为「做不到的部分」' },
          alternatives: { type: 'array', items: { type: 'string' }, description: '代替做不到部分的最近可行方案，卡片显示为「改成这样」' },
          builtinDifference: { type: 'string', description: '内置已有类似功能时，一句话写清和内置『X』的区别' },
        },
        required: ['title', 'description', 'template', 'changes', 'capabilities'],
      },
    },
    {
      name: 'builtin-dstu_plugin_status',
      description:
        '读取所有对话的插件工坊作品（Low，只读）；ownedHere=false 的作品要用户在卡片上点「在这个对话里修改」后才能在这里改。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '作品 id；省略=全部作品' },
        },
      },
    },
    {
      name: 'builtin-dstu_plugin_validate',
      description:
        '编译并试装载/卸载一个托管作品（Medium）。只用于用户点过「开始做」、后来失败的作品；不安装；视觉仍未验证。',
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
        '只修改本会话中用户点过「开始做」、后来失败的作品的源码（Medium）。Host 生成期间不可用；不能安装，也不能改动已冻结的候选构建。',
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

/**
 * 手机端的同名技能：插件工坊只在电脑版上运行（Host 插件 platforms: desktop），手机上没有 `dstu_plugin_*` 工具。
 * 用同一个 id 占位，意图预加载（workshopIntent）命中时模型如实说明“要在电脑版上做”，而不是去调用不存在的工具。
 */
export const pluginWorkshopMobileSkill: BuiltinToolSkill = {
  ...pluginWorkshopToolsSkill,
  description:
    'DSTU 插件工坊（手机端）：用户想把功能做成插件 / 小应用 / 按钮时使用。手机上不能做插件，只能如实说明要在电脑版 DeepStudent 上做。',
  content: `# 插件工坊（手机端）

插件只能在电脑版 DeepStudent 上做和安装：手机上没有插件工坊，也没有任何 \`dstu_plugin_*\` 工具，不要尝试调用它们。

用户想做插件、小应用、选中文字时的按钮或“以后我说…就…”这类能反复用的功能时：

1. 用一句话如实说明：插件要在电脑版 DeepStudent 上做（打开电脑版，在对话里说同样的话即可）；做好的插件也只在电脑上可用。
2. 如果这次的需求能直接回答（讲解、计算、整理），照常回答，不要因此拒绝。
3. 可以帮用户把想法写成一句清楚的需求，方便他到电脑上直接说。`,
  allowedTools: [],
  embeddedTools: [],
};
