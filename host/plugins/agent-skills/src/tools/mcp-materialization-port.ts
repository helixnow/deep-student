/**
 * MCP 工具输出的落盘端口（`mcp-content-materializer.ts` 需要同步文件系统与 artifact root）。
 *
 * `GeneralToolExecutor` 在移动端也要加载，因此把“把大输出物化为 artifact 文件”这一步隔离成端口：
 * 桌面实现 `mcp-content-materializer.ts` 在模块求值时注册自己（`api.ts` 在桌面入口 import 它）；
 * 移动端没有该模块，缺省端口原样返回 MCP 输出（不落盘，事件与持久化仍是原始 JSON）。
 */
import type { JsonValue } from '../../../mcp/api.ts';

export interface McpMaterializationTarget {
  /** `ctx.services.app.dataDir`：session artifact root 的基目录。 */
  readonly dataDir: string;
  readonly sessionId: string;
  /** 原始工具名（外部 MCP 工具的全名）。 */
  readonly toolName: string;
  readonly usage: unknown;
}

export interface McpOutputMaterialization {
  materialize(output: unknown, target: McpMaterializationTarget): Promise<unknown>;
}

const passthrough: McpOutputMaterialization = {
  materialize: async output => output,
};

let active: McpOutputMaterialization = passthrough;

/** 桌面实现注册自己；`null` 恢复缺省（不落盘）。 */
export function setMcpOutputMaterialization(port: McpOutputMaterialization | null): void {
  active = port ?? passthrough;
}

/** 当前端口；`GeneralToolExecutor` 的外部 MCP 输出都经它。 */
export function mcpOutputMaterialization(): McpOutputMaterialization {
  return active;
}

export type { JsonValue };
