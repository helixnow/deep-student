/**
 * 工作区协作技能组
 *
 * 支持多 Agent 协作的工作区管理
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

const WORKSPACE_TOOL_NAMES = [
  'builtin-workspace_create',
  'builtin-workspace_create_agent',
  'builtin-subagent_call',
  'builtin-workspace_send',
  'builtin-workspace_query',
  'builtin-workspace_set_context',
  'builtin-workspace_get_context',
  'builtin-workspace_update_document',
  'builtin-workspace_read_document',
  'builtin-workspace_file_list',
  'builtin-workspace_file_read',
  'builtin-workspace_artifact_write',
  'builtin-workspace_file_write',
  'builtin-workspace_file_move',
  'builtin-workspace_file_delete',
  'builtin-workspace_change_revert',
  'builtin-attachment_stage',
  'builtin-local_shell_preflight',
  'builtin-local_shell_execute',
  'builtin-coordinator_sleep',
  'builtin-skill_scan',
  'builtin-skill_install',
] as const;

export const workspaceToolsSkill: SkillDefinition = {
  id: 'workspace-tools',
  name: 'workspace-tools',
  description: '工作区协作与本地运行时能力组：创建多 Agent 协作工作区、注册或即时派发 Worker（workspace_create/create_agent/subagent_call）、共享上下文和文档；并提供受授权目录约束的本地文件读取/列目录、会话产物写入，以及经用户审批的本地 shell 命令预检与执行。当需要多 Agent 协作、读取用户授权的本地资料，或在本机执行命令类任务时使用。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 8,
  location: 'builtin',
  sourcePath: 'builtin://workspace-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 工作区协作技能

当你需要把任务委托给子代理，或协调多个 Agent 完成复杂任务时，使用这些工具：

## 子代理委托决策树

按场景选择路径，不要混用：

1. **单个委托任务（最常见）**：直接调用 \`builtin-subagent_call\`（默认 wait=true 阻塞等待）。不需要预先 workspace_create，也不需要 coordinator_sleep——子代理的最终输出就在工具返回值的 \`output\` 字段里。
2. **并行 fan-out 且本回合要汇总结果**：多次调用 \`builtin-subagent_call\` 并显式传 \`wait: false\` 立即拿到各自的 ids，全部派发完后调用**一次** \`builtin-coordinator_sleep\` 统一等待；唤醒后继续在本回合汇总各子代理结果。
3. **后台异步（自己还有活 / 或干完就结束）**：以 \`wait: false\` 派发子代理后**继续做你自己的工作**（或干完就结束本回合），**不要**调用 \`coordinator_sleep\`——每当一个后台子代理完成，系统会以内部唤醒回合把完成摘要注入模型（聊天界面不出现伪用户消息）；模型会收到以 \`[子代理完成通知]\` 开头的唤醒内容。多个后台子代理各自完成时会各唤醒一次。期间可用 \`builtin-workspace_query\`（query_type="tasks"）查询后台任务状态与结果摘要。被唤醒后先消化该结果，再视需要检查其余任务，不要重复派发相同任务。
4. **多代理长期协作 / 共享文档**：走 workspace 三件套高级路径（workspace_create → workspace_create_agent → workspace_query/send，配合 coordinator_sleep）。

### 续跑与自定义代理

- **续跑（resume）**：需要对**同一个**子代理追问或迭代时，不要新开子代理——再次调用 \`builtin-subagent_call\`，传 \`resume_agent_session_id\`（首次返回的 \`agent_session_id\`）并带上首次返回的 \`workspace_id\`。续跑复用已持久化 profile，必须省略 \`profile\`、\`skill_id\`、\`model\`；后端会把新 task 作为追问投给同一会话（保留其全部历史上下文），返回值 \`resumed: true\`。
- **自定义 profile**：用户可在 \`{appData}/workspaces/agents/\` 目录放置 markdown 文件定义自定义子代理档案，之后其 \`name\` 就能作为 \`profile\` 参数使用。最小示例：

\`\`\`markdown
---
name: reviewer
description: 只读代码审阅代理
base: worker
---
你是代码审阅者，只指出问题，不改写代码。
\`\`\`

frontmatter 里 \`name\` 必填（小写字母/数字/连字符，不得与内建名冲突）；可选 \`base\`（缺省 worker）、\`model\`、\`tools\`（只能是只读白名单 + workspace 协作工具的子集）；正文即 instructions。

## 工具选择指南

### 工作区管理
- **builtin-workspace_create**: 创建新工作区（仅高级协作路径需要；subagent_call 缺省 workspace_id 时会自动创建）
- **builtin-workspace_create_agent**: 在工作区中注册 Agent；提供 initial_task 时由后端运行时直接派发（返回 status:"dispatched"）
- **builtin-subagent_call**: 单 Task 委托工具：即时创建并派发一个子代理，默认阻塞直到完成并在返回值中直接携带最终输出
- **builtin-workspace_query**: 查询工作区信息

### 等待子代理
- **builtin-coordinator_sleep**（决策树第 2 条）：并行 fan-out 且**本回合要汇总结果**时使用——全部以 wait=false 派发完成后调用**一次**，睡眠期间 pipeline 挂起，子代理完成后自动唤醒继续汇总。默认（wait=true）的 subagent_call 阻塞直接返回结果，不需要 sleep
- **后台异步（决策树第 3 条）**：派发后你还有自己的活，或干完就结束回合——**不要 sleep**；子代理完成后系统会通过内部唤醒回合注入以 \`[子代理完成通知]\` 开头的内容，聊天界面不会出现伪用户消息。期间用 \`workspace_query(query_type="tasks")\` 查询后台任务状态

### Workspace 三件套与编排边界

大多数委托场景只需要一次 \`builtin-subagent_call\`：不传 \`workspace_id\` 时后端会自动创建工作区并把当前会话注册为 coordinator（返回值 \`auto_created_workspace: true\`）；默认 wait=true 阻塞返回，\`output\` 字段即子代理最终结果。

需要显式编排多代理协作时，工作区三件套是：

1. \`builtin-workspace_create\` 建立共享工作区并取得 \`workspace_id\`；
2. \`builtin-workspace_create_agent\` 注册一个可协作的 Worker（提供 \`initial_task\` 时由后端运行时直接派发），或使用 \`builtin-subagent_call\` 按 \`task\`（可选 \`profile\` / \`skill_id\`）即时派发专用子代理；
3. 用 \`builtin-workspace_query\` / \`builtin-workspace_send\` 观察和沟通；对以 wait=false 派发的子代理，由协调者调用 \`builtin-coordinator_sleep\` 统一等待。

\`subagent_call\` 是 \`workspace_create_agent\` 的运行时派发路径，不是另一个未实现的 MCP 工具；同一任务只选择一种派发路径，避免重复创建 Worker。profile 选择指南：\`worker\`（默认）适合纯执行任务；\`explorer\` 拥有只读检索工具面，适合需要检索或阅读资料的调研任务。若使用 legacy 的 \`skill_id\`，必须是真实已加载的技能 ID（例如 \`subagent-worker\`、\`academic-search\`、\`document-processing\`）。子代理完成后的结果交付由运行时负责，不依赖子代理调用 workspace_send。

### 消息通信
- **builtin-workspace_send**: 向 Agent 发送消息

### 共享资源
- **builtin-workspace_set_context**: 设置共享上下文
- **builtin-workspace_get_context**: 获取共享上下文
- **builtin-workspace_update_document**: 创建/更新文档
- **builtin-workspace_read_document**: 读取文档
- **builtin-workspace_file_list**: 列出授权 runtime root 或当前 Skill package root 下的文件
- **builtin-workspace_file_read**: 读取授权 runtime root 或当前 Skill package root 下的 UTF-8 文本文件
- **builtin-workspace_artifact_write**: 写入会话产物目录并返回变更摘要
- **builtin-workspace_file_write**: 在显式授权为读写的 workspace 中创建或覆盖 UTF-8 文本文件
- **builtin-workspace_file_move**: 移动 workspace 文件，要求携带读取时取得的当前 hash
- **builtin-workspace_file_delete**: 删除 workspace 文件，要求携带读取时取得的当前 hash
- **builtin-workspace_change_revert**: 使用变更工具返回的完整 mutation_receipt 回滚该次变更
- **builtin-attachment_stage**: 把聊天附件的原始字节物化到会话 temp root 的 attachments/ 子目录，返回 root_id + relative_path，供 workspace 文件工具或 local_shell_execute（cwd 选 temp）继续处理二进制/大文件
- **builtin-local_shell_preflight**: 检查本地命令、cwd、runtime root 与风险等级，但不会执行命令
- **builtin-local_shell_execute**: 经用户审批后执行非交互本地命令，返回 exit code、stdout/stderr 与截断状态

本地执行器不是交互式终端：没有 PTY、stdin 或持久 shell session。macOS 固定使用 \`/bin/sh -c\`；Windows 固定使用受信任 System32 路径下的 Windows PowerShell（\`-NoProfile -NonInteractive\`，UTF-8 输出）；Linux 桌面使用 bubblewrap（bwrap）沙箱包裹的 \`/bin/sh -c\`（UTF-8 输出），系统未安装 bubblewrap 时预检会报告沙箱不可用并拒绝执行，此时应提示用户安装 bubblewrap 包；其余平台（移动端）当前不支持本地 shell。每次真实执行都必须经过用户审批，网络默认禁止，只有显式 \`allow_network=true\` 的独立审批 scope 才可放行。

### 本地命令的执行根选择
- 与用户项目文件相关的命令使用 \`root_id=workspace\`；如果 workspace 未配置，应提示用户选择工作区，不要在其他 root 中猜测项目位置。
- 与项目文件无关的系统查询和能力测试（例如 \`uname -a\`、版本查询）直接使用 \`root_id=temp\`。
- 明确需要生成交付文件时使用 \`root_id=artifacts\`。
- \`temp\` 和 \`artifacts\` 是会话自带的内部根，预检会自动确保目录存在。禁止为了“初始化目录”写 README、占位文件或空产物。
- 同一命令只做一次有效预检；预检通过后直接提交 execute。不要在 workspace、temp、artifacts 之间重复试探。

不确定自己有哪些 runtime root、技能或 MCP 时，先用 self-service-tools 技能组的 **builtin-self_inspect** 自查（只读、脱敏）。

## 处理用户发送的附件

用户通过聊天输入区上传的文件默认存储在 VFS blob 中，**不在 runtime root 文件系统可达范围内**。\`attachment_read\` 只能返回解析文本或 base64，无法提供磁盘路径，因此 xlsx/zip/图片等二进制附件不能直接交给 shell 或脚本处理。

**推荐流程**：

1. 从消息上下文的 \`<attachment ... source_id="...">\` 或 \`builtin-attachment_list\` 获取 \`message_id\` 与 \`attachment_id\`（context ref 的 \`source_id\` / \`resource_id\` 即 attachment_id）。
2. 调用 **builtin-attachment_stage**，把附件原始字节物化到当前会话 temp root 的 \`attachments/\` 子目录；返回 \`{ root_id: "temp", relative_path: "attachments/<name>", staged: "staged"|"already_staged" }\`。
3. 用 **builtin-workspace_file_read**（\`root_id=temp\`, \`path=<relative_path>\`）读取文本预览，或 **builtin-local_shell_execute**（\`root_id=temp\`，cwd 指向 \`attachments\` 或具体文件所在目录）运行脚本处理。
4. 处理结果写入 **artifacts** root（\`workspace_artifact_write\`），并在最终回复中告知用户产物路径。

同内容（sha256 相同）重复物化会直接复用既有路径；同名不同内容会自动加序号后缀。

## 安装用户提供的技能包

用户发来 zip 技能包时，**禁止**用 shell 直接写入 \`~/.deep-student/skills\`（会被 local_shell 封侧门拦截）。请走治理正门：

1. 若 zip 在聊天附件里：先用 **builtin-attachment_stage** 物化到 temp root（见上文「处理用户发送的附件」）。
2. 调用 **builtin-skill_scan**（Low，免审批）：\`source\` 填 \`{ url: "https://..." }\` 或 \`{ root_id: "temp", path: "attachments/xxx.zip" }\`；返回 \`package_sha256\`、\`risk_level\`、\`risk_signals\` 等扫描摘要。
3. 向用户展示风险与能力摘要，口头确认后再调用 **builtin-skill_install**（High，**必须用户审批**）：携带相同 \`source\`、必填 \`expected_sha256\` 和 \`skill_id\`（均来自 scan 结果）、可选 \`declared_risk_level\` 与 \`overwrite\`。
4. 安装成功后告知用户：技能已装入 \`~/.deep-student/skills/<id>/\`，**默认未信任**；需在技能管理中信任后，包内脚本才可通过 SKILL_DIR 执行。

**禁止**用 shell / 文件工具绕过上述流程直接改技能目录。

## 运行 Skill 包内脚本（SKILL_DIR）

Skill 包目录（skill:<skillId>）是只读的，不能作为 cwd 执行命令。要运行 Skill 自带的 scripts/ 脚本：

1. 调用 local_shell_preflight / local_shell_execute 时传 skill_root_id（如 skill:pdf-tools），执行器会向子进程注入环境变量 SKILL_DIR，指向该 Skill 包根目录的绝对路径。
2. cwd 仍然使用 workspace、temp 或 artifacts 等可执行 root，不要尝试把 skill:<skillId> 当 cwd。
3. 命令里通过环境变量引用脚本路径并给路径加引号：Windows PowerShell 用 \`python "$env:SKILL_DIR/scripts/convert.py"\`；macOS/Linux 的 \`/bin/sh\` 用 \`python "$SKILL_DIR/scripts/convert.py"\`。不要把 Windows 命令写成 cmd 的 \`%SKILL_DIR%\` 语法。
4. 脚本产物请写到 temp 或 artifacts（cwd 所在 root），不要试图写回 SKILL_DIR。

## 产物交付纪律

- 用 builtin-workspace_artifact_write 写入产物后，必须在最终回复中明确告诉用户：写入了哪个文件（相对路径）、内容是什么，以及可以在任务面板 Changes 中预览/打开/存为笔记。
- 一次任务产生多个产物时，任务收尾必须给出产物清单（相对路径 + 一句话用途）。
- 禁止「静默写文件」：写了产物但最终回复中不提及，是不可接受的交付方式。
- 通过 builtin-local_shell_execute 执行命令产生的文件产物，同样适用以上交付要求。
`,
  allowedTools: [...WORKSPACE_TOOL_NAMES],
  embeddedTools: [
    {
      name: 'builtin-workspace_create',
      description:
        '创建一个新的多 Agent 协作工作区。当用户需要多个 Agent 协作完成复杂任务时使用。工作区创建后，可以在其中注册多个 Worker Agent 分工协作。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '工作区名称（可选，不指定则自动生成）' },
        },
      },
    },
    {
      name: 'builtin-workspace_create_agent',
      description:
        '在工作区中创建一个新的 Agent。必须先创建工作区（workspace_create）。提供 initial_task 时由后端运行时直接派发任务（返回 status:"dispatched"），不依赖前端启动；不提供 initial_task 则 Worker 保持空闲状态，不会处理后续消息。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          role: {
            type: 'string',
            enum: ['coordinator', 'worker'],
            description: 'Agent 角色：worker（执行者，默认）',
          },
          skill_id: { type: 'string', description: '技能 ID，指定 Worker 使用的预置技能（可选）' },
          initial_task: { type: 'string', description: '【推荐】初始任务描述。提供此参数后 Worker 会立即自动启动执行任务并返回结果，不提供则 Worker 保持空闲' },
        },
        required: ['workspace_id'],
      },
    },
    {
      // Progressive disclosure forwards embeddedTools to Chat V2; keep this as
      // the single production schema for subagent_call instead of duplicating
      // an unconsumed Rust schema beside the executor.
      name: 'builtin-subagent_call',
      description:
        '单 Task 委托工具：即时创建并派发一个子代理执行 task。默认 wait=true 阻塞直到子代理完成，返回值的 output 字段直接携带最终输出——单个委托任务不需要预先 workspace_create，也不需要之后 coordinator_sleep。不传 workspace_id 时后端自动创建工作区并把当前会话注册为 coordinator（返回 auto_created_workspace=true）。并行多任务时用 wait=false 派发多个子代理拿到 ids，再调用一次 coordinator_sleep 统一等待。profile 选择：worker（默认）适合纯执行任务；explorer 拥有只读检索工具面（unified_search/rag_search/web_search/web_fetch/resource_list/resource_read/resource_search/folder_list/memory_read/memory_list），适合需要检索或读资料的调研任务；也支持用户自定义 profile（见 profile 参数说明）。对同一子代理追问/迭代时传 resume_agent_session_id 续跑，返回值携带 resumed 标记。终态返回值含 token_usage（可能为 null），反映子代理本次运行的 token 消耗。不要对同一任务同时调用 workspace_create_agent 和 subagent_call。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task: {
            type: 'string',
            minLength: 1,
            maxLength: 20000,
            description: '【必填】交给子代理执行的具体任务',
          },
          workspace_id: {
            type: 'string',
            minLength: 1,
            description:
              '可选。已创建的工作区 ID；缺省时后端自动创建工作区并把当前会话注册为 coordinator，返回值带 auto_created_workspace=true',
          },
          profile: {
            type: 'string',
            description:
              '可选。子代理配置档案：内建三型 worker=纯执行（默认）、explorer=只读检索工具面（适合调研/读资料任务）、default=完整默认工具面；也可以填用户自定义 profile 的 name。自定义 profile 是放在 {appData}/workspaces/agents/ 目录下的 markdown 文件：YAML frontmatter 里 name 必填（小写字母/数字/连字符，不得与 default/worker/explorer 冲突），可选 description、base（缺省 worker）、model、tools（只能是 headless 只读白名单 + workspace 协作工具的子集，越界项会被剔除），正文即 instructions——用户想要新档案时可以引导其创建这样的文件。传未知 profile 时后端报错并列出全部可用 profile',
          },
          resume_agent_session_id: {
            type: 'string',
            minLength: 1,
            description:
              '可选。续跑：传入首次 subagent_call 返回的 agent_session_id，后端跳过创建、复用已持久化 profile，把本次 task 作为追问投给同一个子代理会话。使用时 workspace_id 必填，并省略 profile、skill_id、model；返回值中 resumed=true',
          },
          skill_id: {
            type: 'string',
            minLength: 1,
            description:
              '可选（legacy 别名，通常优先用 profile）。真实技能 ID，例如 subagent-worker、academic-search、document-processing；不要填写不存在的技能名',
          },
          model: {
            type: 'string',
            description: '可选。覆盖子代理使用的模型',
          },
          context: {
            description: '可选：传给子代理的结构化上下文（任意 JSON 值）',
          },
          wait: {
            type: 'boolean',
            default: true,
            description:
              '可选，默认 true：阻塞等待子代理完成（内部预算 750s），返回值直接携带 output；超预算返回 status:"running" 与各项 ids。设为 false 立即返回 ids（后台异步/并行 fan-out 场景）：若要原地等待用 coordinator_sleep；若自己还有活要干就继续干，期间可用 workspace_query(query_type="tasks") 查状态，干完直接结束回合——子代理完成后系统会自动唤醒你',
          },
        },
        required: ['task'],
      },
    },
    {
      name: 'builtin-workspace_send',
      description:
        '向工作区中的 Agent 发送消息。必须已创建工作区并存在目标 Agent。注意：消息内容使用 content 参数（不是 message）。注意：对已结束/空闲的子代理，消息只入队不会触发执行；需要它继续处理时，请用 subagent_call 传 resume_agent_session_id 续跑（会一并消费积压消息）。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          content: { type: 'string', description: '【必填】消息内容文本，注意参数名是 content 不是 message' },
          target_session_id: { type: 'string', description: '目标 Agent 的会话 ID（可选，不指定则广播给所有 Agent）' },
          message_type: {
            type: 'string',
            enum: ['task', 'progress', 'result', 'query', 'correction', 'broadcast'],
            description: '消息类型（可选，默认 task）',
          },
        },
        required: ['workspace_id', 'content'],
      },
    },
    {
      name: 'builtin-workspace_query',
      description: '查询工作区信息，包括 Agent 列表、消息记录、文档等。必须已创建工作区。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          query_type: {
            type: 'string',
            enum: ['agents', 'messages', 'documents', 'context', 'tasks', 'all'],
            description: '查询类型；tasks=后台子代理任务状态（wait=false 派发后轮询用，含 status/result_summary）',
          },
          limit: { type: 'integer', description: '返回结果数量限制，默认 50', default: 50, minimum: 1, maximum: 200 },
        },
        required: ['workspace_id'],
      },
    },
    {
      name: 'builtin-workspace_set_context',
      description:
        '设置工作区共享上下文变量。必须已创建工作区。所有 Agent 都可以读取和修改共享上下文，用于协作时共享状态。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          key: { type: 'string', description: '【必填】上下文键名' },
          value: { description: '【必填】上下文值（任意 JSON 值）' },
        },
        required: ['workspace_id', 'key', 'value'],
      },
    },
    {
      name: 'builtin-workspace_get_context',
      description: '获取工作区共享上下文变量。必须已创建工作区。注意：必须同时提供 workspace_id 和 key 两个参数。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          key: { type: 'string', description: '【必填】上下文键名，如 "messages"、"state" 等' },
        },
        required: ['workspace_id', 'key'],
      },
    },
    {
      name: 'builtin-workspace_update_document',
      description:
        '在工作区中创建或更新文档。必须已创建工作区。文档可以是计划、研究笔记、产出物等，所有 Agent 都可以访问。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          title: { type: 'string', description: '【必填】文档标题' },
          content: { type: 'string', description: '【必填】文档内容' },
          doc_type: {
            type: 'string',
            enum: ['plan', 'research', 'artifact', 'notes'],
            description: '文档类型',
          },
        },
        required: ['workspace_id', 'title', 'content'],
      },
    },
    {
      name: 'builtin-workspace_read_document',
      description: '读取工作区中的文档。必须已创建工作区且文档存在。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          document_id: { type: 'string', description: '【必填】文档 ID' },
        },
        required: ['workspace_id', 'document_id'],
      },
    },
    {
      name: 'builtin-workspace_file_list',
      description:
        '列出授权 runtime root 或当前 Skill package root 下的文件。root_id 可选 workspace、artifacts、temp、Settings > 工具权限里显示的 authorized_* 目录 id，或当前已加载 Skill 的 skill:<skillId> 只读包目录。path 必须是相对路径。',
      inputSchema: {
        type: 'object',
        properties: {
          root_id: {
            type: 'string',
            description: 'Runtime root id，默认为 workspace；可填 artifacts、temp、authorized_* 授权目录 id，或当前已加载 Skill 的 skill:<skillId> 包目录',
          },
          path: {
            type: 'string',
            description: '所选 root 内的相对目录路径',
          },
          max_entries: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 200,
            description: '最多返回的条目数',
          },
        },
      },
    },
    {
      name: 'builtin-workspace_file_read',
      description:
        '读取授权 runtime root 或当前 Skill package root 下的 UTF-8 文本文件。path 必须是相对路径，且不能逃逸所选 root。',
      inputSchema: {
        type: 'object',
        properties: {
          root_id: {
            type: 'string',
            description: 'Runtime root id，默认为 workspace；可填 artifacts、temp、authorized_* 授权目录 id，或当前已加载 Skill 的 skill:<skillId> 包目录',
          },
          path: {
            type: 'string',
            description: '所选 root 内的相对文件路径',
          },
          max_bytes: {
            type: 'integer',
            minimum: 1,
            maximum: 1048576,
            default: 65536,
            description: '最多返回的字节数，超出会截断',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'builtin-workspace_artifact_write',
      description:
        '将 UTF-8 文本写入当前会话的产物目录，并返回 FileChangeSummary 供审计和任务面板 Changes 展示。',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '产物目录内的相对路径，例如 reports/summary.md',
          },
          content: {
            type: 'string',
            description: '要写入的 UTF-8 文本内容',
          },
          overwrite: {
            type: 'boolean',
            default: true,
            description: '如果目标已存在，是否允许覆盖',
          },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'builtin-workspace_file_write',
      description:
        '在用户显式授权为读写的 workspace 中创建或原子覆盖 UTF-8 文本文件，并返回可审计、可回滚的 mutation_receipt。修改已有文件前应先调用 workspace_file_read 获取 sha256，并作为 expected_current_hash 传入，防止覆盖并发修改。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'workspace 内的相对文件路径；禁止绝对路径、..、隐藏或敏感目录' },
          content: { type: 'string', description: '要写入的 UTF-8 文本内容' },
          expected_current_hash: {
            type: 'string',
            description: '修改已有文件时必传：最近一次 workspace_file_read 返回的 sha256；创建新文件时省略',
          },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'builtin-workspace_file_move',
      description:
        '在读写 workspace 内移动单个常规文件。必须携带源文件最近一次读取所得的 sha256，目标已存在时拒绝执行。返回可回滚的 mutation_receipt。',
      inputSchema: {
        type: 'object',
        properties: {
          source_path: { type: 'string', description: 'workspace 内的源文件相对路径' },
          destination_path: { type: 'string', description: 'workspace 内的目标文件相对路径' },
          expected_current_hash: { type: 'string', description: '源文件最近一次 workspace_file_read 返回的 sha256' },
        },
        required: ['source_path', 'destination_path', 'expected_current_hash'],
      },
    },
    {
      name: 'builtin-workspace_file_delete',
      description:
        '从读写 workspace 删除单个常规文件。必须携带最近一次读取所得的 sha256；删除前会创建受保护的检查点并返回可回滚的 mutation_receipt。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'workspace 内的相对文件路径' },
          expected_current_hash: { type: 'string', description: '文件最近一次 workspace_file_read 返回的 sha256' },
        },
        required: ['path', 'expected_current_hash'],
      },
    },
    {
      name: 'builtin-workspace_change_revert',
      description:
        '回滚 workspace 文件工具或 local_shell_execute 产生的变更。单文件使用原样 mutation_receipt，多文件使用原样 change_set；如果目标在变更后又被修改，回滚会拒绝执行。',
      inputSchema: {
        type: 'object',
        oneOf: [{ required: ['receipt'] }, { required: ['change_set'] }],
        properties: {
          receipt: {
            type: 'object',
            description: 'workspace 变更工具返回的完整 mutation_receipt',
            properties: {
              change_id: { type: 'string' },
              root_id: { type: 'string', enum: ['workspace'] },
              op: { type: 'string', enum: ['created', 'modified', 'moved', 'deleted'] },
              relative_path: { type: 'string' },
              destination_path: { type: 'string' },
              before_hash: { type: 'string' },
              after_hash: { type: 'string' },
              backup_ref: { type: 'string' },
              bytes: { type: 'integer', minimum: 0 },
            },
            required: ['change_id', 'root_id', 'op', 'relative_path', 'bytes'],
          },
          change_set: {
            type: 'object',
            description: 'local_shell_execute 或 workspace 变更流程返回的完整 change_set',
            properties: {
              id: { type: 'string' },
              changes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    change_id: { type: 'string' },
                    root_id: { type: 'string', enum: ['workspace'] },
                    op: { type: 'string', enum: ['created', 'modified', 'moved', 'deleted'] },
                    relative_path: { type: 'string' },
                    destination_path: { type: 'string' },
                    before_hash: { type: 'string' },
                    after_hash: { type: 'string' },
                    backup_ref: { type: 'string' },
                    bytes: { type: 'integer', minimum: 0 },
                  },
                  required: ['change_id', 'root_id', 'op', 'relative_path', 'bytes'],
                },
              },
            },
            required: ['id', 'changes'],
          },
        },
      },
    },
    {
      name: 'builtin-attachment_stage',
      description:
        '把聊天附件的原始字节物化到当前会话 temp runtime root 的 attachments/ 子目录，返回 { root_id: "temp", relative_path, size, sha256, original_name, staged: "staged"|"already_staged", hint }。适用于二进制或大文件（xlsx/zip/图片等）：物化后把返回的 root_id + relative_path 交给 builtin-workspace_file_read，或在 builtin-local_shell_execute 中以 temp 为 root_id 访问该文件。同内容（sha256 相同）重复物化会直接复用既有路径；同名不同内容会自动加序号后缀。附件定位参数与 builtin-attachment_read 一致（message_id + attachment_id；attachment_id 来自消息上下文的 source_id 或 builtin-attachment_list）。',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: {
            type: 'string',
            description: '【必填】附件所属的消息 ID，可通过 builtin-attachment_list 获取',
          },
          attachment_id: {
            type: 'string',
            description: '【必填】附件 ID（或消息 context ref 的资源 ID），可通过 builtin-attachment_list 获取',
          },
          filename: {
            type: 'string',
            description: '可选。覆盖物化目标文件名（仅文件名，不含目录；非法字符会被清洗，同名冲突自动加序号）',
          },
        },
        required: ['message_id', 'attachment_id'],
      },
    },
    {
      name: 'builtin-local_shell_preflight',
      description:
        '预检本地 shell 命令的 runtime root、cwd、平台 shell 合同、风险等级和审批信息。此工具只返回结构化分析，不会执行命令、启动进程或写入文件；任何真实执行仍必须单独经过用户审批。',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要预检的命令字符串。预检不会执行该命令。',
          },
          root_id: {
            type: 'string',
            description: 'Runtime root id。项目命令使用 workspace；无项目关联的系统查询使用 temp；交付文件使用 artifacts。temp/artifacts 会自动初始化，禁止写占位文件创建目录。也可填 authorized_* 授权目录 id。skill:<skillId> 包目录不能作为 cwd；运行包内脚本请使用 skill_root_id。',
          },
          cwd: {
            type: 'string',
            description: '所选 root 内的相对工作目录，默认为 root 本身。禁止绝对路径和 .. 逃逸。',
          },
          skill_root_id: {
            type: 'string',
            description:
              '可选。当前已加载 Skill 的包根 id（skill:<skillId>）。预检输出会标注执行时将注入的 SKILL_DIR 环境变量及其指向；skill 包根仍不能作为 cwd。',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 1000,
            maximum: 120000,
            default: 30000,
            description: '未来执行时建议使用的超时时间；当前仅用于预检展示。',
          },
          purpose: {
            type: 'string',
            description: '命令用途说明，便于后续审批 UI 展示。',
          },
        },
        required: ['command'],
      },
    },
    {
      name: 'builtin-local_shell_execute',
      description:
        '经用户审批后执行非交互本地 shell 命令。macOS 固定使用 /bin/sh -c；Windows 固定使用受信任 System32 Windows PowerShell（-NoProfile -NonInteractive，UTF-8 输出）；Linux 桌面使用 bubblewrap（bwrap）沙箱 + /bin/sh -c（需系统安装 bubblewrap，缺失时拒绝执行）；移动端不支持。执行前会重新校验 runtime root 和 cwd，强制 timeout，截断 stdout/stderr，并保存 tool block 审计记录；不提供 PTY、stdin 或持久 shell session，网络默认禁止。',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的命令字符串。此工具会真实执行命令，必须先经过审批。',
          },
          root_id: {
            type: 'string',
            description: 'Runtime root id，必须与通过的 preflight 一致。项目命令使用 workspace；无项目关联的系统查询使用 temp；交付文件使用 artifacts。也可填 Settings > 工具权限里显示的 authorized_* 目录 id。当前不支持直接在 skill:<skillId> 包目录内执行；要运行 Skill 包内脚本请改用 skill_root_id + SKILL_DIR。',
          },
          cwd: {
            type: 'string',
            description: '所选 root 内的相对工作目录，默认为 root 本身。禁止绝对路径和 .. 逃逸。',
          },
          skill_root_id: {
            type: 'string',
            description:
              '可选。当前已加载 Skill 的包根 id（skill:<skillId>）。提供后会向子进程注入 SKILL_DIR 环境变量（指向该 Skill 包根绝对路径），用于运行 Skill 自带脚本，例如 Windows PowerShell 中 python "$env:SKILL_DIR/scripts/x.py"。skill 包根仍不能作为 cwd；带 skill_root_id 的执行使用独立审批 scope。',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 1000,
            maximum: 120000,
            default: 30000,
            description: '命令超时时间。超时后会终止进程并返回 timed_out=true。',
          },
          inherit_env: {
            type: 'boolean',
            default: false,
            description:
              'Whether to inherit a sanitized allowlist of parent-process environment variables. Defaults to false. Sensitive and execution-control variables are always blocked; inherited key names are shown in the approval scope.',
          },
          allow_network: {
            type: 'boolean',
            default: false,
            description:
              'Whether this command is allowed to use network-capable command prefixes such as curl, wget, ssh, git fetch/pull/push, or package installs. Network-enabled approval uses a separate scope.',
          },
          track_file_changes: {
            type: 'boolean',
            default: true,
            description:
              'Whether to collect a bounded before/after metadata snapshot of cwd and return file_change_summary for audit. Required for workspace-mutating commands. Large/generated directories are skipped.',
          },
          env_allowlist: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional parent environment allowlist. When present, only these names plus platform-minimal variables are inherited.',
          },
          env_denylist: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional parent environment variables to remove before executing the command.',
          },
          env: {
            type: 'object',
            additionalProperties: true,
            description:
              'Optional explicit non-sensitive environment variables. Results audit variable names only, never values.',
          },
          max_output_bytes: {
            type: 'integer',
            minimum: 1024,
            maximum: 1048576,
            default: 65536,
            description: 'stdout 和 stderr 各自最多返回的字节数，超出会截断。',
          },
          purpose: {
            type: 'string',
            description: '命令用途说明，便于审批 UI 和审计记录理解。',
          },
        },
        required: ['command'],
      },
    },
    {
      name: 'builtin-coordinator_sleep',
      description:
        '等待以 wait=false 派发的子代理完成：睡眠期间 pipeline 挂起，收到子代理结果后自动唤醒继续执行，避免轮询浪费。并行 fan-out 时在全部派发完成后调用一次即可。默认（wait=true）的 subagent_call 阻塞直接返回结果，不需要调用本工具。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '【必填】工作区 ID' },
          awaiting_agents: {
            type: 'array',
            items: { type: 'string' },
            description: '等待的子代理 session_id 列表（可选，不指定则等待所有子代理）',
          },
          wake_condition: {
            type: 'string',
            enum: ['any_message', 'result_message', 'all_completed'],
            description: '唤醒条件：result_message=收到结果消息（默认），any_message=任意消息，all_completed=全部完成',
          },
          timeout_ms: {
            type: 'integer',
            description: '超时时间（毫秒），超时后自动唤醒。可选，默认无超时',
          },
        },
        required: ['workspace_id'],
      },
    },
    {
      name: 'builtin-skill_scan',
      description:
        'Scan a skill package zip without installing. Accepts https URL or a path under temp/artifacts runtime root. Returns skill_id, package_sha256, risk_level, risk_signals, and counts — pass the exact skill_id and expected_sha256 to skill_install after user confirmation.',
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'object',
            description:
              'Package source: { url: "https://..." } OR { root_id: "temp"|"artifacts", path: "relative/path.zip" }',
            properties: {
              url: { type: 'string', description: 'HTTPS URL to download the zip (max 64MB)' },
              root_id: {
                type: 'string',
                enum: ['temp', 'artifacts'],
                description: 'Runtime root containing the staged zip file',
              },
              path: {
                type: 'string',
                description: 'Relative path inside root_id (e.g. attachments/my-skill.zip)',
              },
            },
          },
        },
        required: ['source'],
      },
    },
    {
      name: 'builtin-skill_install',
      description:
        'Install a scanned skill package to ~/.deep-student/skills after user approval. Re-fetches source, verifies expected_sha256 matches scan, re-scans risk, writes provenance, default untrusted until user trusts in Skills management.',
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'object',
            description: 'Same source object used in skill_scan',
            properties: {
              url: { type: 'string' },
              root_id: { type: 'string', enum: ['temp', 'artifacts'] },
              path: { type: 'string' },
            },
          },
          expected_sha256: {
            type: 'string',
            description: 'Required SHA-256 hex from skill_scan package_sha256',
          },
          declared_risk_level: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'Risk level declared at scan time (default low); install fails if detected risk is higher',
          },
          overwrite: {
            type: 'boolean',
            description: 'Replace existing skill directory if present (default false)',
          },
          skill_id: {
            type: 'string',
            description:
              'Required exact skill id from skill_scan; install fails if the rescanned package target differs',
          },
        },
        required: ['source', 'expected_sha256', 'skill_id'],
      },
    },
  ],
};
