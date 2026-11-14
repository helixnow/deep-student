export type SandboxBackend = 'linux_bwrap' | 'macos_seatbelt';
export interface SandboxLaunch {
  backend: SandboxBackend;
  /** Already-built platform sandbox launcher/argv from the owning policy service. */
  program: string;
  args: readonly string[];
  cwd: string;
  /** Full whitelist, never merged with process.env. */
  env: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}
export interface SandboxedProcess {
  readonly pid: number;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  /**
   * Launcher-readiness pipe on fd 3. The sandboxed script starts with `printf R >&3; exec 3>&-;`; it only runs after
   * prlimit/ulimit, bwrap and sandbox-exec have all succeeded, so the first byte resolves `true`. The pipe closing
   * without a byte (a launcher layer failed and exited, the command did not write it, or a cleanup method ran)
   * resolves `false`. Never rejects. bwrap `--info-fd`/`--json-status-fd` are not used: they report the child pid
   * before namespace setup has finished.
   */
  readonly ready: Promise<boolean>;
  wait(): Promise<number | null>;
  terminateProcessGroup(): Promise<void>;
  cleanupFinishedProcessGroup(): Promise<void>;
  cleanupResources(): Promise<void>;
}
export interface NativeSandbox {
  /** Performs a real empty namespace/Seatbelt launch, not merely an executable-path check. */
  probe(backend: SandboxBackend, program?: string): Promise<{ available: true; program: string } | { available: false; reason: string }>;
  /** Awaits spawn success; never falls back to an unconfined shell. Policy construction stays in L05. */
  spawn(launch: SandboxLaunch): Promise<SandboxedProcess>;
  dispose(): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context { nativeSandbox: NativeSandbox }
}
