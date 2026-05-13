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
  description: '附件管理能力组，提供读取和列出对话历史中附件的工具。当用户询问"刚才上传的文件"、"之前的附件"等历史附件内容时使用。',
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
type 可选：image/document/audio/video/all

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
- **audio**: 音频文件（mp3/wav等）
- **video**: 视频文件（mp4/webm等）

## 使用建议

1. 用户问"刚才的文件"时，先用 attachment_list 查找
2. 找到后用 attachment_read 读取具体内容
3. 图片附件返回 base64，文档附件返回解析后的文本
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
            enum: ['image', 'document', 'audio', 'video', 'all'],
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
      description: '读取指定附件的内容。图片返回 base64 编码，文档返回解析后的文本内容。当用户说"读取那个PDF"、"看看刚才的图片"时使用。',
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
  ],
};
