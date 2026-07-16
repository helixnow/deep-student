import React from 'react';
import i18n from '../i18n';
import { debugLog } from '../debug-panel/debugMasterSwitch';
import {
  BUILTIN_SERVER_ID,
  getBuiltinServer,
  isBuiltinServer,
  type McpServer,
  type McpTool,
} from '../mcp/builtinMcpServer';
import { setAvailableSearchEngines as updateSearchEngineCache } from '../mcp/searchEngineAvailability';

export type { McpServer, McpTool };

// 重新导出内置服务器相关函数
export { BUILTIN_SERVER_ID, isBuiltinServer };

type SearchEngine = { id: string; label: string };

const sanitizeIdList = (list: Array<unknown>): string[] => {
  if (!Array.isArray(list)) return [];
  const normalized = list
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (typeof item === 'number') return String(item);
      return '';
    })
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return Array.from(new Set(normalized));
};

interface DialogControlState {
  availableMcpTools: McpTool[];
  availableMcpServers: McpServer[];
  selectedMcpTools: string[];
  selectedMcpServers: string[]; // 新增：选中的服务器ID
  setSelectedMcpTools: (ids: string[]) => void;
  setSelectedMcpServers: (ids: string[]) => void;

  availableSearchEngines: SearchEngine[];
  selectedSearchEngines: string[];
  setSelectedSearchEngines: (ids: string[]) => void;

  reloadAvailability: () => Promise<void>;
  clearSelections: () => Promise<void>;
  // Provider ready flag
  ready: boolean;
}

const DialogControlContext = React.createContext<DialogControlState | null>(null);

export const useDialogControl = (): DialogControlState => {
  const ctx = React.useContext(DialogControlContext);
  if (!ctx) throw new Error('useDialogControl must be used within DialogControlProvider');
  return ctx;
};

export const DialogControlProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const RELOAD_COOLDOWN_MS = 1200;
  const [availableMcpTools, setAvailableMcpTools] = React.useState<McpTool[]>([]);
  const [availableMcpServers, setAvailableMcpServers] = React.useState<McpServer[]>([]);
  const [selectedMcpTools, setSelectedMcpTools] = React.useState<string[]>([]);
  const [selectedMcpServers, setSelectedMcpServersState] = React.useState<string[]>([]);
  const [availableSearchEngines, setAvailableSearchEngines] = React.useState<SearchEngine[]>([]);
  const [selectedSearchEngines, setSelectedSearchEngines] = React.useState<string[]>([]);
  const [ready, setReady] = React.useState<boolean>(false);
  const reloadInFlightRef = React.useRef<Promise<void> | null>(null);
  const lastReloadAtRef = React.useRef<number>(0);

  // 从数据库加载持久化选择
  const loadPersistedSelections = React.useCallback(async () => {
    try {
      const { TauriAPI } = await import('../utils/tauriApi');
      
      // 加载MCP工具选择
      try {
        const mcpSelection = await TauriAPI.getSetting('session.selected_mcp_tools');
        if (mcpSelection && mcpSelection.trim()) {
          const tools = sanitizeIdList(mcpSelection.split(','));
          setSelectedMcpTools(tools);
          debugLog.log('📥 恢复MCP工具选择:', tools);
        }
      } catch (e: unknown) {
        debugLog.warn('加载MCP工具选择失败:', e);
      }
      
      // 加载搜索引擎选择
      try {
        const engineSelection = await TauriAPI.getSetting('session.selected_search_engines');
        
        if (engineSelection && engineSelection.trim()) {
          const engines = sanitizeIdList(engineSelection.split(','));
          setSelectedSearchEngines(engines);
        } else if (engineSelection == null) {
          // 首次安装默认选择内置免费源；空字符串表示用户主动取消选择。
          setSelectedSearchEngines(['bing_rss']);
          await TauriAPI.saveSetting('session.selected_search_engines', 'bing_rss');
        }
      } catch (e: unknown) {
        // 加载搜索引擎选择失败（已禁用日志）
      }
    } catch (e: unknown) {
      debugLog.warn('加载持久化选择失败:', e);
    }
  }, []);

  // 保存MCP工具选择
  const persistentSetSelectedMcpTools = React.useCallback(async (tools: string[]) => {
    const normalized = sanitizeIdList(tools);
    setSelectedMcpTools(normalized);
    try {
      const { TauriAPI } = await import('../utils/tauriApi');
      const selection = normalized.join(',');
      await TauriAPI.saveSetting('session.selected_mcp_tools', selection);
      debugLog.log('💾 保存MCP工具选择:', normalized);
    } catch (e: unknown) {
      debugLog.warn('保存MCP工具选择失败:', e);
    }
  }, []);

  // 保存搜索引擎选择
  const persistentSetSelectedSearchEngines = React.useCallback(async (engines: string[]) => {
    const normalized = sanitizeIdList(engines);
    setSelectedSearchEngines(normalized);
    try {
      const { TauriAPI } = await import('../utils/tauriApi');
      const selection = normalized.join(',');
      await TauriAPI.saveSetting('session.selected_search_engines', selection);
    } catch (e: unknown) {
      // 保存搜索引擎选择失败（已禁用日志）
    }
  }, [selectedSearchEngines]);

  // 清空所有选择
  const clearSelections = React.useCallback(async () => {
    try {
      const { TauriAPI } = await import('../utils/tauriApi');
      // 使用Promise.allSettled确保部分失败不会影响其他操作
      const results = await Promise.allSettled([
        TauriAPI.saveSetting('session.selected_mcp_tools', ''),
        TauriAPI.saveSetting('session.selected_search_engines', '')
      ]);
      
      // 检查是否有失败的操作
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length > 0) {
        debugLog.warn('部分清空操作失败:', failures);
      }
      
      setSelectedMcpTools([]);
      setSelectedSearchEngines([]);
      debugLog.log('🧹 已清空所有工具选择');
    } catch (e: unknown) {
      debugLog.warn('清空选择失败:', e);
    }
  }, []);

  const reloadAvailability = React.useCallback(async () => {
    if (reloadInFlightRef.current) {
      await reloadInFlightRef.current;
      return;
    }
    if (Date.now() - lastReloadAtRef.current < RELOAD_COOLDOWN_MS) {
      return;
    }

    const task = (async () => {
      try {
        const { TauriAPI } = await import('../utils/tauriApi');
      // MCP tools - 优先使用前端 SDK 的在线工具列表，失败时回退到静态配置
      try {
        debugLog.log('正在通过前端SDK获取在线MCP工具列表...');
        const { McpService } = await import('../mcp/mcpService');
        // 不再每次 reload 都调用 connectAll()：
        // 1. 连接管理由 bootstrapMcpFromSettings() 一次性完成
        // 2. 反复 connectAll() 会导致资源泄漏（Tauri HTTP resource id invalid）
        // 3. 1.5s 超时不够远程服务器完成 MCP 握手，导致 listTools 返回空
        const [online, statusInfo] = await Promise.all([
          McpService.listTools(),
          McpService.status()
        ]);
        
        if (Array.isArray(online) && online.length > 0) {
          // 从设置中解析：
          // 1. displayNameMap: id -> name（用于显示友好名称）
          // 2. namespaceToIdMap: namespace（去掉冒号）-> id（用于关联工具与服务器）
          const displayNameMap = new Map<string, string>();
          const namespaceToIdMap = new Map<string, string>();
          try {
            const raw = await TauriAPI.getSetting('mcp.tools.list');
            const arr = (() => { try { return JSON.parse(raw || '[]'); } catch { return []; } })();
            if (Array.isArray(arr)) {
              for (const item of arr) {
                if (!item) continue;
                const itemId = String(item.id || '').trim();
                // 优先使用 name 作为显示名称，否则使用 namespace（去掉冒号）
                const label = String(item.name || '').trim() 
                  || String(item.namespace || '').replace(/:$/, '').trim();
                
                // 用 item.id 作为主 key（与 McpService 中的服务器 ID 匹配）
                if (itemId && label) {
                  displayNameMap.set(itemId, label);
                }
                
                // 建立 namespace -> id 的映射（工具名称前缀是 namespace，需要转换为 server.id）
                const nsBase = String(item.namespace || '').replace(/:$/, '').trim();
                if (nsBase && itemId) {
                  namespaceToIdMap.set(nsBase, itemId);
                  // 同时为 namespace 也设置显示名称
                  if (label) {
                    displayNameMap.set(nsBase, label);
                  }
                }
              }
            }
          } catch (e: unknown) { debugLog.warn('Failed to parse MCP server display name map:', e); }

          // 构建工具列表（包含serverId信息）
          // 注意：从工具名称提取的 serverId 实际上是 namespace，需要转换为真正的 server.id
          const toolsByServer = new Map<string, McpTool[]>();
          online.forEach((t: any) => {
            // 从工具名称提取 namespace 前缀（格式：namespace:toolName）
            const fullName = String(t.name);
            const colonIndex = fullName.indexOf(':');
            const namespace = colonIndex > 0 ? fullName.substring(0, colonIndex) : '';
            const toolName = colonIndex > 0 ? fullName.substring(colonIndex + 1) : fullName;
            
            // 将 namespace 转换为真正的 server.id
            const serverId = namespaceToIdMap.get(namespace) || namespace;
            
            const tool: McpTool = {
              id: fullName,
              name: toolName,
              description: t.description || '',
              isOnline: true,
              serverId: serverId || undefined,
              serverName: undefined, // 后面会填充
            };
            
            if (!toolsByServer.has(serverId)) {
              toolsByServer.set(serverId, []);
            }
            toolsByServer.get(serverId)!.push(tool);
          });
          
          // 构建服务器列表
          const servers: McpServer[] = (statusInfo?.servers || []).map((s: any) => {
            // 用 namespace 来查找工具（工具名称前缀是 namespace）
            // 如果 namespace 为空，尝试用 id 兜底
            const serverTools = toolsByServer.get(s.namespace) || toolsByServer.get(s.id) || [];
            // 优先使用配置中的友好名称，其次使用 McpService 返回的 namespace，最后使用 id
            const displayName = displayNameMap.get(String(s.id)) 
              || (s.namespace && s.namespace !== s.id ? s.namespace : null)
              || s.id;
            return {
              id: s.id,
              name: displayName,
              connected: s.connected,
              toolsCount: serverTools.length,
              tools: serverTools,
            };
          });
          
          // 更新工具的serverName
          const allTools = Array.from(toolsByServer.values()).flat();
          servers.forEach(server => {
            server.tools.forEach(tool => {
              tool.serverName = server.name;
            });
          });
          
          // 添加内置服务器到列表开头
          const builtinServer = getBuiltinServer();
          const allServers = [builtinServer, ...servers];
          const allToolsWithBuiltin = [...builtinServer.tools, ...allTools];

          setAvailableMcpTools(allToolsWithBuiltin);
          setAvailableMcpServers(allServers);
          debugLog.log(`✅ 成功获取${allToolsWithBuiltin.length}个MCP工具（含内置），来自${allServers.length}个服务器`);

          // 🆕 默认启用内置服务器：检查持久化设置，如果未曾禁用则自动选中
          try {
            const builtinDisabled = await TauriAPI.getSetting('mcp.builtin_server.disabled');
            if (builtinDisabled !== 'true') {
              // 内置服务器未被用户手动禁用，默认启用
              const builtinToolIds = builtinServer.tools.map(t => t.id);
              setSelectedMcpTools(prev => {
                const hasBuiltinSelected = builtinToolIds.some(id => prev.includes(id));
                if (!hasBuiltinSelected && builtinToolIds.length > 0) {
                  const newSelection = [...new Set([...prev, ...builtinToolIds])];
                  debugLog.log('🔧 默认启用内置检索工具:', builtinToolIds);
                  // 持久化
                  TauriAPI.saveSetting('session.selected_mcp_tools', newSelection.join(','))
                    .catch(e => debugLog.warn('保存默认MCP工具选择失败:', e));
                  return newSelection;
                }
                return prev;
              });
            }
          } catch {
            // 读取设置失败，默认启用内置服务器
            const builtinToolIds = builtinServer.tools.map(t => t.id);
            setSelectedMcpTools(prev => {
              if (!builtinToolIds.some(id => prev.includes(id))) {
                return [...new Set([...prev, ...builtinToolIds])];
              }
              return prev;
            });
          }
        } else {
          // 在线列表为空时也尝试回退
          throw new Error('empty_tools_list');
        }
      } catch (sdkError: unknown) {
        // 这是预期的回退机制，不是真正的错误
        const isEmptyList = sdkError instanceof Error && sdkError.message === 'empty_tools_list';
        if (isEmptyList) {
          debugLog.log('🔄 MCP工具列表为空，尝试后端命令与静态配置');
        } else {
          debugLog.warn('🔄 前端SDK获取失败，尝试后端命令与静态配置:', sdkError);
        }
        // 后端 MCP 已禁用，直接读取静态配置兜底，避免长时间等待
        try {
          const raw = await TauriAPI.getSetting('mcp.tools.list');
          const tools = (() => { try { return JSON.parse(raw || '[]'); } catch { return []; } })();
          const staticTools = (tools || []).map((t: any, idx: number) => ({
            id: String(t.id || t.name || `mcp_item_${idx}`),
            name: String(t.name || t.id || i18n.t('common:search_engines.unnamed_mcp', 'Unnamed MCP Item')),
            description: t.description || '',
            isOnline: false
          }));

          // 🆕 即使是静态配置回退，也添加内置服务器
          const builtinServer = getBuiltinServer();
          const allToolsWithBuiltin = [...builtinServer.tools, ...staticTools];
          setAvailableMcpTools(allToolsWithBuiltin);
          setAvailableMcpServers([builtinServer]); // 至少有内置服务器

          // 默认启用内置服务器
          const builtinDisabled = await TauriAPI.getSetting('mcp.builtin_server.disabled').catch(() => null);
          if (builtinDisabled !== 'true') {
            const builtinToolIds = builtinServer.tools.map(t => t.id);
            setSelectedMcpTools(prev => {
              if (!builtinToolIds.some(id => prev.includes(id))) {
                const newSelection = [...new Set([...prev, ...builtinToolIds])];
                TauriAPI.saveSetting('session.selected_mcp_tools', newSelection.join(','))
                  .catch((err) => { console.warn('[DialogControl] saveSetting selected_mcp_tools failed:', err); });
                return newSelection;
              }
              return prev;
            });
          }

          debugLog.log(`📋 使用静态MCP配置占位（含内置服务器），共${allToolsWithBuiltin.length}项`);
        } catch {
          // 即使静态配置也失败，仍然提供内置服务器
          const builtinServer = getBuiltinServer();
          setAvailableMcpTools(builtinServer.tools);
          setAvailableMcpServers([builtinServer]);
          setSelectedMcpTools(builtinServer.tools.map(t => t.id));
          debugLog.log('🔧 仅加载内置检索工具');
        }
      }
      // Search engines availability by keys/endpoints
      try {
        // 使用Promise.allSettled确保单个配置项失败不会影响其他配置
        const settingsResults = await Promise.allSettled([
          TauriAPI.getSetting('web_search.api_key.bing'),
          TauriAPI.getSetting('web_search.api_key.google_cse'),
          TauriAPI.getSetting('web_search.google_cse.cx'),
          TauriAPI.getSetting('web_search.api_key.serpapi'),
          TauriAPI.getSetting('web_search.api_key.tavily'),
          TauriAPI.getSetting('web_search.api_key.brave'),
          TauriAPI.getSetting('web_search.searxng.endpoint'),
          TauriAPI.getSetting('web_search.api_key.zhipu'),
          TauriAPI.getSetting('web_search.api_key.bocha'),
        ]);
        
        // 提取设置值，失败的设置返回null
        const [bing, gkey, gcx, serp, tav, brave, sxEndpoint, zhipu, bocha] = settingsResults.map(result => 
          result.status === 'fulfilled' ? result.value : null
        );
        const engines: SearchEngine[] = [
          { id: 'bing_rss', label: i18n.t('common:search_engines.bing_rss', 'Bing RSS (Free)') },
        ];
        if ((gkey || '').trim() && (gcx || '').trim()) engines.push({ id: 'google_cse', label: 'Google CSE' });
        if ((serp || '').trim()) engines.push({ id: 'serpapi', label: 'SerpAPI (Google)' });
        if ((tav || '').trim()) engines.push({ id: 'tavily', label: 'Tavily' });
        if ((brave || '').trim()) engines.push({ id: 'brave', label: 'Brave' });
        if ((sxEndpoint || '').trim()) engines.push({ id: 'searxng', label: 'SearXNG' });
        if ((zhipu || '').trim()) engines.push({ id: 'zhipu', label: i18n.t('common:search_engines.zhipu', 'Zhipu AI Search') });
        if ((bocha || '').trim()) engines.push({ id: 'bocha', label: i18n.t('common:search_engines.bocha', 'Bocha AI Search') });
        setAvailableSearchEngines(engines);
        // 🔧 同步更新搜索引擎缓存，让 TauriAdapter 能获取可用引擎列表
        updateSearchEngineCache(engines.map(e => e.id));
      } catch {
        // 配置读取失败不影响内置免费源。
        const fallbackEngines = [{ id: 'bing_rss', label: i18n.t('common:search_engines.bing_rss', 'Bing RSS (Free)') }];
        setAvailableSearchEngines(fallbackEngines);
        updateSearchEngineCache(['bing_rss']);
      }
      } catch (e: unknown) {
        debugLog.warn('reloadAvailability failed at top level:', e);
      } finally {
        lastReloadAtRef.current = Date.now();
        reloadInFlightRef.current = null;
      }
    })();

    reloadInFlightRef.current = task;
    await task;
  }, [RELOAD_COOLDOWN_MS]);

  // 同步服务器选择：根据选中的工具推断选中的服务器
  // 注意：仅在工具列表非空时执行反向推断，避免工具未加载完时误清空服务器选择
  React.useEffect(() => {
    if (availableMcpServers.length === 0) {
      return;
    }
    // 工具列表为空时不清空服务器选择：
    // 服务器可能已连接但工具尚未加载（异步竞态），此时清空会导致用户选择被撤销
    if (selectedMcpTools.length === 0) {
      return;
    }

    // 找出哪些服务器的工具被选中了（至少一个工具被选中即视为该服务器被选中）
    const selectedServers = availableMcpServers.filter(server => {
      if (server.tools.length === 0) return false;
      return server.tools.some(tool => selectedMcpTools.includes(tool.id));
    });

    const serverIds = selectedServers.map(s => s.id);
    setSelectedMcpServersState(serverIds);
  }, [selectedMcpTools, availableMcpServers]);

  // 选择清洗：与可用集同步，并在变更时持久化
  const cleanSelectionsAgainstAvailability = React.useCallback(async () => {
    try {
      // 避免对 state 原地排序，使用拷贝进行稳定比较
      const currentToolsSorted = [...selectedMcpTools].sort();
      const currentEnginesSorted = [...selectedSearchEngines].sort();

      // 预设默认值，保证后续引用总是已定义
      let cleanedTools = currentToolsSorted;
      let cleanedEngines = currentEnginesSorted;
      let toolsChanged = false;
      let enginesChanged = false;

      // MCP 工具清洗：当且仅当可用集合非空时执行，避免空白时误清空
      if (availableMcpTools.length === 0) {
        debugLog.log('⏸️ 可用MCP工具为空，跳过工具选择清洗以保留用户选择');
      } else {
        const availableToolIds = new Set(availableMcpTools.map(t => String(t.id)));
        cleanedTools = Array.from(new Set(selectedMcpTools.filter(id => availableToolIds.has(String(id))))).sort();
        toolsChanged =
          cleanedTools.length !== currentToolsSorted.length ||
          cleanedTools.some((v, i) => v !== currentToolsSorted[i]);
      }

      // 外部搜索引擎清洗：独立于 MCP 工具；当可用集合非空时执行
      if (availableSearchEngines.length === 0) {
        if (selectedSearchEngines.length > 0) {
          debugLog.log('🧹 无可用搜索引擎，清空遗留的选择以避免伪启用状态');
          cleanedEngines = [];
          enginesChanged = true;
        } else {
          debugLog.log('⏸️ 可用搜索引擎为空，无需清洗');
        }
      } else {
        const availableEngineIds = new Set(availableSearchEngines.map(e => String(e.id)));
        cleanedEngines = Array.from(new Set(selectedSearchEngines.filter(id => availableEngineIds.has(String(id))))).sort();
        enginesChanged =
          cleanedEngines.length !== currentEnginesSorted.length ||
          cleanedEngines.some((v, i) => v !== currentEnginesSorted[i]);
      }

      if (toolsChanged) {
        setSelectedMcpTools(cleanedTools);
        try { const { TauriAPI } = await import('../utils/tauriApi'); await TauriAPI.saveSetting('session.selected_mcp_tools', cleanedTools.join(',')); } catch (e: unknown) { debugLog.warn('Failed to persist cleaned MCP tool selection:', e); }
        debugLog.log('🧹 MCP工具选择已清洗并持久化:', cleanedTools);
      }
      if (enginesChanged) {
        setSelectedSearchEngines(cleanedEngines);
        try { const { TauriAPI } = await import('../utils/tauriApi'); await TauriAPI.saveSetting('session.selected_search_engines', cleanedEngines.join(',')); } catch (e: unknown) { debugLog.warn('Failed to persist cleaned search engine selection:', e); }
        debugLog.log('🧹 搜索引擎选择已清洗并持久化:', cleanedEngines);
      }
    } catch (e: unknown) {
      debugLog.warn('选择清洗失败（忽略）:', e);
    }
  }, [availableMcpTools, availableSearchEngines, selectedMcpTools, selectedSearchEngines]);

  React.useEffect(() => { 
    // 初始化仅运行一次，避免因依赖函数引用变化导致的重复执行
    const init = async () => {
      setReady(false);
      try {
        await Promise.all([
          loadPersistedSelections().catch((err) => { console.warn('[DialogControl] loadPersistedSelections failed:', err); }),
          (async () => { await reloadAvailability(); await cleanSelectionsAgainstAvailability(); })(),
        ]);
      } finally {
        // 无论成功失败，都不要阻塞 UI，保证 ready 最终置为 true
        setReady(true);
      }
    };
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 🔧 使用 ref 持有回调，避免回调引用变化导致事件监听器反复拆卸/重挂
  const reloadAvailabilityRef = React.useRef(reloadAvailability);
  reloadAvailabilityRef.current = reloadAvailability;
  const loadPersistedSelectionsRef = React.useRef(loadPersistedSelections);
  loadPersistedSelectionsRef.current = loadPersistedSelections;
  const cleanSelectionsRef = React.useRef(cleanSelectionsAgainstAvailability);
  cleanSelectionsRef.current = cleanSelectionsAgainstAvailability;

  React.useEffect(() => {
    const handler = async (event: Event) => {
      const detail = (event as CustomEvent<any>)?.detail;
      // 过滤：仅对 MCP/搜索引擎相关变更执行完整重载，跳过纯主题/调试等无关变更
      const isRelevant = !detail || detail.mcpChanged || detail.mcpReloaded ||
        (typeof detail.settingKey === 'string' && (detail.settingKey.startsWith('mcp.') || detail.settingKey.startsWith('web_search.')));
      if (!isRelevant) return;

      try {
        await loadPersistedSelectionsRef.current();
      } catch (e: unknown) { debugLog.warn('Failed to reload persisted selections on settings change:', e); }
      await reloadAvailabilityRef.current();
      await cleanSelectionsRef.current();
    };
    window.addEventListener('systemSettingsChanged', handler as EventListener);
    return () => window.removeEventListener('systemSettingsChanged', handler as EventListener);
  }, []); // 稳定 deps：回调通过 ref 访问

  // 🔧 修复：实时同步 MCP 连接状态到聊天面板
  // reloadAvailability() 只在初始化时快照一次 connected 状态，
  // 之后服务器连接/断开不会反映到 availableMcpServers，导致聊天面板显示"未连接"
  React.useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      try {
        const { McpService } = await import('../mcp/mcpService');
        if (disposed) return;
        unsubscribe = McpService.onStatus((statusInfo) => {
          if (disposed) return;
          // 只更新 connected/error 字段，不重建整个列表（避免丢失 tools 等信息）
          setAvailableMcpServers(prev => {
            if (prev.length === 0) return prev;
            let changed = false;
            const updated = prev.map(server => {
              // 内置服务器始终 connected=true
              if (isBuiltinServer(server.id)) return server;
              const fresh = statusInfo.servers.find(s => s.id === server.id);
              if (!fresh) return server;
              if (server.connected !== fresh.connected) {
                changed = true;
                return { ...server, connected: fresh.connected };
              }
              return server;
            });
            return changed ? updated : prev;
          });
        });
      } catch (e: unknown) {
        debugLog.warn('Failed to subscribe to MCP status updates:', e);
      }
    })();

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  // 🔧 修复竞态条件：监听 MCP 启动完成事件
  // main.tsx 中 bootstrapMcpFromSettings() 是异步执行的，可能晚于本 Provider 的初始化
  // 当 MCP 服务连接完成后，重新加载可用工具列表
  React.useEffect(() => {
    const handleMcpBootstrapReady = async () => {
      debugLog.log('📡 收到 MCP 启动完成事件，重新加载工具列表...');
      await reloadAvailabilityRef.current();
      await cleanSelectionsRef.current();
    };
    window.addEventListener('mcp-bootstrap-ready', handleMcpBootstrapReady as EventListener);
    return () => window.removeEventListener('mcp-bootstrap-ready', handleMcpBootstrapReady as EventListener);
  }, []); // 稳定 deps：回调通过 ref 访问

  // 取消对 window 全局的依赖广播，保持组件内一致性

  const value: DialogControlState = {
    availableMcpTools,
    availableMcpServers,
    selectedMcpTools,
    selectedMcpServers,
    setSelectedMcpTools: persistentSetSelectedMcpTools,
    setSelectedMcpServers: (ids: string[]) => {
      const sanitizedIds = sanitizeIdList(ids);
      setSelectedMcpServersState(sanitizedIds);
      // 增量更新工具选择：只操作被变更的服务器，保留其他工具选择不变
      // 1. 找出所有被选中服务器的工具ID
      const newServerToolIds = new Set(
        availableMcpServers
          .filter(s => sanitizedIds.includes(s.id))
          .flatMap(s => s.tools.map(t => t.id))
      );
      // 2. 找出所有被取消选中服务器的工具ID
      const removedServerToolIds = new Set(
        availableMcpServers
          .filter(s => !sanitizedIds.includes(s.id))
          .flatMap(s => s.tools.map(t => t.id))
      );
      // 3. 保留不属于被取消服务器的已选工具 + 添加新选中服务器的工具
      const updatedTools = selectedMcpTools
        .filter(id => !removedServerToolIds.has(id))
        .concat([...newServerToolIds].filter(id => !selectedMcpTools.includes(id)));
      persistentSetSelectedMcpTools(sanitizeIdList(updatedTools));
    },
    availableSearchEngines,
    selectedSearchEngines,
    setSelectedSearchEngines: persistentSetSelectedSearchEngines,
    reloadAvailability,
    clearSelections,
    ready,
  };

  return (
    <DialogControlContext.Provider value={value}>
      {children}
    </DialogControlContext.Provider>
  );
};
