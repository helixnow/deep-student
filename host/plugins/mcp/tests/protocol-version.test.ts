import { describe, expect, it } from 'vitest';
import { ProtocolNegotiator, checkCompatibility, requiresOAuth, supportsSse, supportsStreamableHttp } from '../src/protocol-version.ts';

describe('mcp/protocol_version.rs', () => {
  it('test_version_ordering', () => {
    expect('2025-06-18' > '2025-03-26').toBe(true);
    expect('2025-03-26' > '2024-11-05').toBe(true);
  });
  it('test_version_features', () => {
    expect(supportsSse('2025-06-18')).toBe(false);
    expect(supportsStreamableHttp('2025-06-18')).toBe(true);
    expect(requiresOAuth('2025-06-18')).toBe(true);
    expect(supportsSse('2024-11-05')).toBe(true);
    expect(supportsStreamableHttp('2024-11-05')).toBe(false);
    expect(requiresOAuth('2024-11-05')).toBe(false);
  });
  it('test_version_negotiation', async () => {
    const n = new ProtocolNegotiator();
    expect(await n.negotiate({ supportedVersions: ['2025-06-18', '2025-03-26', '2024-11-05'] })).toBe('2025-06-18');
    expect(await n.negotiate({ supportedVersions: ['2024-11-05'] })).toBe('2024-11-05');
    expect(await n.negotiate({ protocol_version: '2025-03-26' })).toBe('2025-03-26');
  });
  it('test_transport_selection', () => {
    const n = new ProtocolNegotiator();
    expect(n.selectTransport('2025-06-18', ['stdio', 'websocket', 'sse', 'streamable_http'])).toBe('streamable_http');
    expect(n.selectTransport('2024-11-05', ['stdio', 'websocket', 'sse', 'streamable_http'])).toBe('websocket');
    expect(n.selectTransport('2025-06-18', ['stdio', 'sse'])).toBe('stdio');
  });
  it('test_compatibility_check', () => {
    expect(checkCompatibility('2025-06-18', '2025-06-18').kind).toBe('FullyCompatible');
    expect(checkCompatibility('2025-06-18', '2024-11-05').kind).toBe('BackwardCompatible');
    expect(checkCompatibility('2024-11-05', '2025-06-18').kind).toBe('LimitedCompatibility');
  });
  it('preserves fallback preference and field extraction order', async () => {
    const n = new ProtocolNegotiator().withPreferredVersion('2024-11-05');
    expect(await n.negotiate({})).toBe('2025-03-26');
    expect(await n.negotiate({ protocolVersion: null, protocol_version: '2025-06-18' })).toBe('2025-03-26');
    expect(await n.negotiate({ versions: [1, 'future'] })).toBe('2024-11-05');
    expect(n.selectTransport('2025-06-18', ['sse'])).toBeNull();
  });
});
