---
name: statistics-tools
description: SPSS 论文分析的统计执行工具组。为 `.sav`、`csv/xlsx` 等数据分析场景声明 MCP 统计后端接口，包括数据集检查、统计分析执行、结果解释与论文表格导出。适用于需要把统计执行能力按需注入到 DeepStudent 会话中的场景。
version: 1.0.0
author: Deep Student Project
skill-type: standalone
embedded-tools:
  - name: mcp_stats_inspect_dataset
    description: 检查统计数据集的变量信息、标签、变量类型、缺失情况和可分析性摘要。适用于 `.sav`、`csv`、`xlsx` 等数据资源的预检查阶段，用于在正式分析前确认变量结构并发现缺失或编码问题。
    inputSchema:
      type: object
      properties:
        resource_id:
          type: string
          description: 必填，待检查数据资源的 ID。
        format_hint:
          type: string
          description: 可选，资源格式提示，如 sav、csv、xlsx。
      required:
        - resource_id
  - name: mcp_stats_run_analysis
    description: 基于指定资源和变量映射运行统计分析。必须返回包含 `analysis_type`、`variables`、`assumption_checks`、`statistics`、`p_value`、`effect_size`（如适用）、`warnings`、`narrative_summary` 的结果对象，供后续论文解释和结果写作使用。调用前必须先确认变量角色与分析目标，禁止在未知变量含义时直接执行。`analysis_type` 仅支持 descriptive、reliability、correlation、independent_t_test、paired_t_test、one_way_anova、chi_square、linear_regression。
    inputSchema:
      type: object
      properties:
        resource_id:
          type: string
          description: 必填，待分析数据资源的 ID。
        analysis_type:
          type: string
          description: 必填，统计分析类型。
          enum:
            - descriptive
            - reliability
            - correlation
            - independent_t_test
            - paired_t_test
            - one_way_anova
            - chi_square
            - linear_regression
        variables:
          type: object
          description: 必填，分析所需变量映射，如 dependent、independent、group、predictors 等。
        options:
          type: object
          description: 可选，前提检查、缺失值处理、置信区间、效应量等执行选项。
      required:
        - resource_id
        - analysis_type
        - variables
  - name: mcp_stats_explain_result
    description: 将统计分析结果转换为面向用户或论文写作的解释文本。输入应来自 `mcp_stats_run_analysis` 的结果对象，输出应包含通俗解释、学术表述和论文方法/结果写法草稿。
    inputSchema:
      type: object
      properties:
        analysis_result:
          type: object
          description: 必填，统计分析结果对象。
        audience:
          type: string
          description: 可选，解释面向对象，如 student、researcher、reviewer。
        style:
          type: string
          description: 可选，解释风格，如 plain_language、paper_results、paper_methods。
      required:
        - analysis_result
  - name: mcp_stats_export_tables
    description: 将统计分析结果转换为适合论文或报告引用的结构化表格数据。适用于需要导出 APA 风格结果表、描述统计表、回归表或附录表的场景。
    inputSchema:
      type: object
      properties:
        analysis_result:
          type: object
          description: 必填，统计分析结果对象。
        format:
          type: string
          description: 必填，导出格式，如 markdown、json、apa_table。
      required:
        - analysis_result
        - format
---

# statistics-tools

这是 SPSS 论文分析工作流的统计执行工具组。

## 使用要求

1. 在调用 `mcp_stats_run_analysis` 之前，先明确研究问题和变量角色。
2. 如果变量含义、分组方式或量表方向不清楚，不要直接执行统计。
3. 解释类和导出类工具只处理已有结果对象，不负责自行猜测缺失字段。
4. 如果 MCP 后端不可用，调用方应退化为解释模式，而不是伪造执行结果。

## 结果对象契约

`mcp_stats_run_analysis` 的返回结果应统一包含：

- `analysis_type`
- `variables`
- `assumption_checks`
- `statistics`
- `p_value`
- `effect_size`（如适用）
- `warnings`
- `narrative_summary`

调用方应依赖这个统一结构完成结果解释、论文写作和表格导出。
