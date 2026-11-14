/** Shared by desktop SecureStore and the Worker implementation. */
const PATTERNS = ['internal.oauth.', 'web_search.api_key.', 'web_search.searxng.api_key', 'api_configs',
  'mcp.transport.', 'mcp.tools.', 'mcp.servers.', 'siliconflow.api_key', 'cloud_storage',
  'apiKey', 'api_key', 'secret', 'password', 'token', 'plugin.ilinkbot.credentials'];

export function isSensitiveKey(key: string): boolean {
  return key.endsWith('.api_key') || key.endsWith('.apiKey') || PATTERNS.some(pattern => key.startsWith(pattern));
}
