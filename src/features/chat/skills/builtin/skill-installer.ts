/**
 * skill-installer 内置元技能
 *
 * 教会 agent 把用户粘贴的技能链接（GitHub 仓库/子目录、原始 SKILL.md URL、
 * zip 直链、community-market / skills.sh 页面）转化为 scan → 确认 → install 的治理正门安装流。
 * 提供统一的扫描、确认和安装流程。
 *
 * 自带 社区市场只读 embeddedTools（search / skill_detail）；写操作（download+install）
 * 仍需用户确认。其余通过 dependencies 拉起 workspace-tools（shell +
 * skill_scan / skill_install）。
 */

import type { SkillDefinition } from '../types';
import { SKILL_DEFAULT_PRIORITY } from '../types';

export const SKILL_MARKET_READ_TOOL_NAMES = [
  'builtin-skill_market_search',
  'builtin-skill_market_skill_detail',
] as const;

export const skillInstallerSkill: SkillDefinition = {
  id: 'skill-installer',
  name: '技能安装器',
  description:
    '从链接安装技能包：用户粘贴 GitHub 仓库/子目录链接、SKILL.md 原始链接、zip 直链或社区市场/skills.sh 页面链接时使用。社区市场使用 builtin-skill_market_search / builtin-skill_market_skill_detail 只读检索，安装仍需用户确认后走 skill_market_download_and_scan / skill_install。支持采用标准 SKILL.md 格式的 AgentSkills 技能。',
  version: '1.2.0',
  author: 'Deep Student',
  location: 'builtin',
  sourcePath: 'builtin://skill-installer',
  priority: SKILL_DEFAULT_PRIORITY,
  disableAutoInvoke: false,
  isBuiltin: true,
  skillType: 'composite',
  dependencies: ['workspace-tools'],
  allowedTools: [...SKILL_MARKET_READ_TOOL_NAMES],
  embeddedTools: [
    {
      name: 'builtin-skill_market_search',
      description:
        'Search or browse community skill marketplace skill marketplace (read-only). Empty q returns trending/sorted list. Prefer this over web_fetch for marketplace discovery. Default nonSuspiciousOnly=true.',
      inputSchema: {
        type: 'object',
        properties: {
          q: {
            type: 'string',
            description: 'Search query; omit or empty for browse/trending list',
          },
          limit: {
            type: 'integer',
            description: 'Max results (default 24, max 50)',
            minimum: 1,
            maximum: 50,
          },
          nonSuspiciousOnly: {
            type: 'boolean',
            description: 'Filter out suspicious skills (default true)',
            default: true,
          },
          sort: {
            type: 'string',
            enum: ['trending', 'downloads', 'stars'],
            description: 'Browse sort when q is empty (default trending)',
          },
        },
      },
    },
    {
      name: 'builtin-skill_market_skill_detail',
      description:
        'Fetch community marketplace skill detail by slug (read-only): display name, summary, latest version, downloads, owner. Use before verify/install to confirm slug and version.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            description: 'community marketplace skill slug (e.g. sonoscli)',
          },
        },
        required: ['slug'],
      },
    },
  ],
  content: `# 技能安装器（Skill Installer）

用户发来一个"技能链接"希望安装时，按本流程操作。目标：**链接 → 拉取 → 规范打包 → 扫描预览 → 用户确认 → 审批安装**。

## 铁律（先读）

1. **禁止**用 shell / 文件工具直接读写任何技能目录（\`~/.deep-student/skills\`、\`.claude/skills\`、\`.agents/skills\` 等）——shell 已封侧门，命中即被拒绝。落盘技能**只能**经 \`builtin-skill_scan\` → \`builtin-skill_install\`（或 社区市场确认后的 \`skill_market_download_and_scan\`）。
2. 所有下载、解压、打包操作都在会话 **temp** runtime root 里做（\`root_id=temp\`）。
3. \`skill_install\` / 社区市场安装是 High 审批或需用户口头确认：调用前必须先向用户展示 scan 的风险摘要并获得确认。
4. zip 包上限 64MB；大仓库只打包技能子目录，不打包整个仓库。
5. **社区市场只读工具**已对本技能开放：\`builtin-skill_market_search\`、\`builtin-skill_market_skill_detail\`。写操作（下载安装）**不要**擅自执行，须用户确认。

## 第一步：识别链接形态

| 链接形态 | 例子 | 处理路径 |
|---|---|---|
| zip 直链 | \`https://.../my-skill.zip\` | 直接走 A（免终端） |
| GitHub 仓库 | \`github.com/{owner}/{repo}\` | 走 B |
| GitHub 子目录 | \`github.com/{o}/{r}/tree/{ref}/{path}\` | 走 B（只打包该子目录） |
| SKILL.md 原始链接 | \`https://.../SKILL.md\` 或 raw.githubusercontent.com | 走 C |
| 社区市场页面 / slug | 市场链接或 slug 如 \`sonoscli\` | **走路径 D（市场专用工具）**，不要再用 web_fetch 扒页面 |
| skills.sh 页面 | \`skills.sh/...\` | 先用 \`builtin-web_fetch\` 读页面找到底层 GitHub 仓库或 zip / 市场 slug，再走 B/A/D |

无法识别时：用 \`builtin-web_fetch\` 读页面判断，或直接问用户要 GitHub / 市场地址。

> 提示：对整仓库多技能的场景，也可以建议用户直接打开「技能管理 → 技能源」，粘贴仓库链接即可图形化浏览与安装（同一套扫描/审批管线），无需走终端。社区技能市场在同一面板的「社区技能市场」标签页。

## 路径 D：社区技能市场（推荐，专用工具）

用户给出社区市场 链接或 slug 时，**直接走市场工具**，不要 shell/curl 拼装，也不要用 web_fetch 扒市场页：

1. （可选只读）\`builtin-skill_market_search\` 发现技能，或 \`builtin-skill_market_skill_detail\` 确认 slug 与 latest \`version\`。
2. \`skill_market_verify\`（\`slug\` + \`version\`）——向用户展示 \`ok\` / \`decision\` / \`security.status\` / publisher。
3. \`skill_market_download_and_scan\`（\`install: false\`）——下载（含 GitHub handoff 分支）并扫描，展示 \`risk_level\` / \`risk_signals\`。
4. **用户口头确认后**，再调 \`skill_market_download_and_scan\`（\`install: true\`，按需 \`overwrite: true\`）。

provenance 会记为 \`skill_market:{slug}@{version}\`（\`sourceKind=skill_market\`）。默认 \`nonSuspiciousOnly=true\`；仅当用户明确要求查看可疑技能时才关闭该过滤。

## 路径 A：zip 直链（最简单）

1. \`builtin-skill_scan\` 传 \`source: { url: "https://..." }\`（仅 https）。
2. 跳到「第三步：风险预览与确认」。

## 路径 B：GitHub 仓库 / 子目录

1. **拉取**（temp root 内执行 shell，先 preflight 再 execute）：
   - 优先 \`git clone --depth 1 [--branch {ref}] https://github.com/{owner}/{repo} repo\`
   - 无 git 时：\`curl -L -o repo.zip https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{ref}\` 后解压（注意 codeload zip 有 \`{repo}-{ref}/\` 顶层前缀）。
2. **定位技能**：在克隆目录里查找 \`SKILL.md\`（如 \`find repo -name SKILL.md -maxdepth 4\`）。
   - 链接带子目录路径时，只看该子目录。
   - **找到多个技能**：把清单（目录名 + frontmatter 的 name/description 摘要）列给用户，请用户选择要装哪些，逐个安装，不要擅自全装。
3. **规范打包**：技能目录必须作为 zip 的**顶层文件夹**（目录名即 skill_id）：
   \`\`\`sh
   cd repo/path/to/parent && zip -r "$OLDPWD/skill-name.zip" skill-name/
   \`\`\`
   不要把 SKILL.md 直接打在 zip 根（会得到 imported-skill 兜底 id）。只打包 SKILL.md 及其引用的 \`references/\`、\`scripts/\`、\`assets/\`、\`templates/\`、\`examples/\`，排除 \`.git\`。
4. \`builtin-skill_scan\` 传 \`source: { root_id: "temp", path: "skill-name.zip" }\`。

## 路径 C：SKILL.md 原始链接

1. temp root 里建目录（目录名取 frontmatter \`name\` 的 slug 或 URL 上一级路径名）：\`curl -L -o my-skill/SKILL.md {url}\`。
2. 读取正文，找出其中引用的相对路径文件（\`references/\`、\`scripts/\`、\`assets/\`、\`templates/\`、\`examples/\` 下），逐个从同一 base URL 下载到对应子目录。下载失败的引用文件要在确认时告知用户。
3. 按路径 B 第 3 步打包，然后 scan。

## 第三步：风险预览与确认

scan 返回后，向用户展示（不要跳过）：

- **skill_id**、名称、描述摘要
- **risk_level** 与 **risk_signals**（如 executable_scripts / shell_tools / network_tools / credential_keywords）
- scripts / references 数量；requires 探测结果（缺失的 bins/env 要指出）
- 来源 URL

高风险（high）时明确警告用户：包含可执行脚本或 shell/网络工具声明，安装后需在技能管理中信任才会生效，建议先审阅内容。用户确认后才进入安装。

## 第四步：安装

调用 \`builtin-skill_install\`：**原样携带**与 scan 相同的 \`source\`、scan 返回的 \`expected_sha256\`（= package_sha256）与 \`skill_id\`，按 scan 结果填 \`declared_risk_level\`；同名技能已存在且用户同意覆盖时传 \`overwrite: true\`。

安装成功后告知用户：

1. 技能已装入 \`~/.deep-student/skills/<skill_id>/\`，**默认未信任**——需在「技能管理」中信任后，正文与包内脚本才会注入生效。
2. 若 requires 探测有缺失（如缺 python），列出并给出安装建议。
3. 建议下一轮用 \`load_skills\` 或在输入栏选择该技能试用。

## 兼容性说明

常见桌面代理技能格式 体系的 SKILL.md 可直接安装：\`top-level requires\`、\`allowed-tools\` 等 frontmatter 字段会被解析或原样保留；正文中的 \`{baseDir}\` 引用对应本系统的 SKILL_DIR（脚本执行时以环境变量注入）。无需改写技能内容。
`,
};
