/**
 * 学术论文搜索技能组
 *
 * 提供 arXiv 预印本搜索和 OpenAlex 学术论文搜索（国内可直连）。
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const academicSearchSkill: SkillDefinition = {
  id: 'academic-search',
  name: '学术论文搜索',
  description:
    '学术论文搜索与管理能力组，支持 arXiv 预印本搜索、OpenAlex 学术搜索（覆盖 2.4 亿+ 篇论文，国内可直连）、论文 PDF 下载保存到资料库、引用格式化（BibTeX/GB/T 7714/APA）。当用户需要查找、下载、引用学术论文时使用。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 5,
  location: 'builtin',
  sourcePath: 'builtin://academic-search',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 学术论文搜索技能

当你需要查找学术论文时，根据场景选择合适的搜索工具：

## 搜索工具选择指南

### builtin-arxiv_search — arXiv 预印本搜索
**适用场景**：计算机科学、物理、数学、统计等 STEM 领域的最新预印本论文
- 直接调用 arXiv API，结果准确且实时
- 支持按分类（cs.AI、cs.LG 等）和日期范围过滤
- 返回论文 ID、标题、作者、摘要、分类、PDF 链接

**arXiv 常用分类**：
| 分类 | 说明 |
|------|------|
| cs.AI | 人工智能 |
| cs.LG | 机器学习 |
| cs.CL | 计算语言学/NLP |
| cs.CV | 计算机视觉 |
| cs.MA | 多智能体系统 |
| cs.RO | 机器人学 |
| cs.CR | 密码学与安全 |
| cs.SE | 软件工程 |
| stat.ML | 机器学习（统计） |
| math.OC | 优化与控制 |
| physics.* | 物理学各子领域 |

**查询技巧**：
- 使用引号精确匹配：\`"transformer architecture"\`
- 使用 AND/OR 组合：\`"attention mechanism" AND "language model"\`
- 使用字段限定：\`ti:"neural network"\`（标题）、\`au:"Hinton"\`（作者）

### builtin-scholar_search — OpenAlex 学术搜索（国内可直连）
**适用场景**：跨学科的学术文献搜索，需要引用数据
- 基于 OpenAlex（开放学术数据库），覆盖 2.4 亿+ 篇论文
- 数据来源：Crossref、PubMed、arXiv、机构仓库等（与 Google Scholar 覆盖范围相当）
- 提供引用数、发表年份、DOI、开放获取 PDF 链接
- 支持按年份、最低引用数、开放获取过滤
- **国内可直接访问，无需代理**

## 搜索策略建议

### 1. 找最新研究
\`\`\`
arxiv_search(query="...", sort_by="date", categories=["cs.AI"])
\`\`\`

### 2. 找高引用经典论文
\`\`\`
scholar_search(query="...", min_citation_count=100, year_from=2020)
\`\`\`
**注意**：arxiv_search 使用 \`date_from/date_to\`（YYYY-MM-DD 日期），scholar_search 使用 \`year_from/year_to\`（年份整数），不要混用。

### 3. 综合搜索（推荐）
1. 先用 \`arxiv_search\` 搜最新预印本
2. 再用 \`scholar_search\` 搜已发表的高引论文
3. 结合两者结果给出全面回答

### 4. 保存论文到资料库
搜索到感兴趣的论文后，直接下载 PDF 并保存到用户资料库：
\`\`\`
paper_save(papers=[
  {url: "https://arxiv.org/pdf/2401.xxxxx", title: "论文标题"},
  {doi: "10.xxxx/xxxxx", title: "另一篇论文"},
  {arxiv_id: "2401.xxxxx", title: "第三篇"},
])
\`\`\`
保存后可用 \`resource_read\` 按页阅读，或用 \`unified_search\` RAG 检索。

### 5. 生成引用格式
\`\`\`
cite_format(papers=[{title: "...", authors: ["..."], year: 2024, doi: "...", venue: "..."}], format="gbt7714")
\`\`\`
支持格式：\`bibtex\`、\`gbt7714\`（国标）、\`apa\`

## 输出格式建议

引用论文时使用以下格式：
\`\`\`
**[标题]** (年份)
作者1, 作者2, ...
发表于: 会议/期刊名
引用数: N | [arXiv](链接) | [PDF](链接)
摘要: ...
\`\`\`

## 注意事项

1. arXiv 论文是预印本，未必经过同行评审
2. OpenAlex 的引用数据可能有 1-2 周延迟
3. 搜索词建议使用英文以获得最佳结果
4. 对于中文学术论文，建议配合 \`web_search\` 搜索中文学术数据库
5. arXiv API 在国内可能不稳定，系统会自动回退到 OpenAlex 搜索 arXiv 论文
6. \`paper_save\` 支持通过 DOI 自动解析开放获取 PDF（基于 Unpaywall），付费论文可能无法下载
7. \`paper_save\` 自动去重：已存在的论文直接返回现有文件 ID
`,
  embeddedTools: [
    {
      name: 'builtin-arxiv_search',
      description:
        '搜索 arXiv 预印本论文。直接调用 arXiv API，适合查找 STEM 领域最新研究。返回论文 ID、标题、作者、摘要、分类、PDF 链接等。支持 arXiv 查询语法（引号精确匹配、ti:/au:/abs: 字段限定、AND/OR/ANDNOT 布尔操作）。',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              '【必填】搜索查询。支持 arXiv 查询语法：引号精确匹配（如 "transformer"）、字段限定（ti: 标题、au: 作者、abs: 摘要）、布尔操作（AND、OR、ANDNOT）。',
          },
          max_results: {
            type: 'integer',
            description: '最大返回结果数，默认 10，最大 50',
            default: 10,
            minimum: 1,
            maximum: 50,
          },
          date_from: {
            type: 'string',
            description: '起始日期（YYYY-MM-DD 格式），用于筛选提交日期。注意：此参数是日期字符串，不同于 scholar_search 的 year_from（年份整数）。',
          },
          date_to: {
            type: 'string',
            description: '截止日期（YYYY-MM-DD 格式），用于筛选提交日期。注意：此参数是日期字符串，不同于 scholar_search 的 year_to（年份整数）。',
          },
          categories: {
            type: 'array',
            items: { type: 'string' },
            description:
              'arXiv 分类列表，如 ["cs.AI", "cs.LG"]。强烈建议指定以提高相关性。',
          },
          sort_by: {
            type: 'string',
            enum: ['relevance', 'date'],
            description: '排序方式："relevance"（相关性，默认）或 "date"（最新优先）',
            default: 'relevance',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'builtin-scholar_search',
      description:
        '搜索学术论文（基于 OpenAlex 开放学术数据库，覆盖 2.4 亿+ 篇论文，含 Crossref、PubMed、arXiv 等来源，国内可直连）。返回论文标题、作者、摘要、年份、引用数、PDF 链接、DOI 等。适合查找高引论文、跨学科文献。',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '【必填】搜索查询文本，使用英文效果最佳',
          },
          max_results: {
            type: 'integer',
            description: '最大返回结果数，默认 10，最大 50',
            default: 10,
            minimum: 1,
            maximum: 50,
          },
          year_from: {
            type: 'integer',
            description: '起始发表年份（如 2020）。注意：此参数是年份整数，不同于 arxiv_search 的 date_from（YYYY-MM-DD 日期字符串）。',
          },
          year_to: {
            type: 'integer',
            description: '截止发表年份（如 2024）。注意：此参数是年份整数，不同于 arxiv_search 的 date_to（YYYY-MM-DD 日期字符串）。',
          },
          sort_by: {
            type: 'string',
            enum: ['relevance', 'date', 'citations'],
            description: '排序方式："relevance"（相关性，默认）、"date"（最新优先）、"citations"（引用数最高优先）',
            default: 'relevance',
          },
          min_citation_count: {
            type: 'integer',
            description: '最低引用数过滤，用于筛选高影响力论文',
            minimum: 0,
          },
          open_access_only: {
            type: 'boolean',
            description: '是否只返回开放获取论文（有免费 PDF），默认 false',
            default: false,
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'builtin-paper_save',
      description:
        '下载学术论文 PDF 并保存到用户资料库（VFS）。支持批量下载（最多 5 篇）。支持三种输入方式：直接 PDF URL、arXiv ID、DOI（自动通过 Unpaywall 解析开放获取 PDF）。保存后可用 resource_read 按页阅读、unified_search RAG 检索。自动 SHA256 去重，已存在的论文直接返回文件 ID。',
      inputSchema: {
        type: 'object',
        properties: {
          papers: {
            type: 'array',
            description:
              '【必填】论文列表（最多 5 篇）。每篇论文必须提供 title，并至少提供 url/doi/arxiv_id 之一作为下载来源。',
            items: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description:
                    'PDF 下载地址（优先使用，来自搜索结果的 pdfUrl 字段）',
                },
                doi: {
                  type: 'string',
                  description:
                    '论文 DOI（如 "10.xxxx/xxxxx"），系统会通过 Unpaywall 自动查找开放获取 PDF',
                },
                arxiv_id: {
                  type: 'string',
                  description:
                    'arXiv 论文 ID（如 "2401.12345"），自动转换为 PDF 下载链接',
                },
                title: {
                  type: 'string',
                  description: '论文标题（用作文件名）',
                },
              },
              required: ['title'],
            },
            minItems: 1,
            maxItems: 5,
          },
          folder_id: {
            type: 'string',
            description: '保存到指定 VFS 文件夹 ID（可选，默认保存到根目录）',
          },
        },
        required: ['papers'],
      },
    },
    {
      name: 'builtin-cite_format',
      description:
        '将论文元数据格式化为标准学术引用格式。支持 BibTeX、GB/T 7714（中国国标）、APA 三种格式。输入论文的标题、作者、年份、DOI、期刊等信息，输出格式化的引用文本。',
      inputSchema: {
        type: 'object',
        properties: {
          papers: {
            type: 'array',
            description: '【必填】论文元数据列表',
            items: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description: '论文标题',
                },
                authors: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '作者列表（如 ["张三", "李四"]）',
                },
                year: {
                  type: 'integer',
                  description: '发表年份',
                },
                doi: {
                  type: 'string',
                  description: 'DOI 标识符',
                },
                venue: {
                  type: 'string',
                  description: '发表期刊或会议名称',
                },
              },
              required: ['title'],
            },
          },
          format: {
            type: 'string',
            enum: ['bibtex', 'gbt7714', 'apa'],
            description:
              '引用格式："bibtex"（BibTeX，默认）、"gbt7714"（GB/T 7714 中国国标）、"apa"（APA 格式）',
            default: 'bibtex',
          },
        },
        required: ['papers'],
      },
    },
  ],
};
