export interface ReleaseTarget { readonly platform: string; readonly arch: string; readonly libc?: string }
export interface LockEntry {
  version?: string;
  dev?: boolean;
  optional?: boolean;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  license?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  [field: string]: unknown;
}
export interface PackageLock { packages: Record<string, LockEntry>; [key: string]: unknown }
export interface FrontendManifest {
  generatedBy: string;
  packageLockSha256: string;
  packages: Array<{ path: string; version: string; via: Array<'bundle' | 'worker' | 'asset' | 'static-copy'> }>;
}

export const RELEASE_TARGETS: readonly ReleaseTarget[];
export const FRONTEND_MANIFEST: string;
export function packageLockHash(lock: unknown): string;
export function electronRuntimeLockPaths(lock: { packages?: Record<string, LockEntry> }, rootDependencies: Record<string, string>, targets?: readonly ReleaseTarget[]): Set<string>;
export function lockPathOfModule(id: string): string | null;
export function readFrontendManifest(repoRoot: string, lock: { packages?: Record<string, LockEntry> }): FrontendManifest;
export function shippedNpmPackages(repoRoot: string): { lock: PackageLock; shipped: Map<string, Set<'electron' | 'frontend'>> };
export function mobileRuntimePackages(repoRoot: string): { lock: PackageLock; shipped: Set<string> };
