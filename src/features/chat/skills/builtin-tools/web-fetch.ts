/**
 * Web Fetch 技能组
 *
 * 抓取网页内容并转换为 Markdown
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const webFetchSkill: SkillDefinition = {
  id: 'web-fetch',
  name: 'web-fetch',
  description: 'Web 内容抓取能力，用于获取指定 URL 的网页内容并转换为 Markdown 格式。当用户需要阅读某个网页、查看文章内容时使用。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 9,
  location: 'builtin',
  sourcePath: 'builtin://web-fetch',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# Web 内容抓取技能

当你需要获取网页内容时，使用此工具：

## 使用说明

- **builtin-web_fetch**: 抓取网页并转为 Markdown

## 工具参数格式

### builtin-web_fetch
抓取网页，参数格式：
\`\`\`json
{
  "url": "https://example.com/page",
  "max_length": 5000,
  "start_index": 0
}
\`\`\`
**注意**：\`url\` 是必需参数，必须以 http:// 或 https:// 开头。

## 注意事项

1. 此工具用于获取特定 URL 的内容
2. 如果需要搜索，请使用 web_search（在 knowledge-retrieval 技能组中）
3. 支持分页读取长内容（使用 start_index 和 max_length 参数）
4. URL 返回 PDF、DOCX、图片或音视频二进制时，工具校验最终跳转域名、MIME、文件签名与大小，并返回 session artifacts 文件句柄；不会把二进制解码成乱码
`,
  embeddedTools: [
    {
      name: 'builtin-web_fetch',
      description:
        '抓取网页转 Markdown；PDF/DOCX/图片/音视频经最终跳转域名、MIME、magic、大小校验后物化为 session artifacts 文件句柄，不按文本解码。start_index/max_length 分页读取长文本。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的 URL（http:// 或 https:// 开头）' },
          max_length: { type: 'integer', description: '最大返回字符数；超长时用 start_index 分页。', default: 5000, minimum: 100, maximum: 50000 },
          start_index: { type: 'integer', description: '起始字符偏移，用于分页读取。', default: 0, minimum: 0 },
          raw: { type: 'boolean', description: '返回原始内容（不转 Markdown）。' },
        },
        required: ['url'],
      },
    },
  ],
};
