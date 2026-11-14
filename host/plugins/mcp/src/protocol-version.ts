// Port of dstu-mcp/src/mcp/protocol_version.rs.
import type { JsonValue } from '../api.ts';
export type ProtocolVersion = '2024-11-05' | '2025-03-26' | '2025-06-18';
export const ALL_VERSIONS: readonly ProtocolVersion[] = ['2025-06-18', '2025-03-26', '2024-11-05'];
export function parseVersion(value: string): ProtocolVersion | null {
  return ALL_VERSIONS.includes(value as ProtocolVersion) ? value as ProtocolVersion : null;
}
export function supportsSse(version: ProtocolVersion): boolean { return version !== '2025-06-18'; }
export function supportsStreamableHttp(version: ProtocolVersion): boolean { return version === '2025-06-18'; }
export function requiresOAuth(version: ProtocolVersion): boolean { return version !== '2024-11-05'; }
export class ProtocolNegotiator {
  _preferredVersions: ProtocolVersion[] = [...ALL_VERSIONS];
  withPreferredVersion(version: ProtocolVersion): this {
    this._preferredVersions = [version, ...this._preferredVersions.filter(v => v !== version)];
    return this;
  }
  async negotiate(serverInfo: JsonValue): Promise<ProtocolVersion> {
    const versions = this.extractServerVersions(serverInfo);
    if (!versions.length) return this._preferredVersions.at(-1) ?? '2024-11-05';
    for (const preferred of this._preferredVersions) if (versions.includes(preferred)) return preferred;
    return parseVersion(versions[0]!) ?? '2024-11-05';
  }
  extractServerVersions(info: JsonValue): string[] {
    if (!info || typeof info !== 'object' || Array.isArray(info)) return [];
    const versions: string[] = [];
    for (const field of ['supportedVersions', 'supported_versions', 'protocolVersions', 'protocol_versions', 'versions']) {
      const array = info[field];
      if (Array.isArray(array)) for (const v of array) if (typeof v === 'string') versions.push(v);
    }
    if (!versions.length) {
      const v = Object.hasOwn(info, 'protocolVersion') ? info.protocolVersion : info.protocol_version;
      if (typeof v === 'string') versions.push(v);
    }
    return versions;
  }
  selectTransport(version: ProtocolVersion, available: readonly string[]): string | null {
    if (supportsStreamableHttp(version) && available.includes('streamable_http')) return 'streamable_http';
    if (available.includes('websocket')) return 'websocket';
    if (supportsSse(version) && available.includes('sse')) return 'sse';
    return available.includes('stdio') ? 'stdio' : null;
  }
}
export type CompatibilityResult = { kind: 'FullyCompatible' }
  | { kind: 'BackwardCompatible' | 'LimitedCompatibility' | 'Incompatible'; message: string };
export function checkCompatibility(client: ProtocolVersion, server: ProtocolVersion): CompatibilityResult {
  if (client === server) return { kind: 'FullyCompatible' };
  if (client === '2025-06-18') return { kind: 'BackwardCompatible', message: 'Client is newer, some features may not be available' };
  if (client === '2024-11-05') return { kind: 'LimitedCompatibility', message: 'Client is older, authentication may be required' };
  return { kind: 'BackwardCompatible', message: 'Version mismatch, basic features should work' };
}
