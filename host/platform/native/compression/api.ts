/** Raw codecs. Callers retain their Rust size limits and error mapping. */
export interface NativeCompression {
  zstdEncode(bytes: Uint8Array, level?: number): Promise<Uint8Array>;
  zstdDecode(bytes: Uint8Array, maxOutputBytes?: number): Promise<Uint8Array>;
  gzipEncode(bytes: Uint8Array): Promise<Uint8Array>;
  gzipDecode(bytes: Uint8Array, maxOutputBytes?: number): Promise<Uint8Array>;
}
declare module '@deepseek-ai/cordis' {
  interface Context { nativeCompression: NativeCompression }
}
