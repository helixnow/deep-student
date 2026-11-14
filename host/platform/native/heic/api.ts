/** Desktop Rust validates the raw body, then rejects HEIC conversion. */
export interface NativeHeic {
  convertToJpeg(body: unknown): never;
}
declare module '@deepseek-ai/cordis' {
  interface Context { nativeHeic: NativeHeic }
}
