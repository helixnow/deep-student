/** LLMManager's frontend MCP discovery/cache, mod.rs:7989–8285. */
const randomUUID = () => globalThis.crypto.randomUUID();
import type { WindowRef } from '../../../kernel/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { buildToolsWithMcp, type FrontendMcpTool } from './tools.ts';
import { prepareFrontendMcpToolForLegacyApi } from './mod_compat.ts';
import { logDebug, logInfo, logWarn } from './logging.ts';

/** Required F1 port; BackendEvents.listen is app-scoped and has no disposer yet. */
export interface McpFrontendBridge {
  listenWindow(window: WindowRef, event: string, receive: (payload: unknown) => void): () => void;
  emit(event: string, payload: JsonValue): void;
}
export interface LlmMcpTools {
  build(window: WindowRef | null): Promise<JsonValue[]>;
  preheat(window: WindowRef): Promise<number>;
  clear(): void;
}

function decodeTools(value: unknown): FrontendMcpTool[] {
  const tools = value !== null && typeof value === 'object' && 'tools' in value ? value.tools : [];
  if (!Array.isArray(tools)) return [];
  const result: FrontendMcpTool[] = [];
  for (const item of tools) {
    if (item === null || typeof item !== 'object' || typeof item.name !== 'string'
      || item.description != null && typeof item.description !== 'string') return [];
    result.push({ name: item.name, description: item.description ?? null, input_schema: item.input_schema ?? null });
  }
  return result;
}

export function createMcpToolsService(settings: Pick<SettingsStore, 'get'>, bridge: McpFrontendBridge,
  now: () => number = () => performance.now()): LlmMcpTools {
  let cache: { tools: FrontendMcpTool[]; at: number; ttl: bigint } | null = null;
  function setting(key: string): string | null { try { return settings.get(key); } catch { return null; } }
  function ttl(): bigint {
    const raw = setting('mcp.performance.cache_ttl_ms');
    if (raw === null || !/^\+?\d+$/.test(raw)) return 300_000n;
    const value = BigInt(raw); return value <= 0xffff_ffff_ffff_ffffn ? value : 300_000n;
  }
  function list(key: string): string[] { return (setting(key) ?? '').split(',').map(rustTrim).filter(Boolean); }
  async function request(window: WindowRef): Promise<FrontendMcpTool[]> {
    const correlationId = randomUUID();
    let receive!: (value: unknown) => void;
    const response = new Promise<unknown>(resolve => { receive = resolve; });
    const dispose = bridge.listenWindow(window, `mcp-bridge-tools-response:${correlationId}`, receive);
    try { bridge.emit('mcp-bridge-tools-request', { correlationId }); }
    catch (error) { throw new Error(`emit failed: ${error instanceof Error ? error.message : String(error)}`); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([response, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout waiting tools response')), 15_000);
      })]);
      return decodeTools(value);
    } finally { clearTimeout(timer); dispose(); }
  }
  async function getCached(window: WindowRef, cacheTtl: bigint): Promise<FrontendMcpTool[]> {
    if (cache !== null && cache.tools.length > 0 && BigInt(Math.floor((now() - cache.at) * 1_000_000)) <= cache.ttl * 1_000_000n) {
      return structuredClone(cache.tools);
    }
    let tools: FrontendMcpTool[];
    try { tools = await request(window); }
    catch (error) { logWarn(`MCP tools bridge failed: ${error instanceof Error ? error.message : String(error)}`); tools = []; }
    cache = { tools: structuredClone(tools), at: now(), ttl: cacheTtl };
    return tools;
  }
  return {
    async build(window) {
      const selectedEngines = setting('session.selected_search_engines') ?? '';
      const hasSelected = rustTrim(selectedEngines) !== '';
      logDebug(`[搜索引擎] 配置: ${JSON.stringify(selectedEngines)}, 工具可用: ${hasSelected}`);
      const engines = selectedEngines.split(',').map(rustTrim).filter(Boolean);
      if (hasSelected) {
        if (engines.length === 1) logDebug(`Single search engine selected: ${engines[0]}, engine parameter hidden`);
        logDebug(`[工具] web_search工具已成功添加到工具列表，选中引擎: ${JSON.stringify(engines)}`);
      } else logDebug('[工具] web_search工具未添加：没有选中的搜索引擎');
      const cacheTtl = ttl(), prefix = setting('mcp.tools.namespace_prefix') ?? '';
      const rawAdvertise = setting('mcp.tools.advertise_all_tools')?.toLowerCase();
      const advertiseAll = rawAdvertise !== undefined && rawAdvertise !== '0' && rawAdvertise !== 'false';
      const whitelist = list('mcp.tools.whitelist'), blacklist = list('mcp.tools.blacklist'), selected = list('session.selected_mcp_tools');
      const mcpTools = window === null ? [] : await getCached(window, cacheTtl);
      if (window === null) logDebug('[MCP] 无窗口 runtime：跳过前端 MCP 工具发现，工具集为空');
      let included = 0;
      for (const tool of mcpTools) if (rustTrim(tool.name) === '') logWarn(`[MCP] 跳过空名称工具: ${JSON.stringify(tool)}`);
      const result = buildToolsWithMcp({ selectedSearchEngines: selectedEngines, window, mcpTools,
        mcp: { advertiseAll, whitelist, blacklist, selected, namespacePrefix: prefix,
          prepare(tool, apiPrefix) {
            const prepared = prepareFrontendMcpToolForLegacyApi({ name: tool.name, description: tool.description,
              inputSchema: tool.input_schema }, apiPrefix);
            if (prepared === null) logWarn(`[MCP] 跳过无法规范化广告的工具: ${rustTrim(tool.name)}`);
            else included++;
            return prepared;
          } },
      });
      logDebug(`[MCP] 已广告前端MCP工具 ${included} 个`);
      logDebug(`[工具] 工具列表构建完成，总计 ${result.length} 个工具`);
      return result;
    },
    preheat: async window => (await getCached(window, ttl())).length,
    clear() { cache = null; logInfo('MCP tool cache cleared'); },
  };
}
