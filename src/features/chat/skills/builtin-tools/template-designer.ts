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
    '制卡模板的设计与管理工具。支持列举、查看、校验、创建、更新、分叉、预览、删除模板和设置默认模板，帮助用户高效定制符合需求的 Anki 制卡模板。适用于自定义模板设计、内置模板调整、模板结构校验与自动化回归。',
  version: '1.3.0',
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

### 设置类操作
- **builtin-template_set_default**: 将指定模板设为默认制卡模板（影响后续制卡默认选择，需确认用户意图）

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
- **previewDataJson**：预览用示例数据 JSON（key 对应字段名），多字段模板务必提供，否则预览会大面积空白

## 应用内渲染子集（设计模板时必须知道）

模板在本应用内的预览/复习渲染是 Anki 语法的一个安全子集，与导出到 Anki Desktop 后的行为有差异：

- **\`<script>\` 会随模板保存、不会被剥除**，导出到 Anki 后正常运行；但在本应用内预览/复习时脚本**不会执行**（DOMPurify + iframe 沙箱），交互效果只能在 Anki 中验证
- **\`@font-face\` 与外链资源（远程 CSS/JS/字体）会被剥除**，不要依赖外部 URL；样式请内联到 cssStyle
- **\`{{tts ...}}\` 占位符在应用内被忽略**，不发声
- **\`[sound:...]\` 在应用内只显示一个徽标，不播放音频**
- **媒体文件不会随 .apkg 打包**：图片等资源建议用 base64 data URI 内联（小图为宜），否则导出后会丢失

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
    'builtin-template_set_default',
  ],
  embeddedTools: [
    {
      name: 'builtin-template_list',
      description: '列出模板库摘要，支持关键词搜索、仅激活/仅内置筛选。',
      inputSchema: {
        type: 'object',
        properties: {
          activeOnly: {
            type: 'boolean',
            description: '只返回激活模板，默认 true',
          },
          builtinOnly: {
            type: 'boolean',
            description: '只返回内置模板',
          },
          query: {
            type: 'string',
            description: '关键词，模糊匹配 name/description',
          },
          limit: {
            type: 'integer',
            description: '返回最大数量',
            default: 50,
            minimum: 1,
            maximum: 200,
          },
        },
      },
    },
    {
      name: 'builtin-template_get',
      description: '获取模板完整信息（字段定义、提取规则、模板代码）。',
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
        '校验模板定义合法性（字段与提取规则一致、front/back/generationPrompt 非空等），返回错误/警告及修复建议。',
      inputSchema: {
        type: 'object',
        properties: {
          template: {
            type: 'object',
            description: '待校验模板对象，结构同 template_create 的 template。',
          },
        },
        required: ['template'],
      },
    },
    {
      name: 'builtin-template_create',
      description: '校验并创建新模板，自动写入模板库。',
      inputSchema: {
        type: 'object',
        properties: {
          template: {
            type: 'object',
            description: '模板定义对象，字段构成见技能说明「模板结构说明」。',
          },
        },
        required: ['template'],
      },
    },
    {
      name: 'builtin-template_update',
      description: '局部更新已有模板；expectedVersion 乐观锁不匹配时失败并提示刷新。',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: {
            type: 'string',
            description: '要更新的模板 ID',
          },
          patch: {
            type: 'object',
            description: '要更新的字段集合',
            properties: {
              expectedVersion: {
                type: 'string',
                description: '版本号字符串，须先经 template_get 获取（如 "1.0.0"）',
              },
              name: {
                type: 'string',
                description: '模板名称',
              },
              description: {
                type: 'string',
                description: '模板描述',
              },
              fields: {
                type: 'array',
                items: { type: 'string' },
                description: '字段名数组',
              },
              frontTemplate: {
                type: 'string',
                description: '正面模板 HTML',
              },
              backTemplate: {
                type: 'string',
                description: '背面模板 HTML',
              },
              cssStyle: {
                type: 'string',
                description: '样式',
              },
              generationPrompt: {
                type: 'string',
                description: '生成提示词',
              },
              noteType: {
                type: 'string',
                description: 'Anki 笔记类型；Cloze 要求正面模板含 {{cloze:字段}}',
              },
              previewFront: {
                type: 'string',
                description: '正面示例文案',
              },
              previewBack: {
                type: 'string',
                description: '背面示例文案',
              },
              previewDataJson: {
                type: 'string',
                description: '预览示例数据 JSON 字符串（key 对应字段名）',
              },
              fieldExtractionRules: {
                type: 'object',
                description: '字段提取规则映射（key 为字段名）；更新 fields 时必须与之一一对应',
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
        '复制已有模板为可编辑副本（is_built_in=false）。sourceTemplateId 必须来自 template_list。',
      inputSchema: {
        type: 'object',
        properties: {
          sourceTemplateId: {
            type: 'string',
            description: '源模板 ID',
          },
          name: {
            type: 'string',
            description: '新模板名称，默认源名称加 " (副本)"',
          },
          description: {
            type: 'string',
            description: '新模板描述',
          },
          setActive: {
            type: 'boolean',
            description: '是否设为激活，默认 true',
          },
        },
        required: ['sourceTemplateId'],
      },
    },
    {
      name: 'builtin-template_preview',
      description:
        '按模板 ID 或草稿做占位符替换，生成正/背面预览；缺 sampleData 时用库存 previewDataJson。',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: {
            type: 'string',
            description: '基于已有模板 ID 预览',
          },
          template: {
            type: 'object',
            description: '模板草稿对象（优先级低于 templateId）',
          },
          sampleData: {
            type: 'object',
            description: '示例数据（key 对应字段名）',
          },
        },
      },
    },
    {
      name: 'builtin-template_delete',
      description: '删除用户自定义模板，不可撤销；内置模板不可删除。删除前确认用户意图。',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: {
            type: 'string',
            description: '要删除的模板 ID',
          },
        },
        required: ['templateId'],
      },
    },
    {
      name: 'builtin-template_set_default',
      description: '设为默认制卡模板。模板须处于激活状态；templateId 必须来自 template_list。',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: {
            type: 'string',
            description: '要设为默认的模板 ID',
          },
        },
        required: ['templateId'],
      },
    },
  ],
};
