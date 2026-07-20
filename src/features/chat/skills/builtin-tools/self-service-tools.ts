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
   - 必须携带 \`expected_transport\`（取自 self_inspect 的 mcp 段），审批卡与执行期都会复核；不一致会被拒绝，防止凭名字误删
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
3. **信任**：新写入技能默认 **untrusted**，需用户在技能管理中信任后才能注入 runtime root；下一轮可 \`load_skills\` 使用正文

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
4. **删除**：\`builtin-custom_agent_remove\`（High，**必须用户审批且不可 remember**，不可撤销）；调用前先 get 确认内容，并把首行标题放进 \`title\` 参数供审批卡展示
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
      name: 'builtin-mcp_server_update',
      description:
        '修改已有 MCP server 配置（High 审批，不可 remember）。按 server_id（id 或名称）定位，只传要改的字段；先 self_inspect(section=mcp) 确认现状。禁止 env 明文，env_required 只收变量名（新增变量写占位符并自动停用，待用户在 Settings 填值）。无新增密钥需求且 server 启用中会自动连测，失败自动回滚旧配置。',
      inputSchema: {
        type: 'object',
        required: ['server_id'],
        additionalProperties: false,
        properties: {
          server_id: {
            type: 'string',
            description: '目标 server 的 id 或名称（可用 self_inspect 的 mcp 段查询）',
          },
          name: {
            type: 'string',
            description: '可选：新显示名称（id 保持不变；不得与其他 server 重名）',
          },
          transport: {
            type: 'string',
            enum: ['stdio', 'sse', 'http', 'websocket', 'streamable_http'],
            description: '可选：新传输类型（切到远程必须同时给 url；切到 stdio 必须有 command）',
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
              '可选（仅 stdio）：所需环境变量名全集（仅变量名，禁止传值；已填的值按变量名保留，新增变量写占位符，未列出的变量删除）',
          },
          url: {
            type: 'string',
            description: '可选（仅远程传输）：新 MCP 端点 URL（必须 https://）',
          },
          reason: {
            type: 'string',
            description: '可选：修改原因（展示在审批卡上）',
          },
        },
      },
    },
    {
      name: 'builtin-mcp_server_set_enabled',
      description:
        '启用或停用已有 MCP server（Medium，需确认）。停用会断开前端连接但保留配置与已填密钥；启用前 env 必须已填完（有占位符会被拒绝）。MCP 配置管理的唯一正门之一，禁止用 settings_set/shell 直改 mcp.tools.list。',
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
            description: '可选：启停原因（展示在确认卡上）',
          },
        },
      },
    },
    {
      name: 'builtin-mcp_server_remove',
      description:
        '删除 MCP server 配置（High 审批，不可 remember，不可恢复；连同已填密钥与 provenance 一并清理）。必须携带 expected_transport（取自 self_inspect 的 mcp 段），与存储不一致会被拒绝，防止凭名字误删。先向用户确认意图再调用。',
      inputSchema: {
        type: 'object',
        required: ['server_id', 'expected_transport'],
        additionalProperties: false,
        properties: {
          server_id: {
            type: 'string',
            description: '目标 server 的 id 或名称',
          },
          expected_transport: {
            type: 'string',
            enum: ['stdio', 'sse', 'http', 'websocket', 'streamable_http'],
            description: '必填：self_inspect 返回的该 server 当前 transport，用于审批卡展示与执行期复核',
          },
          reason: {
            type: 'string',
            description: '可选：删除原因（展示在审批卡上）',
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
    {
      name: 'builtin-skill_set_enabled',
      description:
        '启用或停用技能（Medium，需确认）。技能生命周期管理的唯一正门之一，禁止用 shell/文件工具改技能目录或启用状态。停用只影响后续轮次（退出 schema 收集/自动激活/手动选择），保留技能定义与文件；builtin 技能也可停用。重新启用传 enabled=true。',
      inputSchema: {
        type: 'object',
        required: ['skill_id', 'enabled'],
        additionalProperties: false,
        properties: {
          skill_id: {
            type: 'string',
            description: '目标技能 ID（仅字母数字、连字符、下划线；可用 self_inspect 的 skills 段查询）',
          },
          enabled: {
            type: 'boolean',
            description: 'true = 启用，false = 停用',
          },
          reason: {
            type: 'string',
            description: '可选：向用户说明启停原因（展示在确认卡上）',
          },
        },
      },
    },
    {
      name: 'builtin-skill_remove',
      description:
        '删除技能包（High，必须用户审批且不可 remember，不可撤销）。技能生命周期管理的唯一正门之一，禁止用 shell/文件工具删除技能目录。只能删除 ~/.deep-student/skills/<skill_id> 下的技能包；builtin 技能不可删除（可用 skill_set_enabled 停用或在技能管理页恢复默认）。删除同时清理 provenance 与信任记录。',
      inputSchema: {
        type: 'object',
        required: ['skill_id'],
        additionalProperties: false,
        properties: {
          skill_id: {
            type: 'string',
            description: '待删除技能包 ID（对应 ~/.deep-student/skills/ 下目录名）',
          },
        },
      },
    },
    {
      name: 'builtin-skill_trust_request',
      description:
        '申请信任 untrusted 技能。先 action=inspect（Low，只读现扫，返回整包 SHA-256 指纹 + 风险等级/信号，含 prompt injection 扫描）；向用户说明理由后再 action=grant（High，必须用户审批且不可 remember），原样携带 inspect 返回的 package_sha256 与 risk_level。信任绑定包内容指纹，包变化即失效；grant 前后指纹不一致会拒绝。这是授予技能信任的唯一正门，不得绕过指纹绑定。',
      inputSchema: {
        type: 'object',
        required: ['action', 'skill_id'],
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['inspect', 'grant'],
            description: 'inspect = 现扫指纹与风险；grant = 审批后授予绑定指纹的信任',
          },
          skill_id: {
            type: 'string',
            description: '目标技能 ID',
          },
          reason: {
            type: 'string',
            description: 'grant 必填：申请信任的理由（展示在审批卡上）',
          },
          expected_package_sha256: {
            type: 'string',
            description:
              'grant 必填：inspect 返回的 package_sha256，必须原样传递，不得自行重算',
          },
          declared_risk_level: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'grant 必填：inspect 返回的 risk_level，原样传递；现扫风险高于声明会拒绝',
          },
        },
      },
    },
    {
      name: 'builtin-custom_agent_list',
      description:
        '只读列出 workspaces/agents/ 下全部自定义子代理 persona 文件（文件名、frontmatter 摘要 name/description/base、字节数、修改时间）。persona 每次 subagent_call 现扫，落盘即生效。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-custom_agent_get',
      description:
        '只读读取指定自定义子代理 persona 全文（含 frontmatter 摘要、字节数、content_sha256、首行标题）。提案修改前必须先 get 最新内容。',
      inputSchema: {
        type: 'object',
        required: ['file_name'],
        additionalProperties: false,
        properties: {
          file_name: {
            type: 'string',
            description:
              'persona 文件名（含 .md，如 paper-summarizer.md；仅小写字母/数字/连字符）',
          },
        },
      },
    },
    {
      name: 'builtin-custom_agent_propose',
      description:
        '提案式起草新建/修改自定义子代理 persona（Medium）。写入独立 pending 提案区（不落盘 agents/），返回 proposal_id、content_sha256、proposal_revision 与 change_summary（新旧字节数/首行标题）。content 必须是完整 Markdown：frontmatter 需含合法 name（小写字母/数字/连字符，不得与内建 default/worker/explorer 冲突），≤64KB。附带 action=list 查 pending、action=reject 拒绝提案。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['propose', 'list', 'reject'],
            default: 'propose',
            description: 'propose=起草（默认）；list=查看 pending 提案；reject=拒绝提案',
          },
          file_name: {
            type: 'string',
            description:
              'propose 必填：目标 persona 文件名（含 .md；仅小写字母/数字/连字符）。已存在则为覆盖提案',
          },
          content: {
            type: 'string',
            description:
              'propose 必填：persona 完整 Markdown（--- frontmatter 声明 name/description/base/model/tools/skills，正文为子代理 instructions）',
          },
          proposal_id: {
            type: 'string',
            description: 'reject 必填：待拒绝的提案 ID（cap_<timestamp>_<suffix>）',
          },
        },
      },
    },
    {
      name: 'builtin-custom_agent_apply',
      description:
        '将已审阅的 persona 提案原子落盘到 workspaces/agents/（High 审批，不可 remember）。必须原样携带 propose 返回的内容摘要和 revision；审批后提案或目标文件变化都会 fail-closed 拒绝（需重新提案）。落盘后 persona 立即可被 subagent_call 使用。',
      inputSchema: {
        type: 'object',
        required: ['proposal_id', 'file_name', 'expected_content_sha256', 'expected_proposal_revision'],
        additionalProperties: false,
        properties: {
          proposal_id: {
            type: 'string',
            description: '待应用的提案 ID（来自 propose 返回或 action=list）',
          },
          file_name: {
            type: 'string',
            description: '提案返回的目标文件名，用于审批界面明确展示写入目标',
          },
          expected_content_sha256: {
            type: 'string',
            description: '必填：propose 返回的 content_sha256，必须原样传递，不得重算',
          },
          expected_proposal_revision: {
            type: 'string',
            description: '必填：同一 propose 返回的 proposal_revision，必须原样传递',
          },
          change_summary: {
            type: 'string',
            description:
              '建议携带：propose 返回的 change_summary（新旧字节数/首行标题），展示在审批卡上',
          },
        },
      },
    },
    {
      name: 'builtin-custom_agent_remove',
      description:
        '删除指定自定义子代理 persona 文件（High，必须用户审批且不可 remember，不可撤销）。调用前先 custom_agent_get 确认内容，并把首行标题放进 title 供审批卡展示。',
      inputSchema: {
        type: 'object',
        required: ['file_name'],
        additionalProperties: false,
        properties: {
          file_name: {
            type: 'string',
            description: '待删除的 persona 文件名（含 .md）',
          },
          title: {
            type: 'string',
            description: '可选：persona 首行标题（来自 custom_agent_get），展示在审批卡上',
          },
        },
      },
    },
  ],
};
