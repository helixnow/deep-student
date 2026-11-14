export interface PortableAssetOptions { includeSkills?: boolean; includePlugins?: boolean; mobile?: boolean }
export function isPortableAssetEnabled(key: string, options: PortableAssetOptions = {}): boolean {
  if (key.startsWith('app_data/skills/')) return options.includeSkills !== false;
  if (key.startsWith('app_data/plugins/') || key.startsWith('app_data/dstu-workshop/')) {
    if (options.includePlugins === false || /\.(node|dll|dylib|so|exe)$/i.test(key)) return false;
    // Trust/consent and enabled-entrypoint profiles are deliberately device-local.
    if (/\/(user\.profile|community-consent)\.json$/.test(key)) return false;
    if (options.mobile && key.startsWith('app_data/dstu-workshop/')) return false;
  }
  return true;
}
export function supportsMobilePlugin(manifest: Record<string, unknown>): boolean {
  return manifest.native !== true && manifest.desktopOnly !== true
    && Array.isArray(manifest.platforms) && manifest.platforms.includes('mobile');
}
