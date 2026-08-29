/**
 * Runtime root 授权请求技能组
 *
 * 提供 runtime_root_request 工具，让 agent 在缺目录授权时向用户发起只读授权审批。
 */

import type { SkillDefinition } from '../types';

export const rootRequestToolsSkill: SkillDefinition = {
  id: 'root-request-tools',
  name: 'root-request-tools',
  description:
    'Runtime root 只读授权请求：当 self_inspect 发现缺少某本地目录授权时，向用户说明用途后发起审批；用户批准后等价于在 Settings > 工具权限 手动添加 authorized root。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 8,
  location: 'builtin',
  sourcePath: 'builtin://root-request-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# Runtime Root 授权请求技能

当 **self_inspect** 显示缺少某本地目录的 authorized root，且任务确实需要只读访问该目录时，使用 **builtin-runtime_root_request** 向用户发起授权审批。

## 何时使用

- self_inspect 的 roots 列表中没有目标目录
- 需要读取用户 Downloads、Documents、项目数据目录等 workspace 之外的本地路径
- 已通过 workspace_file_list/read 或 local_shell_execute 报错提示缺少 authorized root

## 使用前

1. 先用 **self_inspect**（section=roots）确认确实未授权
2. **向用户说明**为什么需要访问该目录、会读哪些内容、不会写入或删除
3. 再调用本工具；path 会原样显示在审批卡参数中供用户核对

## 限制

- **只读 authorized root**：不能设置或变更 workspace root
- **critical 目录**（盘符根、用户主目录、C:\\Users 等）会被 agent 直接拒绝，需请用户到 **Settings > 工具权限** 手动添加
- **broad 目录**（Desktop/Downloads/Documents/桌面/下载/文档 本身）可请求，但范围较宽，务必先解释用途
- 授权后用户可随时在 **Settings > 工具权限** 撤销；agent 没有撤销工具

## 授权后

使用返回的 \`root_id\` 配合：

- \`workspace_file_list\` / \`workspace_file_read\`（指定 root_id）
- \`local_shell_execute\`（root_id=...）

## 示例

\`\`\`json
{
  "path": "C:\\\\Users\\\\alice\\\\Downloads\\\\exam-data",
  "purpose": "读取用户指定的期末试卷 PDF 文件夹以汇总错题"
}
\`\`\`
`,
  embeddedTools: [
    {
      name: 'builtin-runtime_root_request',
      description:
        '请求用户授权本地目录为只读 authorized runtime root；path 与 purpose 显示在审批卡供核对。critical 目录不代理授权，broad 目录允许但需先解释用途（见技能说明）。不支持 workspace root；撤销仅在 Settings > 工具权限。',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '待授权目录的绝对路径（原样显示在审批卡）。',
          },
          purpose: {
            type: 'string',
            description: '一句话说明访问用途，显示在审批卡。',
          },
        },
        required: ['path', 'purpose'],
      },
    },
  ],
};
