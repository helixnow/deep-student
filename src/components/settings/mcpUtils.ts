/**
 * MCP 工具相关工具函数
 * 从 Settings.tsx 提取
 */

export const normalizeMcpToolList = (input: unknown): any[] => {
  const toArray = (value: unknown): any[] => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return [];
      try {
        return toArray(JSON.parse(trimmed));
      } catch {
        return [];
      }
    }
    if (typeof value === 'object') {
      const obj = value as any;
      if (Array.isArray(obj?.mcpTools)) {
        return toArray(obj.mcpTools);
      }
      if (Array.isArray(obj?.servers)) {
        return toArray(obj.servers);
      }
      if (obj?.mcpServers && typeof obj.mcpServers === 'object') {
        return Object.entries(obj.mcpServers).map(([key, cfg]) => {
          if (cfg && typeof cfg === 'object') {
            const typed = cfg as any;
            const transportType = typed.transportType ?? typed.type;
            const result: any = { id: typed.id ?? key, name: typed.name ?? key, ...typed };
            if (transportType && result.transportType == null) {
              result.transportType = transportType;
            }
            return result;
          }
          return { id: key, name: key, value: cfg };
        });
      }
      const looksLikeSingleTool = ['id', 'name', 'transportType', 'command', 'url', 'endpoint', 'fetch'].some(prop => prop in obj);
      if (looksLikeSingleTool) {
        return [obj];
      }
      return Object.entries(obj).map(([key, cfg]) => {
        if (cfg && typeof cfg === 'object') {
          const typed = cfg as any;
          const transportType = typed.transportType ?? typed.type;
          const result: any = { id: typed.id ?? key, name: typed.name ?? key, ...typed };
          if (transportType && result.transportType == null) {
            result.transportType = transportType;
          }
          return result;
        }
        return { id: key, name: key, value: cfg };
      });
    }
    return [];
  };

  const normalized = toArray(input).filter(item => item != null);
  return normalized.map((item, index) => {
    if (item && typeof item === 'object') {
      const result: any = { ...item };
      if (result.id == null && result.serverId != null) {
        result.id = result.serverId;
      }
      if (result.id == null) {
        result.id = result.name ?? `mcp_${index}`;
      }
      if (result.name == null && typeof result.id === 'string') {
        result.name = result.id;
      }
      if (result.transportType == null && result.type != null) {
        result.transportType = result.type;
      }
      return result;
    }
    return { id: `mcp_${index}`, name: String(item), value: item };
  });
};
