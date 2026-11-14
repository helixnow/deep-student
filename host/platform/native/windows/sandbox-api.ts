export interface AppContainerProfile {
  readonly name: string;
  readonly sid: Uint8Array;
  close(): void;
}
export interface WindowsAppContainerLaunch {
  application: string;
  /** L05 owns PowerShell/git-bash quoting, payloads and trusted executable selection. */
  commandLine: string;
  cwd: string;
  /** Omitted means inherit, as Rust CreateProcessW(..., environment=null). */
  env?: Readonly<Record<string, string>>;
  capabilitySids?: readonly Uint8Array[];
  /** Existing helper std handles; omitted uses GetStdHandle, as in Rust. */
  stdio?: readonly [bigint, bigint, bigint];
  signal?: AbortSignal;
}
/**
 * `windows.rs::run_unsandboxed_job_process` (Danger Full Access): no AppContainer
 * and no ACL changes; only a KILL_ON_JOB_CLOSE Job for process-tree reclamation.
 */
export type WindowsFullAccessLaunch = Omit<WindowsAppContainerLaunch, 'capabilitySids'>;
/** Owns `Local\\DeepStudentShellAclMutex-v1`; release on the JS thread that acquired it. */
export interface WindowsAclMutexGuard {
  release(): void;
}
/** Win32 primitives; L05 remains owner of ACL policy, protected subtrees and helper protocol. */
export interface NativeWindowsSandbox {
  createProfile(name: string): AppContainerProfile;
  deriveCapabilitySids(name: string): Uint8Array[];
  readDacl(path: string): Uint8Array | null;
  writeDacl(path: string, dacl: Uint8Array | null, protect: boolean): void;
  runAppContainer(profile: AppContainerProfile, launch: WindowsAppContainerLaunch): Promise<number>;
  /** Suspended create, bind to an anonymous relaxed Job, then resume; 124 when cancelled. */
  runFullAccessJob(launch: WindowsFullAccessLaunch): Promise<number>;
  /** `acquire_acl_mutex`: polls every 100 ms; `null` when `signal` aborts first (Rust `Ok(None)`). */
  acquireAclMutex(signal?: AbortSignal): Promise<WindowsAclMutexGuard | null>;
  systemDirectory(): string;
}
declare module '@deepseek-ai/cordis' {
  interface Context { nativeWindowsSandbox: NativeWindowsSandbox }
}
