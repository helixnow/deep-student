/**
 * 工作区协作技能组
 *
 * 支持多 Agent 协作的工作区管理
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';
import { ATTACHMENT_STAGE_TOOL } from './attachment-tools';

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
  'builtin-workspace_text_search',
  'builtin-workspace_symbol_outline',
  'builtin-workspace_lsp_definition',
  'builtin-workspace_lsp_references',
  'builtin-workspace_lsp_hover',
  'builtin-workspace_lsp_document_symbols',
  'builtin-workspace_artifact_write',
  'builtin-workspace_file_write',
  'builtin-workspace_file_edit',
  'builtin-workspace_file_move',
  'builtin-workspace_file_delete',
  'builtin-workspace_change_revert',
  'builtin-attachment_stage',
  'builtin-local_shell_preflight',
  'builtin-local_shell_execute',
  'builtin-git_status',
  'builtin-git_diff',
  'builtin-git_log',
  'builtin-git_branch',
  'builtin-git_commit',
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
- **builtin-workspace_file_read**: 读取授权 runtime root 或当前 Skill package root 下的 UTF-8 文本文件；可用 offset/max_bytes 续读，返回 sha256（完整文件）、returned_bytes、next_offset、eof
- **builtin-workspace_text_search**: 在 workspace 中跨文件搜索文本/正则，返回路径、行列和单行预览
- **builtin-workspace_symbol_outline**: 提取单个源码文件的声明提纲，用于快速定位类、函数、类型等符号
- **builtin-workspace_lsp_definition**: 使用已安装语言服务器解析符号定义
- **builtin-workspace_lsp_references**: 使用已安装语言服务器查找符号引用
- **builtin-workspace_lsp_hover**: 获取符号类型、签名和文档信息
- **builtin-workspace_lsp_document_symbols**: 获取语言服务器生成的文档符号树
- **builtin-workspace_artifact_write**: 写入会话产物目录并返回变更摘要
- **builtin-workspace_file_write**: 在显式授权为读写的 workspace 中创建或覆盖 UTF-8 文本文件
- **builtin-workspace_file_edit**: 局部编辑 workspace 文件（search/replace），改代码/改文档的首选——只改匹配片段，不重写整个文件；每个 old_string 默认须唯一出现
- **builtin-workspace_file_move**: 移动 workspace 文件，要求携带读取时取得的当前 hash
- **builtin-workspace_file_delete**: 删除 workspace 文件，要求携带读取时取得的当前 hash
- **builtin-workspace_change_revert**: 使用变更工具返回的完整 mutation_receipt 回滚该次变更
- **builtin-attachment_stage**: 仅物化一个已知附件到 temp root，返回 root_id + relative_path；不是列表或搜索工具。已有 <attachment_metadata> 时直接使用 rootId/relativePath/objectHandle，不要再 stage；历史附件先 attachment_list
- **builtin-local_shell_preflight**: 检查本地命令、cwd、runtime root 与风险等级，但不会执行命令
- **builtin-local_shell_execute**: 提交非交互本地命令，由后端按当前会话档位决定静默执行或展示审批 UI，返回 exit code、stdout/stderr 与截断状态
- **builtin-git_status**: 结构化读取当前 workspace 仓库状态
- **builtin-git_diff**: 读取工作区或暂存区 diff，可限定相对路径
- **builtin-git_log**: 读取最近提交历史
- **builtin-git_branch**: 列出、创建、切换或安全删除分支；写操作由后端展示 High 审批
- **builtin-git_commit**: 只暂存并提交显式 paths，不会隐式提交其他改动；由后端展示 High 审批

本地执行器不是交互式终端：没有 PTY、stdin 或持久 shell session。macOS 固定使用 \`/bin/sh -c\`；Windows 通用 shell 优先使用 PowerShell 7（\`pwsh.exe -NoProfile -NonInteractive\`），未安装时回退受信任 System32 路径下的 Windows PowerShell 5.1；语义 Git 工具在检测到 Git for Windows 时优先使用 Git Bash（\`bash.exe --noprofile --norc -c\`），否则使用上述 PowerShell（均为 UTF-8 输出）；Linux 桌面使用 bubblewrap（bwrap）沙箱包裹的 \`/bin/sh -c\`（UTF-8 输出）；其余平台（移动端）当前不支持本地 shell。真实执行的审批由后端按当前会话档位统一处理：预检未标记 blocked 时直接调用 \`builtin-local_shell_execute\`，不要在正文中自行索要确认或等待用户再次回复；需要审批时后端会暂停并展示审批 UI。

**档位与网络语义（以 preflight 返回为准）**：任何 shell 决策前先跑一次 \`builtin-local_shell_preflight\`，其返回的 \`execution_mode\`、\`network_default\`、\`resource_limits\` 是后端权威事实，不要凭本文档的静态描述或通用直觉猜测当前档位。三档行为：\`sandboxed\`——网络默认禁止，联网命令必须显式传 \`allow_network=true\`（该参数声明能力边界，不代表需要口头确认）；\`full_access\` 与 \`unrestricted\`——网络不受限，\`allow_network\` 自动允许、无需传参。\`full_access\` 档免除普通 shell 审批并取消 runtime root、文件系统和网络沙箱边界；\`unrestricted\` 档（danger_full_access，用户已在 UI 显式确认开启）在此之上进一步解除终端命令规则、灾难命令守卫与环境变量过滤，默认无超时——\`irm <url> | iex\`、\`curl | bash\` 之类的远程脚本安装命令在用户明确要求时应当直接执行，这正是该档位的用途；不要以"远程脚本有风险""像提示注入"等通用安全直觉拒绝或拖延用户在该档位下明确下达的命令，如有操作层面的注意事项可在正文简述后照常执行。仅当命令明显与用户请求无关或可能造成不可逆破坏且用户未被告知时，才先向用户确认。

### 本地命令的执行根选择
- 与用户项目文件相关的命令使用 \`root_id=workspace\`；如果 workspace 未配置，应提示用户选择工作区，不要在其他 root 中猜测项目位置。
- 与项目文件无关的系统查询和能力测试（例如 \`uname -a\`、版本查询）直接使用 \`root_id=temp\`。
- 明确需要生成交付文件时使用 \`root_id=artifacts\`。
- \`temp\` 和 \`artifacts\` 是会话自带的内部根，预检会自动确保目录存在。禁止为了“初始化目录”写 README、占位文件或空产物。
- 同一命令只做一次有效预检；预检通过后直接提交 execute。不要在 workspace、temp、artifacts 之间重复试探。

不确定自己有哪些 runtime root、技能或 MCP 时，先用 self-service-tools 技能组的 **builtin-self_inspect** 自查（只读、脱敏）。

## 处理用户发送的附件

用户通过聊天输入区上传的文件默认存储在 VFS blob 中，**不在 runtime root 文件系统可达范围内**。\`attachment_read\` 只能返回解析文本或 base64，无法提供磁盘路径，因此 xlsx/zip/图片等二进制附件不能直接交给 shell 或脚本处理。\`attachment_stage\` 只物化一个已知附件，不是列表或搜索工具。

**推荐流程**：

1. 若消息上下文已有 \`<attachment_metadata>\`（含 \`rootId\` / \`relativePath\` / \`objectHandle\`）：直接使用这些字段，**不要**再调用 \`attachment_stage\`。
2. 历史附件（无 metadata）：先用 \`builtin-attachment_list\` 获取 \`message_id\` 与 \`attachment_id\`（context ref 的 \`source_id\` / \`resource_id\` 即 attachment_id），再调用 **builtin-attachment_stage** 物化到当前会话 temp root 的 \`attachments/\` 子目录；返回 \`{ root_id: "temp", relative_path: "attachments/<name>", staged: "staged"|"already_staged" }\`。
3. 用 **builtin-workspace_file_read**（\`root_id=temp\`, \`path=<relative_path>\`）读取文本预览，或 **builtin-local_shell_execute**（\`root_id=temp\`，cwd 指向 \`attachments\` 或具体文件所在目录）运行脚本处理。
4. 处理结果写入 **artifacts** root（\`workspace_artifact_write\`），并在最终回复中告知用户产物路径。

同内容（sha256 相同）重复物化会直接复用既有路径；同名不同内容会自动加序号后缀。

## 安装用户提供的技能包

用户发来 zip 技能包时，**禁止**用 shell 直接写入 \`~/.deep-student/skills\`（会被 local_shell 封侧门拦截）。请走治理正门：

1. 若 zip 在聊天附件里：已有 \`<attachment_metadata>\` 则直接用其路径；否则先用 **builtin-attachment_stage** 物化到 temp root（见上文「处理用户发送的附件」）。
2. 调用 **builtin-skill_scan**（Low，免审批）：\`source\` 填 \`{ url: "https://..." }\` 或 \`{ root_id: "temp", path: "attachments/xxx.zip" }\`；返回 \`package_sha256\`、\`risk_level\`、\`risk_signals\` 等扫描摘要。
3. 向用户展示风险与能力摘要后直接调用 **builtin-skill_install**（High）：携带相同 \`source\`、必填 \`expected_sha256\` 和 \`skill_id\`（均来自 scan 结果）、可选 \`declared_risk_level\` 与 \`overwrite\`。需要确认时由平台审批卡统一承接，不要先追加一次重复的文字确认。
4. 安装成功后：技能已装入 \`~/.deep-student/skills/<id>/\`，**默认未信任**。下一步调用 \`builtin-skill_trust_request\`（先 \`action=inspect\` 再 \`grant\`）；「技能管理」仅作备用。信任后再 \`load_skills\` / 跑 SKILL_DIR 脚本。

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
        '创建多 Agent 协作工作区（仅高级协作路径需要；subagent_call 缺省时会自动创建）。',
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
        '在已创建的工作区中注册 Agent。提供 initial_task 时由后端直接派发（返回 status:"dispatched"）；不提供则 Worker 保持空闲，不处理后续消息。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '工作区 ID' },
          role: {
            type: 'string',
            enum: ['coordinator', 'worker'],
            description: 'Agent 角色：worker（执行者，默认）',
          },
          skill_id: { type: 'string', description: '可选：Worker 预置技能 ID' },
          initial_task: { type: 'string', description: '【推荐】初始任务；提供后 Worker 立即执行并返回结果，否则保持空闲' },
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
        '单 Task 委托：即时创建并派发一个子代理。默认 wait=true 阻塞返回，output 字段即最终输出，无需预先 workspace_create 或事后 coordinator_sleep；缺省 workspace_id 时自动创建工作区（auto_created_workspace=true）。并行 fan-out 用 wait=false 拿 ids 后调一次 coordinator_sleep；追问同一子代理传 resume_agent_session_id 续跑。委托路径与 profile 选择见技能说明；终态含 token_usage（可能为 null）。不要对同一任务同时调用 workspace_create_agent。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task: {
            type: 'string',
            minLength: 1,
            maxLength: 20000,
            description: '交给子代理执行的具体任务',
          },
          workspace_id: {
            type: 'string',
            minLength: 1,
            description:
              '可选；缺省时自动创建工作区并把当前会话注册为 coordinator（auto_created_workspace=true）',
          },
          profile: {
            type: 'string',
            description:
              '可选。内建：worker=纯执行（默认）、explorer=只读检索工具面（调研/读资料）、default=完整默认工具面；也可填用户自定义 profile 的 name（定义方式见技能说明「自定义 profile」）。未知 profile 报错并列出可用项',
          },
          resume_agent_session_id: {
            type: 'string',
            minLength: 1,
            description:
              '可选。续跑：传首次返回的 agent_session_id，复用已持久化 profile，把本次 task 作为追问投给同一会话；须带 workspace_id 并省略 profile/skill_id/model，返回 resumed=true',
          },
          skill_id: {
            type: 'string',
            minLength: 1,
            description:
              '可选（legacy，优先用 profile）。真实技能 ID，如 subagent-worker、academic-search；不要填不存在的技能名',
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
              '默认 true：阻塞等待完成（预算 750s），返回 output，超预算返回 status:"running" 与 ids。false 立即返回 ids：本回合汇总用 coordinator_sleep 等待；否则继续自己的工作（可用 workspace_query(query_type="tasks") 查状态），子代理完成后系统自动唤醒',
          },
        },
        required: ['task'],
      },
    },
    {
      name: 'builtin-workspace_send',
      description:
        '向工作区中的 Agent 发送消息。对已结束/空闲的子代理消息只入队不触发执行；要它继续处理请用 subagent_call 续跑（会一并消费积压消息）。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '工作区 ID' },
          content: { type: 'string', description: '消息内容文本（参数名是 content 不是 message）' },
          target_session_id: { type: 'string', description: '目标 Agent 会话 ID（省略则广播）' },
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
      description: '查询工作区信息：Agent 列表、消息记录、文档、后台任务等。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '工作区 ID' },
          query_type: {
            type: 'string',
            enum: ['agents', 'messages', 'documents', 'context', 'tasks', 'all'],
            description: '查询类型；tasks=后台子代理任务状态（含 status/result_summary）',
          },
          limit: { type: 'integer', description: '返回数量限制', default: 50, minimum: 1, maximum: 200 },
        },
        required: ['workspace_id'],
      },
    },
    {
      name: 'builtin-workspace_set_context',
      description: '设置工作区共享上下文变量；所有 Agent 可读写，用于协作共享状态。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '工作区 ID' },
          key: { type: 'string', description: '上下文键名' },
          value: { description: '上下文值（任意 JSON 值）' },
        },
        required: ['workspace_id', 'key', 'value'],
      },
    },
    {
      name: 'builtin-workspace_get_context',
      description: '获取工作区共享上下文变量。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '工作区 ID' },
          key: { type: 'string', description: '上下文键名，如 "messages"、"state" 等' },
        },
        required: ['workspace_id', 'key'],
      },
    },
    {
      name: 'builtin-workspace_update_document',
      description: '在工作区中创建或更新文档（计划、研究笔记、产出物等），所有 Agent 可访问。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '工作区 ID' },
          title: { type: 'string', description: '文档标题' },
          content: { type: 'string', description: '文档内容' },
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
      description: '读取工作区中的文档。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '工作区 ID' },
          document_id: { type: 'string', description: '文档 ID' },
        },
        required: ['workspace_id', 'document_id'],
      },
    },
    {
      name: 'builtin-workspace_file_list',
      description:
        '列出授权 runtime root 或当前 Skill package root 下的文件；path 必须是相对路径。',
      inputSchema: {
        type: 'object',
        properties: {
          root_id: {
            type: 'string',
            description: 'Runtime root id，默认 workspace；可填 artifacts、temp、authorized_* 或 skill:<skillId> 只读包目录',
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
        '读取授权 runtime root 或当前 Skill package root 下的 UTF-8 文本文件。path 必须是相对路径，且不能逃逸所选 root。用 offset（UTF-8 字节偏移，须落在字符边界）与 max_bytes 分页续读；返回 content、returned_bytes、next_offset、eof、truncated，以及完整文件 sha256。offset 落在字符中间或超出 EOF 会拒绝；offset=EOF 返回空块。可用 expected_hash 校验内容未变。',
      inputSchema: {
        type: 'object',
        properties: {
          root_id: {
            type: 'string',
            description: 'Runtime root id，默认 workspace；可填 artifacts、temp、authorized_* 或 skill:<skillId> 只读包目录',
          },
          path: {
            type: 'string',
            description: '所选 root 内的相对文件路径',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'UTF-8 字节偏移，须落在字符边界；续读时传上次 next_offset',
          },
          max_bytes: {
            type: 'integer',
            minimum: 1,
            maximum: 1048576,
            default: 65536,
            description: '本次最多返回的正文字节数；结果还会按 30k JSON 预算再缩块，next_offset 按最终正文计算',
          },
          expected_hash: {
            type: 'string',
            description: '可选：上次读取返回的完整文件 sha256；不匹配则拒绝，需从 offset=0 重读',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'builtin-workspace_text_search',
      description:
        '在当前授权 workspace 中跨文件搜索文本。原生跨平台实现，不依赖 rg/shell；默认按字面量搜索，可启用 Rust regex，支持目录、扩展名和结果数限制。跳过隐藏目录、依赖/构建产物、符号链接和二进制/超大文件。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 500, description: '要查找的文本或正则表达式。' },
          path: { type: 'string', description: '可选的 workspace 相对目录；默认搜索整个 workspace。' },
          regex: { type: 'boolean', default: false, description: 'true 时将 query 解释为 Rust regex；默认按字面量匹配。' },
          case_sensitive: { type: 'boolean', default: true, description: '是否区分大小写。' },
          extensions: {
            type: 'array', maxItems: 32,
            items: { type: 'string', pattern: '^\\.?[A-Za-z0-9]+$' },
            description: '可选扩展名白名单，如 ["rs", "ts", "tsx"]。',
          },
          max_results: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        },
        required: ['query'],
      },
    },
    {
      name: 'builtin-workspace_symbol_outline',
      description:
        '提取 workspace 内单个 UTF-8 源码文件的声明提纲，返回符号名、类型、行号和签名预览。适合先了解文件结构；这是快速声明识别，不是编译器/LSP 级定义或引用解析。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1, description: 'workspace 内的源码文件相对路径。' },
          max_symbols: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
        },
        required: ['path'],
      },
    },
    {
      name: 'builtin-workspace_lsp_definition',
      description:
        '通过真实 LSP 查询符号定义。支持 Rust（rust-analyzer）、TypeScript/JavaScript（typescript-language-server）和 Python（pyright-langserver）；服务器须已安装。line/column 均为从 1 开始的 Unicode 字符位置。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1, description: 'workspace 内的源码文件相对路径。' },
          line: { type: 'integer', minimum: 1, description: '从 1 开始的行号。' },
          column: { type: 'integer', minimum: 1, description: '从 1 开始的 Unicode 字符列号。' },
        },
        required: ['path', 'line', 'column'],
      },
    },
    {
      name: 'builtin-workspace_lsp_references',
      description:
        '通过真实 LSP 查找符号引用。支持 Rust、TypeScript/JavaScript 和 Python；返回语言服务器原始 Location/LocationLink 结果。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1, description: 'workspace 内的源码文件相对路径。' },
          line: { type: 'integer', minimum: 1, description: '从 1 开始的行号。' },
          column: { type: 'integer', minimum: 1, description: '从 1 开始的 Unicode 字符列号。' },
          include_declaration: { type: 'boolean', default: true, description: '是否在结果中包含声明位置。' },
        },
        required: ['path', 'line', 'column'],
      },
    },
    {
      name: 'builtin-workspace_lsp_hover',
      description:
        '通过真实 LSP 获取指定符号的类型、签名和文档。支持 Rust、TypeScript/JavaScript 和 Python。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1, description: 'workspace 内的源码文件相对路径。' },
          line: { type: 'integer', minimum: 1, description: '从 1 开始的行号。' },
          column: { type: 'integer', minimum: 1, description: '从 1 开始的 Unicode 字符列号。' },
        },
        required: ['path', 'line', 'column'],
      },
    },
    {
      name: 'builtin-workspace_lsp_document_symbols',
      description:
        '通过真实 LSP 获取单个源码文件的文档符号树。若语言服务器未安装，可回退使用 workspace_symbol_outline 的启发式声明提纲。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1, description: 'workspace 内的源码文件相对路径。' },
        },
        required: ['path'],
      },
    },
    {
      name: 'builtin-workspace_artifact_write',
      description:
        '将 UTF-8 文本写入会话产物目录，返回 FileChangeSummary 供审计与 Changes 面板展示。',
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
        '在显式授权读写的 workspace 中创建或原子覆盖 UTF-8 文本文件，返回可回滚的 mutation_receipt。修改已有文件须先 workspace_file_read 取 sha256 作为 expected_current_hash。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'workspace 内的相对文件路径；禁止绝对路径、..、隐藏或敏感目录' },
          content: { type: 'string', description: '要写入的 UTF-8 文本内容' },
          expected_current_hash: {
            type: 'string',
            description: '修改已有文件时必传：最近 workspace_file_read 返回的 sha256；新建时省略',
          },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'builtin-workspace_file_edit',
      description:
        '局部编辑读写 workspace 中的 UTF-8 文本文件（search/replace），改代码/改文档首选——只替换匹配片段，不重写整个文件。每个 old_string 默认须在文件中唯一出现（防误替换），不唯一时提供更长的带上下文 old_string，或确认全部替换传 replace_all=true。须先 workspace_file_read 取 sha256 作为 expected_current_hash（OCC）。返回可回滚的 mutation_receipt 与每处替换次数。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'workspace 内的相对文件路径；禁止绝对路径、..、隐藏或敏感目录' },
          edits: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            description: '按顺序应用的编辑列表；任一失败则整体不落盘',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                old_string: { type: 'string', minLength: 1, description: '要被替换的原文片段（须唯一出现，除非 replace_all）' },
                new_string: { type: 'string', description: '替换后的新内容（可与 old_string 不同长度）' },
              },
              required: ['old_string', 'new_string'],
            },
          },
          expected_current_hash: {
            type: 'string',
            minLength: 1,
            description: '必填：最近 workspace_file_read 返回的 sha256；不匹配说明文件已被并发修改，需重新读取',
          },
          replace_all: {
            type: 'boolean',
            default: false,
            description: '为 true 时替换每个 old_string 的所有出现；默认 false 要求唯一匹配',
          },
        },
        required: ['path', 'edits', 'expected_current_hash'],
      },
    },
    {
      name: 'builtin-workspace_file_move',
      description:
        '在读写 workspace 内移动单个常规文件；须携带源文件最近读取的 sha256，目标已存在则拒绝。返回可回滚 mutation_receipt。',
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
        '从读写 workspace 删除单个常规文件；须携带最近读取的 sha256。删除前创建受保护检查点，返回可回滚 mutation_receipt。',
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
        '回滚 workspace 文件工具或 local_shell_execute 产生的变更：单文件传原样 mutation_receipt，多文件传原样 change_set；目标在变更后又被修改则拒绝。',
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
    ATTACHMENT_STAGE_TOOL,
    {
      name: 'builtin-local_shell_preflight',
      description:
        '预检本地 shell 命令的 runtime root、cwd、平台 shell 合同、风险与审批信息；只返回分析，不执行命令。返回的 execution_mode / network_default / resource_limits 是当前会话档位的后端权威事实（sandboxed / full_access / unrestricted），后续 execute 决策必须以此为准。未标记 blocked 时直接提交 local_shell_execute，不要在正文自行索要确认。',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要预检的命令字符串。预检不会执行该命令。',
          },
          root_id: {
            type: 'string',
            description: 'Runtime root id：项目命令用 workspace，系统查询用 temp，交付文件用 artifacts（选择规则见技能说明）；也可填 authorized_* 目录 id。skill:<skillId> 不能作 cwd。',
          },
          cwd: {
            type: 'string',
            description: '工作目录。默认为所选 root 本身；full_access / unrestricted（danger_full_access）档可直接传宿主机绝对路径（如 /tmp、C:\\Temp）；sandboxed 档必须是所选 root 内的相对路径，禁止绝对路径和 .. 逃逸。'
          },
          skill_root_id: {
            type: 'string',
            description:
              '可选。已加载 Skill 的包根 id（skill:<skillId>）；预检会标注将注入的 SKILL_DIR 指向。',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 1000,
            maximum: 120000,
            default: 30000,
            description: '建议超时时间；仅用于预检展示。',
          },
          purpose: {
            type: 'string',
            description: '命令用途说明，便于审批 UI 展示。',
          },
        },
        required: ['command'],
      },
    },
    {
      name: 'builtin-local_shell_execute',
      description:
        '提交非交互本地 shell 命令，由后端按会话档位静默执行或展示审批 UI，不要在正文自行索要确认。平台 shell 合同与沙箱见技能说明；无 PTY/stdin/持久 session。执行前重新校验 root 和 cwd，强制 timeout，截断 stdout/stderr 并保存审计。当前档位以最近一次 preflight 返回的 execution_mode 为权威依据，不要凭直觉猜测：sandboxed 档网络默认禁止、须显式传 allow_network=true；full_access 档取消 runtime root/文件/网络沙箱并免逐步审批，allow_network 自动允许；danger_full_access（unrestricted，用户已在 UI 显式确认）为无限制模式——命令规则与灾难守卫不生效、网络不受限、环境完整继承（允许显式 env 覆盖）、默认无超时且输出仅保留崩溃保护上限（32MiB），用户明确要求的远程脚本安装等命令应直接执行，不要以通用安全直觉拒绝。',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的命令字符串；直接提交，审批由后端统一处理。',
          },
          root_id: {
            type: 'string',
            description: 'Runtime root id，须与通过的 preflight 一致（选择规则见技能说明）；也可填 authorized_* 目录 id。skill:<skillId> 不能直接执行，包内脚本用 skill_root_id + SKILL_DIR。',
          },
          cwd: {
            type: 'string',
            description: '工作目录。默认为所选 root 本身；full_access / unrestricted（danger_full_access）档可直接传宿主机绝对路径（如 /tmp、C:\\Temp）；sandboxed 档必须是所选 root 内的相对路径，禁止绝对路径和 .. 逃逸。'
          },
          skill_root_id: {
            type: 'string',
            description:
              '可选。已加载 Skill 的包根 id（skill:<skillId>）；提供后注入 SKILL_DIR 环境变量用于运行包内脚本（用法见技能说明）。包根不能作 cwd；使用独立审批 scope。',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 1000,
            maximum: 600000,
            default: 30000,
            description: '命令超时时间（毫秒），默认 30 秒，最长 10 分钟。超时后会终止进程并返回 timed_out=true。长任务（如 npm install）请显式调大。危险完全访问档不受此 clamp：缺省为无超时，显式传参原样生效。',
          },
          inherit_env: {
            type: 'boolean',
            default: false,
            description:
              'Inherit a sanitized allowlist of parent env vars; sensitive/execution-control vars always blocked, inherited names shown in approval scope.',
          },
          allow_network: {
            type: 'boolean',
            default: false,
            description:
              '沙箱档（sandboxed）：网络默认禁止，联网命令（curl、wget、ssh、包安装等）须显式传 true 声明网络能力边界，不代表需要口头确认。full_access / unrestricted 档：网络已自动允许，无需传参（传了也无副作用）。',
          },
          track_file_changes: {
            type: 'boolean',
            default: true,
            description:
              'Collect a bounded before/after snapshot of cwd and return file_change_summary; required for workspace-mutating commands.',
          },
          env_allowlist: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional parent env allowlist; only these names plus platform-minimal vars are inherited.',
          },
          env_denylist: {
            type: 'array',
            items: { type: 'string' },
            description: 'Parent env vars to remove before executing.',
          },
          env: {
            type: 'object',
            additionalProperties: true,
            description:
              'Explicit non-sensitive env vars; audit records names only, never values.',
          },
          max_output_bytes: {
            type: 'integer',
            minimum: 1024,
            maximum: 1048576,
            default: 65536,
            description: 'stdout 和 stderr 各自最多返回的字节数，超出会截断。危险完全访问档缺省为 32MiB 崩溃保护上限，显式传参原样生效。',
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
      name: 'builtin-git_status',
      description: '读取当前授权 workspace 的 Git 状态，返回 porcelain v1 与分支信息。只读，Medium 敏感度。',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    },
    {
      name: 'builtin-git_diff',
      description: '读取当前授权 workspace 的 Git diff；可选择暂存区并限定相对路径。只读，Medium 敏感度。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          staged: { type: 'boolean', default: false, description: 'true 读取已暂存 diff，false 读取工作区 diff。' },
          paths: {
            type: 'array', maxItems: 200, items: { type: 'string', maxLength: 512 },
            description: '可选的 workspace 相对路径列表；禁止绝对路径、.. 和以 - 开头的路径。',
          },
        },
      },
    },
    {
      name: 'builtin-git_log',
      description: '读取当前授权 workspace 的最近 Git 提交历史。只读，Medium 敏感度。',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
      },
    },
    {
      name: 'builtin-git_branch',
      description: '管理当前授权 workspace 的本地分支。action=list 为只读 Medium；create/switch/delete 为 High 并走后端审批。delete 只使用安全 -d，不强制删除未合并分支。',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'switch', 'delete'] },
          name: { type: 'string', maxLength: 200, description: 'create/switch/delete 必填的本地分支名。' },
        },
        required: ['action'],
      },
    },
    {
      name: 'builtin-git_commit',
      description: '在当前授权 workspace 中提交显式路径：先 git add -- paths，再只提交这些 paths；不会隐式 add -A 或卷入其他已暂存文件。High 敏感度，由后端审批。',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          message: { type: 'string', minLength: 1, maxLength: 4000, description: '提交信息。' },
          paths: {
            type: 'array', minItems: 1, maxItems: 200,
            items: { type: 'string', minLength: 1, maxLength: 512 },
            description: '必须显式列出的 workspace 相对路径；只提交这些路径。',
          },
        },
        required: ['message', 'paths'],
      },
    },
    {
      name: 'builtin-coordinator_sleep',
      description:
        '等待以 wait=false 派发的子代理完成：睡眠期间 pipeline 挂起，收到结果后自动唤醒。并行 fan-out 全部派发完后调用一次即可；默认 wait=true 的 subagent_call 不需要本工具。',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: '工作区 ID' },
          awaiting_agents: {
            type: 'array',
            items: { type: 'string' },
            description: '等待的子代理 session_id 列表（省略则等待全部）',
          },
          wake_condition: {
            type: 'string',
            enum: ['any_message', 'result_message', 'all_completed'],
            description: '唤醒条件：result_message=结果消息（默认），any_message=任意消息，all_completed=全部完成',
          },
          timeout_ms: {
            type: 'integer',
            description: '超时毫秒数，超时自动唤醒（默认无超时）',
          },
        },
        required: ['workspace_id'],
      },
    },
    {
      name: 'builtin-skill_scan',
      description:
        'Scan a skill package zip without installing (https URL or temp/artifacts path). Returns skill_id, package_sha256, risk_level, risk_signals; pass exact skill_id and expected_sha256 to skill_install after user confirmation.',
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
        'Install a scanned skill package to ~/.deep-student/skills after user approval. Re-fetches source, verifies expected_sha256, re-scans risk, writes provenance; installed skill is untrusted — next call skill_trust_request (inspect then grant).',
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
