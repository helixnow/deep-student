/**
 * 社区 / 工坊插件智能体工具处理方法拿到的上下文类型（清单 `agentTools`，`docs/plugins/SDK.md` §3.4）。
 *
 * 单独成文件且不导入任何模块：`api.ts` 从这里转出类型，不会把内核实现（`plugin-agent-tools.ts`、`manifest.ts`）
 * 带进只需要类型的编译单元（例如渲染进程的类型检查）。
 */

/** 工具上下文里 `fetch` 的结果：只有状态与文本，不暴露响应对象。 */
export interface PluginAgentToolFetchResult {
  readonly status: number;
  readonly ok: boolean;
  readonly contentType: string | null;
  readonly text: string;
}

/**
 * 处理方法的第二个参数。由调用方（注册执行器的官方插件）构造；内核原样转交，不往里加任何能力。
 */
export interface PluginAgentToolContext {
  readonly signal: AbortSignal;
  /** 以 HTTPS GET 读取清单 `net:<主机名>` 声明过的主机；其他地址拒绝。 */
  fetch(url: string): Promise<PluginAgentToolFetchResult>;
}
