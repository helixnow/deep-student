import { Capacitor, registerPlugin } from '@capacitor/core';

export interface LegacyFile {
  name: string;
  kind: 'database' | 'asset' | 'root';
  size: number;
}

export interface LegacyData {
  slot: string;
  token: string;
  files: LegacyFile[];
}

interface LegacyFileChunk {
  token: string;
  name: string;
  kind: LegacyFile['kind'];
  offset: number;
  length: number;
}

const native = registerPlugin<{
  inspect(): Promise<({ available: true } & LegacyData) | { available: false }>;
  read(options: LegacyFileChunk): Promise<{ base64: string }>;
  close(options: { token: string }): Promise<void>;
}>('LegacyData');

export async function readLegacyData(): Promise<LegacyData | null> {
  if (Capacitor.getPlatform() !== 'android') return null;
  const result = await native.inspect();
  return result.available ? result : null;
}

export async function readLegacyFileChunk(args: unknown): Promise<Uint8Array> {
  const { base64 } = await native.read(args as LegacyFileChunk);
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}

export function closeLegacyData(args: unknown): Promise<void> {
  return native.close(args as { token: string });
}
