/**
 * 附件工具技能组
 *
 * 提供对话历史中附件的读取和列表能力，解决 P0 断裂点：
 * 用户上传的附件无法通过工具主动读取
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const attachmentToolsSkill: SkillDefinition = {
  id: 'attachment-tools',
  name: 'attachment-tools',
  description: '附件管理能力组，提供读取、列出对话附件以及受管解压 zip 附件的工具。当用户询问"刚才上传的文件"、"之前的附件"等历史附件内容，或需要解开 zip 压缩包时使用。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 4,
  location: 'builtin',
  sourcePath: 'builtin://attachment-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 附件管理技能

当用户询问对话中上传过的附件内容时，使用这些工具：

## 工具选择指南

- **builtin-attachment_list**: 列出当前会话中所有附件
- **builtin-attachment_read**: 读取指定附件的内容
- **builtin-attachment_extract**: 把已用 attachment_stage 物化的 zip 附件安全解压到会话 temp root（纯 Rust 实现，移动端无 shell 时的唯一解包途径）

## 工具参数格式

### builtin-attachment_list
列出会话附件，参数格式：
\`\`\`json
{
  "session_id": "当前会话ID（可选，默认当前会话）",
  "type": "image",
  "limit": 10
}
\`\`\`
type 可选：image/document/all

### builtin-attachment_read
读取附件内容，参数格式：
\`\`\`json
{
  "message_id": "消息ID",
  "attachment_id": "附件ID"
}
\`\`\`

## 附件类型说明

- **image**: 图片文件（jpg/png/gif等）
- **document**: 文档文件（pdf/docx/txt等）

当前工具不提供音频转写或视频解析；遇到 audio/video 附件时不要声称可以读取其内容。

## 使用建议

1. 用户问"刚才的文件"时，先用 attachment_list 查找
2. 找到后用 attachment_read 读取具体内容
3. 图片附件返回 base64，文档附件返回解析后的文本

## 处理 zip 压缩包附件

attachment_read 无法读取压缩包内容。正确流程：

1. 先加载 workspace-tools，用 **builtin-attachment_stage**（message_id + attachment_id）把 zip 物化到 temp root，返回 \`{ root_id: "temp", relative_path, archive_manifest }\`
2. 再调用 **builtin-attachment_extract**（root_id=temp, relative_path）安全解压到 \`extracted/<名称>/\`，返回文件清单（路径 + 大小）
3. 用 builtin-workspace_file_read（root_id=temp）读取解出的文本文件
4. attachment_extract 是纯 Rust 受管解压：自带 zip-bomb 防护、路径穿越校验和大小限额；**移动端没有 local_shell_execute 时必须用它**，桌面端也应优先使用而不是 shell unzip
5. rar/7z 不支持解压，会返回结构化错误；请让用户改用 zip 重新打包
`,
  embeddedTools: [
    {
      name: 'builtin-attachment_list',
      description: '列出当前会话中的所有附件。当用户询问"上传过什么文件"、"之前的附件"时使用。返回附件列表包含：ID、名称、类型、所属消息ID。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { 
            type: 'string', 
            description: '会话 ID，不填则使用当前会话' 
          },
          type: { 
            type: 'string', 
            description: '附件类型过滤，默认 all',
            enum: ['image', 'document', 'all'],
            default: 'all'
          },
          limit: { 
            type: 'integer', 
            description: '返回数量限制，默认 20 条',
            default: 20,
            minimum: 1,
            maximum: 100
          },
        },
      },
    },
    {
      name: 'builtin-attachment_read',
      description: '读取指定附件的内容。图片返回 base64 编码，文档返回解析后的文本内容。当用户说"读取那个PDF"、"看看刚才的图片"时使用。此工具无法读取二进制/压缩包内容：xlsx/zip 等二进制附件应先用 builtin-attachment_stage 物化到 temp root 拿到路径；zip 压缩包物化后再用 builtin-attachment_extract 受管解压（移动端无 shell 时的解包途径），不要尝试 base64 手工拼装。',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { 
            type: 'string', 
            description: '【必填】附件所属的消息 ID，可通过 attachment_list 获取' 
          },
          attachment_id: { 
            type: 'string', 
            description: '【必填】附件 ID，可通过 attachment_list 获取' 
          },
          parse_content: {
            type: 'boolean',
            description: '是否解析文档内容为文本（对于 PDF/DOCX 等），默认 true',
          },
        },
        required: ['message_id', 'attachment_id'],
      },
    },
    {
      name: 'builtin-attachment_extract',
      description:
        '把已用 builtin-attachment_stage 物化到会话 temp root 的 zip 附件安全解压到 extracted/<名称>/ 子目录（Medium）。纯 Rust 受管解压：复用 zip-bomb 防护（条目数/压缩比/总量限额）、路径穿越校验与 symlink 拒绝；是移动端等无 shell 环境下的解包途径，桌面端也应优先于 shell unzip。返回 { root_id: "temp", extract_dir, fileCount, files: [{path, sizeBytes}] }，随后可用 builtin-workspace_file_read（root_id=temp）读取解出的文件。仅支持 zip；rar/7z 返回结构化不支持错误。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root_id: {
            type: 'string',
            enum: ['temp'],
            default: 'temp',
            description: '固定为 temp（attachment_stage 返回的 root_id）',
          },
          relative_path: {
            type: 'string',
            minLength: 1,
            description: '【必填】attachment_stage 返回的 relative_path（如 attachments/xxx.zip）',
          },
          target_dir: {
            type: 'string',
            description: '可选：解压目标目录名（extracted/ 下的单段目录名，默认取 zip 文件名；同名自动加序号）',
          },
        },
        required: ['relative_path'],
      },
    },
  ],
};
