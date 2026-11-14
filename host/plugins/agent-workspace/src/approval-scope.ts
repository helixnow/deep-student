/** 工具审批作用域键提取器：移植 `chat_v2/approval_scope.rs`。
 *
 * 实现按职责拆分在 `src/approval-scope/`（核心类型、工具分类、env 计划、
 * 作用域标识、shell 分析、shell guard）；本文件保留原有导入路径，并注入桌面端口
 * （`env.node.ts`：macOS developer dir 探测、`fs::canonicalize`）后发布可移植子集。
 */
import './approval-scope/env.node.ts';

export * from './approval-scope/portable.ts';
export * from './approval-scope/path-operands.ts';
