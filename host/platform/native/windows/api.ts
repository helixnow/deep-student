export interface WindowsFileInformation {
  attributes: number;
  volume_serial_number: number;
  file_index: bigint;
  size: bigint;
}
export interface WindowsRegularFile {
  readonly information: WindowsFileInformation;
  /** Read from offset zero; bound checked against the opened handle, not path metadata. */
  read(maxBytes: number): Uint8Array;
  /**
   * One `ReadFile` at an explicit offset on this same handle (Rust `File::read`
   * after a seek): returns at most `maxBytes`, possibly fewer; empty means EOF.
   * Never reopens the path and never caches the whole file.
   */
  readAt(offset: bigint, maxBytes: number): Uint8Array;
  /** Fresh `GetFileInformationByHandle` on this handle (Rust `file.metadata()`); `information` stays the open-time snapshot. */
  refreshInformation(): WindowsFileInformation;
  close(): void;
}
export interface NativeWindowsFiles {
  runtimeRootIdentity(path: string): { kind: 'windows'; volume_serial_number: number; file_index: bigint };
  openRegularFileNoFollow(path: string, label: string): WindowsRegularFile;
  /** Raw Win32 message + (os error N), with the system's current language. */
  ioError(code: number): string;
}
declare module '@deepseek-ai/cordis' {
  interface Context { nativeWindowsFiles: NativeWindowsFiles }
}
