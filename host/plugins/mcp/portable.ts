/** Web search logic shared by desktop and browser-worker hosts without desktop transport dependencies. */
export { doSearch } from './src/web-search.ts';
export {
  CN_TRUSTED_SITES, defaultProviderStrategies, hasValidKeys, loadToolConfig,
  normalizeProviderStrategies, parseCnCustomSites, parseProviderStrategies, serializeProviderStrategies, toolConfigFromEnv,
} from './src/web-search-config.ts';
export type { ToolConfig } from './src/web-search-core.ts';
