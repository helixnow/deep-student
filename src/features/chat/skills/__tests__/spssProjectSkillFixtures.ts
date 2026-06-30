export const SPSS_PAPER_ANALYSIS_SKILL = `---
name: SPSS 论文分析
description: 面向 SPSS 论文与问卷数据分析任务的项目级工作流技能，要求先确认变量角色、样本与分析目标，再加载统计、表格和笔记工具完成可复核分析。
version: 1.0.0
skillType: composite
dependencies:
  - ask-user
relatedSkills:
  - statistics-tools
  - learning-resource
  - xlsx-tools
  - canvas-note
allowedTools:
  - builtin-ask_user
  - builtin-resource_list
  - builtin-resource_read
  - builtin-resource_search
  - builtin-xlsx_read_structured
  - builtin-xlsx_extract_tables
  - builtin-note_create
  - builtin-note_set
  - builtin-note_append
  - builtin-note_replace
---

# SPSS 论文分析工作流

当用户需要做 SPSS、问卷、论文实证分析、信效度、相关、t 检验、ANOVA、卡方或回归时，先使用 \`load_skills\` 加载 \`statistics-tools\`、\`learning-resource\`、\`xlsx-tools\` 和 \`canvas-note\`。

开始分析前必须确认研究问题、数据文件、变量含义、变量角色、量表维度、分组变量、因变量和统计方法。禁止根据列名或表头自行猜测变量角色；如果信息不足，先用 \`builtin-ask_user\` 追问。

如果用户只提供已有 SPSS 输出或截图，当前只能解读现有输出，不能实际运行统计；只解读，不假装已经重新跑过统计。当前模型不支持直接查看图片/截图时，应要求用户提供可读取文本、表格或 OCR 内容。

首批支持范围包括描述统计、信度分析、相关、独立样本 t 检验、配对 t 检验、单因素 ANOVA、卡方检验和线性回归。超出当前技能首批支持范围的任务，需要说明限制并建议用户补充可执行工具或人工确认方法。
`;

export const STATISTICS_TOOLS_SKILL = `---
name: statistics-tools
description: 为 SPSS 论文分析提供统计数据检查、分析运行、结果解释和表格导出接口的项目级工具技能。
version: 1.0.0
skillType: standalone
embeddedTools:
  - name: mcp_stats_inspect_dataset
    description: Inspect dataset columns, labels, missingness, sample size, and variable candidates before deciding an analysis plan.
    inputSchema:
      type: object
      properties:
        resource_id:
          type: string
          description: Dataset resource identifier.
      required:
        - resource_id
  - name: mcp_stats_run_analysis
    description: Run a supported statistical analysis. The response includes analysis_type, assumption_checks, tables, and narrative_summary for paper writing.
    inputSchema:
      type: object
      properties:
        resource_id:
          type: string
          description: Dataset resource identifier.
        analysis_type:
          type: string
          enum:
            - descriptive
            - reliability
            - correlation
            - independent_t_test
            - paired_t_test
            - one_way_anova
            - chi_square
            - linear_regression
          description: Supported analysis type.
        variables:
          type: array
          description: Variables selected for the analysis.
          items:
            type: string
      required:
        - resource_id
        - analysis_type
  - name: mcp_stats_explain_result
    description: Explain statistical outputs, including assumption_checks and narrative_summary, in thesis-ready language.
    inputSchema:
      type: object
      properties:
        analysis_result_id:
          type: string
          description: Result identifier returned by mcp_stats_run_analysis.
      required:
        - analysis_result_id
  - name: mcp_stats_export_tables
    description: Export statistical tables for reports or notes after an analysis has been run.
    inputSchema:
      type: object
      properties:
        analysis_result_id:
          type: string
          description: Result identifier returned by mcp_stats_run_analysis.
        format:
          type: string
          enum:
            - markdown
            - csv
            - xlsx
      required:
        - analysis_result_id
---

# Statistics Tools

Use these MCP statistics tools only after the SPSS paper workflow has confirmed dataset identity, variable roles, and the intended analysis type.
`;

export const SPSS_PROJECT_SKILL_FIXTURES: Record<string, string> = {
  'spss-paper-analysis': SPSS_PAPER_ANALYSIS_SKILL,
  'statistics-tools': STATISTICS_TOOLS_SKILL,
};
