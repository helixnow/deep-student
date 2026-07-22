/**
 * skill-installer 内置元技能
 *
 * 教会 agent 把用户粘贴的技能链接（GitHub 仓库/子目录、原始 SKILL.md URL、
 * zip 直链、community-market / skills.sh 页面）转化为 scan → 确认 → install 的治理正门安装流。
 * 提供统一的扫描、确认和安装流程。
 *
 * 自带社区市场完整治理 embeddedTools（search / detail / verify /
 * download+scan+install）；安装敏感度由后端按 install 参数动态判定。
 * 其余来源通过 dependencies 拉起 workspace-tools（shell + skill_scan /
 * skill_install）。
 */

import type { SkillDefinition } from '../types';
import { SKILL_DEFAULT_PRIORITY } from '../types';

export const SKILL_MARKET_READ_TOOL_NAMES = [
  'builtin-skill_market_search',
  'builtin-skill_market_skill_detail',
] as const;

export const SKILL_MARKET_INSTALL_TOOL_NAMES = [
  'builtin-skill_market_verify',
  'builtin-skill_market_download_and_scan',
] as const;

export const skillInstallerSkill: SkillDefinition = {
  id: 'skill-installer',
  name: '技能安装器',
  description:
    '从链接安装技能包：用户粘贴 GitHub 仓库/子目录链接、SKILL.md 原始链接、zip 直链或社区市场/skills.sh 页面链接时使用。社区市场使用 builtin-skill_market_search / builtin-skill_market_skill_detail 只读检索，安装仍需用户确认后走 skill_market_download_and_scan / skill_install。支持采用标准 SKILL.md 格式的 AgentSkills 技能。',
  version: '1.3.1',
  author: 'Deep Student',
  location: 'builtin',
  sourcePath: 'builtin://skill-installer',
  priority: SKILL_DEFAULT_PRIORITY,
  disableAutoInvoke: false,
  isBuiltin: true,
  skillType: 'composite',
  dependencies: ['workspace-tools'],
  allowedTools: [...SKILL_MARKET_READ_TOOL_NAMES, ...SKILL_MARKET_INSTALL_TOOL_NAMES],
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
    {
      name: 'builtin-skill_market_verify',
      description:
        'Verify a community marketplace skill version and publisher/security verdict before download (read-only).',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Community marketplace skill slug' },
          version: { type: 'string', description: 'Version to verify; omit to use latest' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'builtin-skill_market_download_and_scan',
      description:
        'Download and scan a marketplace skill through the governed installer. First call with install=false. After reviewing the returned risk and package hash, call with install=true and the exact expectedPackageSha256/tempZipPath; the platform handles any required approval.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Community marketplace skill slug' },
          version: { type: 'string', description: 'Exact marketplace version' },
          install: { type: 'boolean', default: false },
          overwrite: { type: 'boolean', default: false },
          expectedPackageSha256: {
            type: 'string',
            description: 'Pass the exact scan.package_sha256 from the preceding install=false result',
          },
          declaredRiskLevel: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'Exact risk_level from the preceding install=false scan',
          },
          tempZipPath: {
            type: 'string',
            description: 'Pass the exact temp_zip_path from the preceding install=false result',
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
3. \`skill_install\` / 社区市场安装是 High 操作。先展示 scan 风险摘要，再直接调用安装工具；若当前权限策略需要确认，平台审批卡本身就是确认入口，不要先追加一次重复的文字确认。
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
4. 展示风险摘要后，直接调 \`builtin-skill_market_download_and_scan\`（\`install: true\`）：把返回的 \`scan.package_sha256\` 传入 \`expectedPackageSha256\`、\`temp_zip_path\` 传入 \`tempZipPath\`、\`scan.risk_level\` 传入 \`declaredRiskLevel\`，按需 \`overwrite: true\`。需要确认时由平台审批卡统一承接，不要再用 shell 下载或重复口头确认。

provenance 会记为 \`skill_market:{slug}@{version}\`（\`sourceKind=skill_market\`）。默认 \`nonSuspiciousOnly=true\`；仅当用户明确要求查看可疑技能时才关闭该过滤。

## 路径 A：zip 直链（最简单）

1. \`builtin-skill_scan\` 传 \`source: { url: "https://..." }\`（仅 https）。
2. 跳到「第三步：风险预览与确认」。

## 路径 B：GitHub 仓库 / 子目录

1. **拉取**（temp root 内执行 shell，先 preflight 再 execute）：
   - 优先 \`git clone --depth 1 [--branch {ref}] https://github.com/{owner}/{repo} repo\`
   - 无 git 时：\`curl -L -o repo.zip https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{ref}\`，再用 \`unzip -q repo.zip -d repo-unpacked\`（注意 codeload zip 有 \`{repo}-{ref}/\` 顶层前缀）。
2. **定位技能**：在克隆目录里查找 \`SKILL.md\`（如 \`find repo -name SKILL.md -maxdepth 4\`）。
   - 链接带子目录路径时，只看该子目录。
   - **找到多个技能**：把清单（目录名 + frontmatter 的 name/description 摘要）列给用户，请用户选择要装哪些，逐个安装，不要擅自全装。
3. **规范打包**：所有路径都必须保持在 temp root 内，禁止 \`/tmp\`、\`../\`、\`$OLDPWD\` 和 \`>/dev/null\`。把目标目录复制到 temp root 下与 skill_id 同名的目录，再直接压缩：
   \`\`\`sh
   rm -rf skill-name
   mkdir -p skill-name
   cp -R repo/path/to/skill-name/. skill-name/
   zip -r skill-name.zip skill-name/
   \`\`\`
   推荐保留与 skill_id 同名的顶层目录；兼容包若把 SKILL.md 放在 zip 根，安装器会从 frontmatter 的可移植 \`name\` 推导 skill_id。只打包 SKILL.md 及其引用的 \`references/\`、\`scripts/\`、\`assets/\`、\`agents/\`、\`templates/\`、\`examples/\` 和必要的 README/LICENSE/市场元数据，排除 \`.git\`。
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

高风险（high）时明确警告用户：包含可执行脚本或 shell/网络工具声明，安装后需经 \`skill_trust_request\`（inspect→grant）信任才会生效，建议先审阅内容。用户确认后才进入安装。

## 第四步：安装

调用 \`builtin-skill_install\`：**原样携带**与 scan 相同的 \`source\`、scan 返回的 \`expected_sha256\`（= package_sha256）与 \`skill_id\`，按 scan 结果填 \`declared_risk_level\`；同名技能已存在且用户同意覆盖时传 \`overwrite: true\`。

安装成功后：

1. 技能已装入 \`~/.deep-student/skills/<skill_id>/\`，**默认未信任**——下一步调用 \`builtin-skill_trust_request\`：先 \`action=inspect\`，向用户说明理由与风险摘要后 \`action=grant\`（原样携带 inspect 的 \`package_sha256\` / \`risk_level\`）。「技能管理」仅作备用。
2. 若 requires 探测有缺失（如缺 python），列出并给出安装建议。
3. **信任授予后不要在同一工具循环里调用 \`load_skills\`**：本轮运行时目录快照不会中途替换。明确告知用户信任已绑定成功，技能会从下一条用户消息开始可加载；不要重复调用、不要把本轮旧快照的 untrusted 误报成授予失败。

## 兼容性说明

常见桌面代理技能格式 体系的 SKILL.md 可直接安装：\`top-level requires\`、\`allowed-tools\` 等 frontmatter 字段会被解析或原样保留；正文中的 \`{baseDir}\` 引用对应本系统的 SKILL_DIR（脚本执行时以环境变量注入）。无需改写技能内容。
`,
};
