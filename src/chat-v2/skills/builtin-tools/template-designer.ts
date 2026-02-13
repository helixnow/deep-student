/**
 * 模板设计师技能组
 *
 * 包含模板列举、查看、校验、创建、更新、分叉、预览和删除等工具。
 * 支持 Anki 制卡模板的全生命周期管理。
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const templateDesignerSkill: SkillDefinition = {
  id: 'template-designer',
  name: '模板设计师',
  description:
    '制卡模板的设计与管理工具。支持列举、查看、校验、创建、更新、分叉、预览和删除模板，帮助用户高效定制符合需求的 Anki 制卡模板。适用于自定义模板设计、内置模板调整、模板结构校验与自动化回归。',
  version: '1.2.0',
  author: 'Deep Student',
  priority: 3,
  location: 'builtin',
  sourcePath: 'builtin://template-designer',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 模板设计师

你是模板设计师，帮助用户设计和管理 Anki 制卡模板。

## 执行原则（必须遵守）

1. **模板 ID 必须来自实时查询**：先执行 \`builtin-template_list\`，再从返回结果里选择 \`templateId\`。
   - 禁止使用硬编码模板 ID（例如 \`builtin_basic\`）。
2. **更新前必须先读版本**：执行 \`builtin-template_get\` 获取当前 \`version\`，并把该值作为字符串传入 \`patch.expectedVersion\`。
   - 示例：\`"expectedVersion": "1.0.0"\`（✅）
   - \`"expectedVersion": 1\`（❌）
3. **参数校验失败时继续流程**：记录错误原因并继续执行后续可执行步骤，不要直接中断整个任务。
4. **每次写入后做确认**：create/update/fork 后都要再 get 或 preview 一次，确认结果可用。
5. **工具调用串行执行**：同一轮任务里，一次只调用一个模板工具。只有当前工具返回成功/失败后，才能调用下一步工具。
6. **若出现 preparing 超时**：视为该步未真正执行，使用同参数重试一次；若仍失败，记录失败并继续后续可执行步骤。

## 工具选择指南

### 只读操作
- **builtin-template_list**: 列出模板摘要，支持搜索和过滤
- **builtin-template_get**: 获取完整模板信息（含所有字段、规则、代码）
- **builtin-template_validate**: 校验模板定义的合法性
- **builtin-template_preview**: 预览模板渲染效果

### 写入操作
- **builtin-template_create**: 创建新模板（自动校验）
- **builtin-template_update**: 更新已有模板（⚠️ 需要 expectedVersion 做乐观锁）
- **builtin-template_fork**: 从已有模板复制一份可编辑副本

### 危险操作
- **builtin-template_delete**: 删除用户自定义模板（⚠️ 不可撤销，不可删除内置模板）

## 标准工作流

### 改造已有模板
1. \`builtin-template_list\` — 列出可用模板并选择真实 templateId
2. \`builtin-template_get\` — 获取完整模板与当前 version
3. 修改后 \`builtin-template_validate\` — 校验合法性
4. \`builtin-template_preview\` — 预览效果
5. \`builtin-template_update\` — 提交更新（patch.expectedVersion 必须是步骤 2 的字符串版本号）
6. \`builtin-template_get\` — 复读确认版本已变化

### 新建模板
1. 根据用户需求设计模板结构
2. \`builtin-template_validate\` — 校验
3. \`builtin-template_preview\` — 预览
4. \`builtin-template_create\` — 创建入库
5. \`builtin-template_get\` — 复读确认可正常读取

### 复用内置模板
1. \`builtin-template_list\` — 找到合适的内置模板
2. \`builtin-template_fork\` — 复制为可编辑副本
3. 修改后走校验→预览→更新流程

## 模板结构说明

每个模板包含：
- **name/description**：名称和描述
- **noteType**：Anki 笔记类型（如 Basic, Cloze）
- **fields**：字段列表（如 ["Front", "Back", "Tags"]）
- **fieldExtractionRules**：每个字段的提取规则（类型、是否必需、描述、验证等）
- **frontTemplate/backTemplate**：Anki 正面/背面 HTML 模板，使用 \`{{字段名}}\` 占位符
- **cssStyle**：模板样式
- **generationPrompt**：指导 AI 生成卡片的提示词
- **previewFront/previewBack**：示例预览

## 注意事项

- 字段名必须与 fieldExtractionRules 的 key 一一对应
- frontTemplate/backTemplate/generationPrompt 不能为空
- 更新模板时必须提供 expectedVersion（字符串），防止并发冲突
- 校验失败时会返回具体错误和修复建议
- 内置模板不可删除，如需修改请先 fork 再编辑
- 删除操作不可撤销，请先确认用户意图
`,
  allowedTools: [
    'builtin-template_list',
    'builtin-template_get',
    'builtin-template_validate',
    'builtin-template_create',
    'builtin-template_update',
    'builtin-template_fork',
    'builtin-template_preview',
    'builtin-template_delete',
  ],
  embeddedTools: [
    {
      name: 'builtin-template_list',
      description: '列出模板库中的模板摘要。支持按关键词搜索、仅活跃模板、仅内置模板筛选。',
      inputSchema: {
        type: 'object',
        properties: {
          activeOnly: {
            type: 'boolean',
            description: '是否只返回激活模板，默认 true',
          },
          builtinOnly: {
            type: 'boolean',
            description: '是否只返回内置模板',
          },
          query: {
            type: 'string',
            description: '可选：按关键词搜索模板（在 name/description 中模糊匹配）',
          },
          limit: {
            type: 'integer',
            description: '返回最大数量，默认 50，最大 200',
            default: 50,
            minimum: 1,
            maximum: 200,
          },
        },
      },
    },
    {
      name: 'builtin-template_get',
      description: '获取指定模板的完整信息（包含所有字段定义、提取规则、模板代码等）。',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: {
            type: 'string',
            description: '模板 ID',
          },
        },
        required: ['templateId'],
      },
    },
    {
      name: 'builtin-template_validate',
      description:
        '校验模板定义是否合法。检查字段与提取规则一致性、front/back/generation_prompt 非空等。返回错误和警告列表，错误会附带下一步建议。',
      inputSchema: {
        type: 'object',
        properties: {
          template: {
            type: 'object',
            description:
              '要校验的模板对象，结构与创建模板参数一致（包含 name, fields, frontTemplate, backTemplate, generationPrompt, fieldExtractionRules 等）',
          },
        },
        required: ['template'],
      },
    },
    {
      name: 'builtin-template_create',
      description: '校验并创建新模板。模板会自动写入模板库。',
      inputSchema: {
        type: 'object',
        properties: {
          template: {
            type: 'object',
            description:
              '模板定义对象（包含 name, description, noteType, fields, frontTemplate, backTemplate, cssStyle, generationPrompt, fieldExtractionRules, previewFront, previewBack 等）',
          },
        },
        required: ['template'],
      },
    },
    {
      name: 'builtin-template_update',
      description:
        '更新已有模板。必须提供 expectedVersion 做乐观锁检查，否则失败并提示刷新。支持局部更新。',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: {
            type: 'string',
            description: '要更新的模板 ID',
          },
          patch: {
            type: 'object',
            description:
              '要更新的字段（包含 expectedVersion 必需字段，以及 name, description, fields, frontTemplate, backTemplate 等可选字段）',
            properties: {
              expectedVersion: {
                type: 'string',
                description:
                  '【必填】版本号字符串，必须先通过 template_get 获取（如 "1.0.0"）',
              },
              name: {
                type: 'string',
                description: '可选：新模板名称',
              },
              description: {
                type: 'string',
                description: '可选：新模板描述',
              },
              fields: {
                type: 'array',
                items: { type: 'string' },
                description: '可选：字段名数组',
              },
              frontTemplate: {
                type: 'string',
                description: '可选：正面模板 HTML',
              },
              backTemplate: {
                type: 'string',
                description: '可选：背面模板 HTML',
              },
              cssStyle: {
                type: 'string',
                description: '可选：样式',
              },
              generationPrompt: {
                type: 'string',
                description: '可选：生成提示词',
              },
            },
            required: ['expectedVersion'],
          },
        },
        required: ['templateId', 'patch'],
      },
    },
    {
      name: 'builtin-template_fork',
      description:
        '从已有模板（通常是内置模板）复制一份新模板。新模板 is_built_in=false，可自由修改。sourceTemplateId 必须来自 template_list 返回结果。',
      inputSchema: {
        type: 'object',
        properties: {
          sourceTemplateId: {
            type: 'string',
            description: '源模板 ID',
          },
          name: {
            type: 'string',
            description: '可选：新模板名称（默认在源名称后加 " (副本)"）',
          },
          description: {
            type: 'string',
            description: '可选：新模板描述',
          },
          setActive: {
            type: 'boolean',
            description: '是否将新模板设为激活状态，默认 true',
          },
        },
        required: ['sourceTemplateId'],
      },
    },
    {
      name: 'builtin-template_preview',
      description:
        '预览模板渲染效果。可基于已有模板 ID 或传入模板草稿，做占位符替换生成正面/背面预览。',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: {
            type: 'string',
            description: '可选：基于已有模板 ID 预览',
          },
          template: {
            type: 'object',
            description: '可选：传入模板草稿对象预览（优先级低于 templateId）',
          },
          sampleData: {
            type: 'object',
            description: '可选：预览用的示例数据（key-value 对应字段名和值）',
          },
        },
      },
    },
    {
      name: 'builtin-template_delete',
      description:
        '删除用户自定义模板。⚠️ 此操作不可撤销。内置模板不可删除，请先 fork 再删除副本。删除前请确认用户意图。',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: {
            type: 'string',
            description: '【必填】要删除的模板 ID',
          },
        },
        required: ['templateId'],
      },
    },
  ],
};
