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
`,
  embeddedTools: [
    {
      name: 'builtin-web_fetch',
      description:
        '抓取网页内容并转换为 Markdown 格式。当用户需要获取某个 URL 的内容、阅读文章、查看网页详情时使用。支持分页读取长内容（通过 start_index 和 max_length 参数）。注意：此工具用于获取特定 URL 的内容，如果需要搜索请使用 web_search。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '【必填】要抓取的 URL（必须是 http:// 或 https:// 开头）' },
          max_length: { type: 'integer', description: '最大返回字符数，默认 5000。如果内容超过此长度，可使用 start_index 分页读取。', default: 5000, minimum: 100, maximum: 50000 },
          start_index: { type: 'integer', description: '从第几个字符开始返回，默认 0。用于分页读取长内容。', default: 0, minimum: 0 },
          raw: { type: 'boolean', description: '是否返回原始内容（不转换为 Markdown）。默认 false。' },
        },
        required: ['url'],
      },
    },
  ],
};
