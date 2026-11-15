import { HostMcpService as HostMcpServiceCore, type McpServiceOptions } from './service-core.ts';
import { createTransportForConfig } from './probe.ts';

export { createWebSearchToolRegistry, type McpServiceOptions, type WebSearchRegistryOptions, type WebSearchToolDb, type WebSearchToolLog } from './service-core.ts';

export class HostMcpService extends HostMcpServiceCore {
  constructor(options: McpServiceOptions) {
    super(options, createTransportForConfig);
  }
}
