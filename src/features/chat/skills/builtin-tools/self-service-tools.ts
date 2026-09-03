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
    'Agent 自服务自查与 MCP 提案能力：只读、脱敏地查看当前 runtime root、已注册/已加载技能、MCP 配置摘要与 web 搜索配置可见性；可结构化提案新 MCP server（secret 由用户在 Settings 填写）；可通过 mcp_server_update / mcp_server_set_enabled / mcp_server_remove 管理已有 MCP server（修改/删除必审批）；可通过 skill_workshop 提案式沉淀/修改技能（apply 需用户审批）；可通过 skill_set_enabled / skill_remove / skill_trust_request 管理技能生命周期（启停/删除/申请信任，删除与信任必审批）；可通过 custom_agent_* 查看并提案式管理自定义子代理 persona（apply/remove 必审批）。任务开始前或不确定自己有哪些能力时优先使用。',
  version: '1.6.0',
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

## 管理已有 MCP server（mcp_server_update / mcp_server_set_enabled / mcp_server_remove）

这三个工具与 \`mcp_server_propose\` 一起构成 MCP server 配置管理的**唯一正门**。
任何修改、启停、删除都**不得**用 settings_set、shell 或文件工具直接改 \`mcp.tools.list\`。

1. **先自查**：任何管理操作前先 \`builtin-self_inspect\` 的 \`section: "mcp"\` 确认目标 server 的 id、transport 与 enabled 状态
2. **修改**：\`builtin-mcp_server_update\`（High，**必须用户审批且不可 remember**）
   - 按 \`server_id\` 定位（id 或名称），只传要改的字段（name/transport/command/args/env_required/url）
   - 凭据红线与 propose 相同：**禁止 env 明文**，\`env_required\` 只收变量名；新增变量会写占位符并自动停用，待用户在 Settings 填值后再启用
   - 无新增密钥需求且 server 启用中会自动连测，失败自动回滚旧配置
3. **启停**：\`builtin-mcp_server_set_enabled\`（Medium，需确认）
   - 停用会断开前端连接但保留配置与已填密钥；启用前必须已填完 env（否则会被拒绝）
4. **删除**：\`builtin-mcp_server_remove\`（High，**必须用户审批且不可 remember**，不可恢复）
   - 必须携带 \`expected_transport\` 与 \`expected_entry_revision\`（均取自 self_inspect 的 mcp 段），审批卡与执行期都会复核；内容变化会被拒绝
   - 删除连同已填密钥与 provenance 一并清理——先向用户确认意图再调用

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
3. **信任**：新写入技能默认 **untrusted**。下一步调用 \`builtin-skill_trust_request\`（先 \`action=inspect\` 再 \`grant\`，grant 必审批且不可 remember）；信任后才能注入 runtime root，再 \`load_skills\` 使用正文。「技能管理」仅作备用

## 技能生命周期管理（skill_set_enabled / skill_remove / skill_trust_request）

这三个工具与 \`skill_install\` / \`skill_workshop\` 一起构成技能生命周期管理的**唯一正门**。
任何启停、删除、信任操作都**不得**用 shell、文件工具或直接改 \`~/.deep-student/skills/\`（shell 已封侧门），也不得指导用户手改文件绕过。

1. **启停**：\`builtin-skill_set_enabled\`（Medium，需确认）
   - \`enabled: false\` 停用、\`true\` 重新启用；builtin 技能也可停用
   - 停用只影响**后续轮次**（退出 schema 收集/自动激活/手动选择）；本轮已加载的技能正文不受影响
   - 停用保留技能定义与文件，区别于删除
2. **删除**：\`builtin-skill_remove\`（High，**必须用户审批且不可 remember**）
   - 只能删除 \`~/.deep-student/skills/<skill_id>\` 下的技能包；builtin 技能不可删除（可停用或在技能管理页恢复默认）
   - 删除同时清理 provenance 与信任记录，不可撤销——先向用户确认意图再调用
3. **申请信任**：\`builtin-skill_trust_request\`
   - 先 \`action: "inspect"\`（Low，只读现扫）：返回当前整包 SHA-256 指纹、风险等级与风险信号（含 prompt injection 扫描）
   - 向用户说明申请理由与风险摘要后，再 \`action: "grant"\`（High，**必须用户审批且不可 remember**），原样携带 inspect 返回的 \`package_sha256\`（作为 \`expected_package_sha256\`）与 \`risk_level\`（作为 \`declared_risk_level\`），并填写 \`reason\`
   - 信任绑定包内容指纹：授予后包内容一旦变化信任自动失效；grant 前后指纹不一致会 fail-closed 拒绝，需重新 inspect

## 自定义子代理 persona 管理（custom_agent_*）

自定义子代理 persona 是 \`workspaces/agents/*.md\` 下的 Markdown 文件（YAML frontmatter 声明 name/description/base/model/tools/skills，正文替换 base profile 的 instructions），\`subagent_call\` 的 \`profile\` 可直接使用 frontmatter 的 name。管理 persona **只能**走 custom_agent_* 工具（提案+审批两段式），**不得**用 shell 或文件工具直接写 agents 目录。

### 何时建议用户沉淀 persona

出现以下信号时应**主动建议**（只建议、不擅自创建）把一套子代理设定沉淀为 persona：

1. **重复的子代理设定**：同一段角色指令/工具组合在多次 \`subagent_call\` 的 prompt 里反复出现
2. **稳定分工**：用户形成了固定的多代理分工（如"资料检索员 + 摘要员"），值得固化成可复用 profile
3. **跨会话线索**：用户提到"以后也这样分工""下次还用这个角色"

区分场景：一次性的角色指令直接写在 subagent_call 的 prompt 里即可；只有**会复用**的角色设定才值得沉淀成 persona。用户拒绝后本会话内不再提。

### 流程

1. **查看**：\`builtin-custom_agent_list\`（只读）列出全部 persona；\`builtin-custom_agent_get\` 读取指定文件全文（修改前必读最新版）
2. **提案**：\`builtin-custom_agent_propose\`（Medium）提交完整新内容（frontmatter 必含合法 \`name\`：小写字母/数字/连字符，不得与内建 default/worker/explorer 冲突；≤64KB）。返回 \`proposal_id\`、\`content_sha256\`、\`proposal_revision\` 与 \`change_summary\`（新旧字节数/首行标题）。附带 \`action: "list"\` 查 pending 提案、\`action: "reject"\` 拒绝提案
3. **生效**：向用户展示 change_summary（用户要求时展示全文）后调用 \`builtin-custom_agent_apply\`（High，**必须用户审批且不可 remember**），原样携带 propose 返回的 \`proposal_id\`、\`file_name\`、\`content_sha256\`（作为 \`expected_content_sha256\`）、\`proposal_revision\`（作为 \`expected_proposal_revision\`）与 \`change_summary\`；不得自行重算。审批后提案或目标文件发生变化会 fail-closed 拒绝，需重新提案
4. **删除**：\`builtin-custom_agent_remove\`（High，**必须用户审批且不可 remember**，不可撤销）；调用前先 get 确认内容，并原样传回 \`content_sha256\`（作为 \`expected_content_sha256\`），把首行标题放进 \`title\` 参数供审批卡展示
5. **生效时机**：persona 目录每次 \`subagent_call\` 现扫，落盘后立即可用，无需重启

## 纪律

- 不要猜测自己有哪些 root 或 MCP；先 self_inspect 再提案/修改
- 输出中不会出现密钥；若某键仅在 secure store 中，可能显示为未配置或不可见
- 绝不在工具参数中传递 env 值、api key 或 token
- MCP 配置的增改启停删只能经 \`mcp_server_propose\` / \`mcp_server_update\` / \`mcp_server_set_enabled\` / \`mcp_server_remove\`，禁止用 settings_set / shell / 文件工具直改 \`mcp.tools.list\`
- 技能目录写入只能经 \`skill_install\`（zip 包）或 \`skill_workshop\`（提案+审批），启停/删除/信任只能经 \`skill_set_enabled\` / \`skill_remove\` / \`skill_trust_request\`，禁止绕道 shell/文件工具
- 自定义子代理 persona 只能经 \`custom_agent_propose\` → 用户审批 \`custom_agent_apply\` 落盘、\`custom_agent_remove\` 删除，禁止绕道 shell/文件工具直接写 \`workspaces/agents/\`
`,
  embeddedTools: [
    {
      name: 'builtin-self_inspect',
      description:
        '只读、脱敏自查运行环境：runtime root、技能注册/加载状态、MCP 摘要、web 搜索配置可见性。任务开始或能力缺口时优先调用；输出不含密钥。',
      inputSchema: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            enum: ['roots', 'skills', 'mcp', 'search', 'all'],
            default: 'all',
            description:
              '可选过滤：roots/skills/mcp/search/all（默认全部）',
          },
        },
      },
    },
    {
      name: 'builtin-mcp_server_propose',
      description:
        '提案新增 MCP server（High 审批）。env_required 只收变量名（禁止传值），secret 由用户在 Settings 填写；无 secret 时自动连测，失败回滚。stdio 需 command，远程需 https url。',
      inputSchema: {
        type: 'object',
        required: ['name', 'transport', 'purpose'],
        additionalProperties: false,
        properties: {
          name: {
            type: 'string',
            description: 'MCP server 唯一名称',
          },
          transport: {
            type: 'string',
            enum: ['stdio', 'sse', 'http', 'websocket', 'streamable_http'],
            description: '传输类型',
          },
          purpose: {
            type: 'string',
            description: '一句话用途说明（审批卡展示）',
          },
          command: {
            type: 'string',
            description: 'stdio 必填：启动命令（如 npx）',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'stdio 可选：命令参数列表',
          },
          env_required: {
            type: 'array',
            items: { type: 'string' },
            description: 'stdio 可选：所需环境变量名（仅变量名，禁止传值）',
          },
          url: {
            type: 'string',
            description: '远程传输必填：MCP 端点 URL（须 https://）',
          },
        },
      },
    },
    {
      name: 'builtin-mcp_server_update',
      description:
        '修改已有 MCP server（High 审批，不可 remember）。先 self_inspect 确认现状，按 server_id 定位，只传要改字段；禁止 env 明文，新增变量写占位符并自动停用。无新增密钥且启用中自动连测，失败回滚。',
      inputSchema: {
        type: 'object',
        required: ['server_id'],
        additionalProperties: false,
        properties: {
          server_id: {
            type: 'string',
            description: '目标 server 的 id 或名称',
          },
          name: {
            type: 'string',
            description: '可选：新显示名称（id 不变；不得重名）',
          },
          transport: {
            type: 'string',
            enum: ['stdio', 'sse', 'http', 'websocket', 'streamable_http'],
            description: '可选：新传输类型（切远程须同时给 url；切 stdio 须有 command）',
          },
          command: {
            type: 'string',
            description: '可选（仅 stdio）：新启动命令',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: '可选（仅 stdio）：新参数列表（整体替换）',
          },
          env_required: {
            type: 'array',
            items: { type: 'string' },
            description:
              '可选（仅 stdio）：环境变量名全集（禁止传值；已填值按名保留，新增写占位符，未列出的删除）',
          },
          url: {
            type: 'string',
            description: '可选（仅远程）：新端点 URL（须 https://）',
          },
          reason: {
            type: 'string',
            description: '可选：修改原因（审批卡展示）',
          },
        },
      },
    },
    {
      name: 'builtin-mcp_server_set_enabled',
      description:
        '启用或停用 MCP server（Medium，需确认）。停用断开连接但保留配置与密钥；启用前 env 须已填完（有占位符被拒绝）。',
      inputSchema: {
        type: 'object',
        required: ['server_id', 'enabled'],
        additionalProperties: false,
        properties: {
          server_id: {
            type: 'string',
            description: '目标 server 的 id 或名称',
          },
          enabled: {
            type: 'boolean',
            description: 'true = 启用，false = 停用',
          },
          reason: {
            type: 'string',
            description: '可选：启停原因（确认卡展示）',
          },
        },
      },
    },
    {
      name: 'builtin-mcp_server_remove',
      description:
        '删除 MCP server（High 审批，不可 remember，不可恢复；连同密钥与 provenance 清理）。须携带 self_inspect 返回的 expected_transport 与 expected_entry_revision，配置变化 fail-closed。',
      inputSchema: {
        type: 'object',
        required: ['server_id', 'expected_transport', 'expected_entry_revision'],
        additionalProperties: false,
        properties: {
          server_id: {
            type: 'string',
            description: '目标 server 的 id 或名称',
          },
          expected_transport: {
            type: 'string',
            enum: ['stdio', 'sse', 'http', 'websocket', 'streamable_http'],
            description: 'self_inspect 返回的当前 transport，执行期复核',
          },
          expected_entry_revision: {
            type: 'string',
            description: 'self_inspect 返回的当前 entry_revision，原样传回',
          },
          reason: {
            type: 'string',
            description: '可选：删除原因（审批卡展示）',
          },
        },
      },
    },
    {
      name: 'builtin-skill_workshop_propose',
      description:
        '提案式创建/更新 SkillPackage 草稿（Medium）。content 表示单个 SKILL.md；files 提交完整文件清单（文本 content，二进制 content_base64）。返回逐文件 SHA-256 与 package_sha256。',
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
            description: 'propose_* 必填：技能 ID（仅字母数字、连字符、下划线）',
          },
          content: {
            type: 'string',
            description: 'propose_* 必填：完整 SKILL.md 文本（含 --- 开头的 frontmatter）',
          },
          files: {
            type: 'array',
            maxItems: 256,
            description:
              'propose_* 可选：完整包文件清单，与 content 二选一；须含 SKILL.md，只允许 scripts/、references/、assets/ 子路径。',
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
            description: 'reject 必填：待拒绝的提案 ID',
          },
        },
      },
    },
    {
      name: 'builtin-skill_workshop_apply',
      description:
        '将已审阅的 pending 技能提案写入 skills 目录（High 审批，不可 remember）。原样携带 propose/list 返回的摘要和 revision，内容变化会拒绝；新技能默认 untrusted，下一步 skill_trust_request。propose_create 目标已存在需 overwrite=true。',
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
            description: '待应用的提案 ID',
          },
          skill_id: {
            type: 'string',
            description: '提案返回的目标技能 ID',
          },
          expected_content_sha256: {
            type: 'string',
            description: 'propose/list 返回的 content_sha256，原样传递，不得重算',
          },
          expected_proposal_revision: {
            type: 'string',
            description: '同一 propose/list 返回的 proposal_revision，原样传递',
          },
          overwrite: {
            type: 'boolean',
            description: 'propose_create 目标目录已存在时须显式 true',
          },
        },
      },
    },
    {
      name: 'builtin-skill_set_enabled',
      description:
        '启用或停用技能（Medium，需确认）。停用只影响后续轮次，保留定义与文件；builtin 也可停用。',
      inputSchema: {
        type: 'object',
        required: ['skill_id', 'enabled'],
        additionalProperties: false,
        properties: {
          skill_id: {
            type: 'string',
            description: '目标技能 ID',
          },
          enabled: {
            type: 'boolean',
            description: 'true = 启用，false = 停用',
          },
          reason: {
            type: 'string',
            description: '可选：启停原因（确认卡展示）',
          },
        },
      },
    },
    {
      name: 'builtin-skill_remove',
      description:
        '删除技能包（High 审批，不可 remember，不可撤销；禁止绕道 shell/文件工具）。只能删 skills/<skill_id> 下的包，builtin 不可删除（可停用）；同时清理 provenance 与信任记录。',
      inputSchema: {
        type: 'object',
        required: ['skill_id'],
        additionalProperties: false,
        properties: {
          skill_id: {
            type: 'string',
            description: '待删除技能包 ID（skills/ 下目录名）',
          },
        },
      },
    },
    {
      name: 'builtin-skill_trust_request',
      description:
        '申请信任 untrusted 技能（唯一正门）。先 action=inspect（Low，现扫整包指纹与风险）；再 action=grant（High 审批，不可 remember），原样携带 inspect 返回的 package_sha256 与 risk_level。信任绑定指纹，包变化即失效。',
      inputSchema: {
        type: 'object',
        required: ['action', 'skill_id'],
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['inspect', 'grant'],
            description: 'inspect = 现扫指纹与风险；grant = 审批后授予信任',
          },
          skill_id: {
            type: 'string',
            description: '目标技能 ID',
          },
          reason: {
            type: 'string',
            description: 'grant 必填：申请理由（审批卡展示）',
          },
          expected_package_sha256: {
            type: 'string',
            description: 'grant 必填：inspect 返回的 package_sha256，原样传递',
          },
          declared_risk_level: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'grant 必填：inspect 返回的 risk_level；现扫风险更高会拒绝',
          },
        },
      },
    },
    {
      name: 'builtin-custom_agent_list',
      description:
        '只读列出全部 persona（文件名、frontmatter 摘要、字节数、修改时间）；每次 subagent_call 现扫，落盘即生效。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-custom_agent_get',
      description:
        '只读读取指定 persona 全文（含 frontmatter 摘要、字节数、content_sha256、首行标题）。提案修改前必须先 get 最新内容。',
      inputSchema: {
        type: 'object',
        required: ['file_name'],
        additionalProperties: false,
        properties: {
          file_name: {
            type: 'string',
            description: 'persona 文件名（含 .md；仅小写字母/数字/连字符）',
          },
        },
      },
    },
    {
      name: 'builtin-custom_agent_propose',
      description:
        '提案式起草新建/修改 persona（Medium，不直接落盘），返回 proposal_id、content_sha256、proposal_revision 与 change_summary。content 须是完整 Markdown（frontmatter 含合法 name，不与内建冲突，≤64KB）。action=list 查 pending、reject 拒绝提案。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['propose', 'list', 'reject'],
            default: 'propose',
            description: 'propose=起草（默认）；list=查 pending；reject=拒绝',
          },
          file_name: {
            type: 'string',
            description: 'propose 必填：目标文件名（含 .md）；已存在则为覆盖提案',
          },
          content: {
            type: 'string',
            description: 'propose 必填：persona 完整 Markdown（frontmatter+instructions，字段见技能说明）',
          },
          proposal_id: {
            type: 'string',
            description: 'reject 必填：待拒绝的提案 ID',
          },
        },
      },
    },
    {
      name: 'builtin-custom_agent_apply',
      description:
        '将已审阅的 persona 提案原子落盘（High 审批，不可 remember）。原样携带 propose 返回的摘要和 revision，内容变化 fail-closed；落盘后立即可用。',
      inputSchema: {
        type: 'object',
        required: ['proposal_id', 'file_name', 'expected_content_sha256', 'expected_proposal_revision'],
        additionalProperties: false,
        properties: {
          proposal_id: {
            type: 'string',
            description: '待应用的提案 ID',
          },
          file_name: {
            type: 'string',
            description: '提案返回的目标文件名',
          },
          expected_content_sha256: {
            type: 'string',
            description: 'propose 返回的 content_sha256，原样传递，不得重算',
          },
          expected_proposal_revision: {
            type: 'string',
            description: '同一 propose 返回的 proposal_revision，原样传递',
          },
          change_summary: {
            type: 'string',
            description: '建议携带：propose 返回的 change_summary（审批卡展示）',
          },
        },
      },
    },
    {
      name: 'builtin-custom_agent_remove',
      description:
        '删除指定 persona 文件（High 审批，不可 remember，不可撤销）。先 custom_agent_get 确认并原样传回 content_sha256，首行标题放进 title。',
      inputSchema: {
        type: 'object',
        required: ['file_name', 'expected_content_sha256'],
        additionalProperties: false,
        properties: {
          file_name: {
            type: 'string',
            description: '待删除的 persona 文件名（含 .md）',
          },
          expected_content_sha256: {
            type: 'string',
            description: 'custom_agent_get 返回的 content_sha256，原样传回；内容变化会 fail-closed',
          },
          title: {
            type: 'string',
            description: '可选：persona 首行标题（审批卡展示）',
          },
        },
      },
    },
  ],
};
