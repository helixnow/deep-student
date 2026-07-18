/**
 * Agent 自服务自查技能组
 *
 * 提供 self_inspect 只读工具与 mcp_server_propose 提案工具，
 * 让 agent 在任务开始或遇到能力缺口时先了解自身 runtime 状态并结构化提案 MCP 配置。
 */

import type { SkillDefinition } from '../types';

export const selfServiceToolsSkill: SkillDefinition = {
  id: 'self-service-tools',
  name: 'self-service-tools',
  description:
    'Agent 自服务自查与 MCP 提案能力：只读、脱敏地查看当前 runtime root、已注册/已加载技能、MCP 配置摘要与 web 搜索配置可见性；可结构化提案新 MCP server（secret 由用户在 Settings 填写）；可通过 skill_workshop 提案式沉淀/修改技能（apply 需用户审批）。任务开始前或不确定自己有哪些能力时优先使用。',
  version: '1.3.0',
  author: 'Deep Student',
  priority: 8,
  location: 'builtin',
  sourcePath: 'builtin://self-service-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# Agent 自服务自查技能

在动手执行、报错反推、或向用户索要授权之前，先用 **builtin-self_inspect** 了解当前运行环境。输出已全部脱敏，不含 API key、token 或 secure store 明文。

## 何时使用

- 任务刚开始，不确定自己有哪些 runtime root、技能或 MCP
- 工具调用失败，怀疑缺目录授权、缺技能包或缺 MCP 配置
- 需要判断 web 搜索是否已配置（只看键名与是否已配置，不看密钥）
- 用户给出 MCP server 官方文档链接，需要读文档后提案配置

## 用法

\`\`\`json
{ "section": "all" }
\`\`\`

可选 \`section\`：\`roots\` | \`skills\` | \`mcp\` | \`search\` | \`all\`（默认）。

## 读完之后怎么做

1. **缺目录**：向用户说明需要的用途，请求授权 runtime root（或请用户在 Settings > 工具权限 中添加）
2. **缺技能**：先用 \`load_skills\` 加载已注册技能；若技能包未安装，请用户安装或后续使用 skill_install
3. **缺 MCP**：先用 \`builtin-web_fetch\` 读官方 README/文档确认 command/args/env 变量名，再用 **builtin-mcp_server_propose** 提交结构化提案；env 只传变量名，密钥由用户在 Settings > MCP 工具 中填写并启用
4. **web 搜索不可用**：检查 \`search.runtime_enabled\` 与 \`search.settings\` 中相关键是否已配置

## 配置 MCP server 的流程

1. **读文档**：用 \`builtin-web_fetch\` 抓取官方 README/安装说明，确认 transport、command、args、所需 env 变量名（不要猜测密钥）
2. **查重**：\`builtin-self_inspect\` 的 \`section: "mcp"\` 查看已配置 server，避免重复
3. **提案**：调用 \`builtin-mcp_server_propose\`，填写 name、transport、purpose；stdio 时填 command/args/env_required（仅变量名）
4. **用户收尾**：审批通过后，若需 secret 会写入 disabled 占位配置——告知用户去 **Settings > MCP 工具** 填写 env 值并启用；无 secret 需求时会自动连测，失败会回滚

## 沉淀/修改技能（skill_workshop）

当用户要求把对话工作流沉淀为技能、或你发现已加载技能正文有错需修复时，**必须**走 workshop 正门，**不得**用 shell、文件工具或直接写 \`~/.deep-student/skills/\`（shell 已封侧门）。

### 主动沉淀触发策略（何时建议创建技能）

除了用户明确要求，出现以下信号时应**主动建议**（只建议、不擅自创建）把工作流沉淀为技能：

1. **重复工作流**：本次会话中同一套多步骤流程被执行了 ≥2 次，或用户提到"每次都要这样做/上次也是这么做的"
2. **稳定产出格式**：用户反复要求同一种输出格式/模板（报告结构、笔记格式、批改流程）
3. **纠偏收敛**：用户对你的做法做了多次纠正后流程终于稳定——这套修正后的流程值得固化
4. **跨会话线索**：用户提到"以后""下次""经常"等表达长期需求的词

建议话术要点：说明沉淀成技能后可以一句话复用（面板勾选或 \`/skill-id\`），并列出你准备写入的技能骨架（name/description/触发场景/步骤）。用户同意后再走 \`skill_workshop_propose\` → 用户审批 \`skill_workshop_apply\`。

**克制**：一次会话最多主动建议一次；用户拒绝后本会话内不再提。简单一次性任务不建议沉淀。

1. **提案**：\`builtin-skill_workshop_propose\`
   - \`propose_create\`：新技能，需提供 \`skill_id\`（字母数字-_）与完整 \`content\`（含 \`---\` frontmatter 的 SKILL.md 全文，≤40000 字节）
   - \`propose_update\`：修改已有技能，目标须已存在于 \`~/.deep-student/skills/<skill_id>/\`
   - \`list\`：查看 pending 提案
   - \`reject\`：按 \`proposal_id\` 拒绝提案（留审计）
2. **生效**：用户审阅后调用 \`builtin-skill_workshop_apply\`（High，**必须用户审批且不可 remember**），原样携带 propose/list 返回的 \`proposal_id\`、\`skill_id\`、\`content_sha256\`（作为 \`expected_content_sha256\`）和 \`proposal_revision\`（作为 \`expected_proposal_revision\`）；不得自行重算或更新摘要。\`propose_create\` 目标目录已存在时需 \`overwrite: true\`
3. **信任**：新写入技能默认 **untrusted**，需用户在技能管理中信任后才能注入 runtime root；下一轮可 \`load_skills\` 使用正文

## 纪律

- 不要猜测自己有哪些 root 或 MCP；先 self_inspect 再提案
- 输出中不会出现密钥；若某键仅在 secure store 中，可能显示为未配置或不可见
- 绝不在工具参数中传递 env 值、api key 或 token
- 技能目录写入只能经 \`skill_install\`（zip 包）或 \`skill_workshop\`（提案+审批），禁止绕道 shell/文件工具
`,
  embeddedTools: [
    {
      name: 'builtin-self_inspect',
      description:
        '只读、脱敏自查当前 agent 运行环境：runtime root 列表（含 path，与 Settings 展示一致）、已注册技能及 loaded/active 状态、MCP server 名称/传输/enabled 摘要、web_search.* 配置键可见性。任务开始或遇到能力缺口时优先调用；输出不含任何密钥或 tool_approval 策略。',
      inputSchema: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            enum: ['roots', 'skills', 'mcp', 'search', 'all'],
            default: 'all',
            description:
              '可选过滤：roots=runtime root，skills=技能注册/加载状态，mcp=MCP 配置摘要，search=web 搜索配置可见性，all=全部',
          },
        },
      },
    },
    {
      name: 'builtin-mcp_server_propose',
      description:
        '提案新增 MCP server 配置（High 审批）。先用 web_fetch 读官方文档确认参数；env_required 只收环境变量名（不传值），secret 由用户在 Settings > MCP 工具 填写并启用。无 secret 需求时写入后自动连测，失败自动回滚。stdio 需 command；远程 transport 需 https url。',
      inputSchema: {
        type: 'object',
        required: ['name', 'transport', 'purpose'],
        additionalProperties: false,
        properties: {
          name: {
            type: 'string',
            description: 'MCP server 唯一名称（用于查重与 Settings 展示）',
          },
          transport: {
            type: 'string',
            enum: ['stdio', 'sse', 'http', 'websocket', 'streamable_http'],
            description: '传输类型',
          },
          purpose: {
            type: 'string',
            description: '一句话用途说明（展示在审批卡上）',
          },
          command: {
            type: 'string',
            description: 'stdio 传输必填：启动命令（如 npx）',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'stdio 可选：命令参数列表',
          },
          env_required: {
            type: 'array',
            items: { type: 'string' },
            description:
              'stdio 可选：所需环境变量名列表（仅变量名，禁止传值；用户稍后在 Settings 填写）',
          },
          url: {
            type: 'string',
            description: '远程传输必填：MCP 端点 URL（必须 https://）',
          },
        },
      },
    },
    {
      name: 'builtin-skill_workshop_propose',
      description:
        '提案式创建/更新完整 SkillPackage 草稿（Medium）。content 旧接口继续表示单个 SKILL.md；files 可提交 SKILL.md、scripts/、references/、assets/ 的完整文件清单（文本用 content，二进制用 content_base64）。返回逐文件 SHA-256 与 package_sha256。',
      inputSchema: {
        type: 'object',
        required: ['action'],
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['propose_create', 'propose_update', 'list', 'reject'],
            description: '提案动作',
          },
          skill_id: {
            type: 'string',
            description:
              'propose_create / propose_update 必填：技能 ID（仅字母数字、连字符、下划线）',
          },
          content: {
            type: 'string',
            description:
              'propose_create / propose_update 必填：完整 SKILL.md 文本（含 YAML frontmatter，以 --- 开头）',
          },
          files: {
            type: 'array',
            maxItems: 256,
            description:
              'propose_create / propose_update 可选：完整包文件清单；与旧 content 二选一。必须包含 SKILL.md，只允许 scripts/、references/、assets/ 子路径。',
            items: {
              type: 'object',
              required: ['path'],
              additionalProperties: false,
              properties: {
                path: { type: 'string', description: '包内相对路径，使用 / 分隔' },
                content: { type: 'string', description: 'UTF-8 文本内容' },
                content_base64: { type: 'string', description: '二进制内容的标准 base64' },
              },
            },
          },
          proposal_id: {
            type: 'string',
            description: 'reject 必填：待拒绝的提案 ID（wp_<timestamp>_<suffix>）',
          },
        },
      },
    },
    {
      name: 'builtin-skill_workshop_apply',
      description:
        '将已审阅的 pending 技能提案写入 ~/.deep-student/skills（High 审批，不可 remember）。必须原样携带 propose/list 返回的内容摘要和 revision；审批后任何提案或 SKILL.md 变化都会拒绝。写 provenance，新技能默认 untrusted。propose_create 目标已存在时需 overwrite=true。',
      inputSchema: {
        type: 'object',
        required: [
          'proposal_id',
          'skill_id',
          'expected_content_sha256',
          'expected_proposal_revision',
        ],
        additionalProperties: false,
        properties: {
          proposal_id: {
            type: 'string',
            description: '待应用的提案 ID（来自 propose 返回或 list）',
          },
          skill_id: {
            type: 'string',
            description: '提案返回的目标技能 ID，用于审批界面明确展示写入目标',
          },
          expected_content_sha256: {
            type: 'string',
            description:
              '必填：用户审阅的 propose/list 结果中的 content_sha256，必须原样传递，不得重算',
          },
          expected_proposal_revision: {
            type: 'string',
            description:
              '必填：同一 propose/list 结果中的 proposal_revision，必须原样传递',
          },
          overwrite: {
            type: 'boolean',
            description:
              'propose_create 时若目标技能目录已存在，必须显式 true 才允许覆盖',
          },
        },
      },
    },
  ],
};
