/** runtime_roots.rs:1132–1229 — exact filesystem authority granted by shell approval. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { rustTrim } from '../../../platform/util/index.ts';
import { normalizeRuntimeRelativePath, ioMessage, isWithin } from './runtime-paths.ts';
import { encodeRuntimeRootRecord } from './runtime-root-records.ts';
import { skillPackageRuntimeRoot } from './skill-packages.ts';
import {
  runtimeRootById, revalidateRuntimeRoot, runtimeRootIdentity, runtimeRootsForSession,
  runtimeRootBindingToken, shellApprovalBindingDigest, shellHostCwdApprovalBinding,
  stripWindowsVerbatimPath, skillPathOptions, type RuntimeRootDeps, type RuntimeRootApprovalBinding,
} from './runtime-roots.ts';

export function shellRuntimeApprovalBinding(
  deps: RuntimeRootDeps, sessionId: string, skillPackageRoots: ReadonlyMap<string, string> | null,
  rootId: string | null | undefined, cwd: string | null | undefined,
  supportReadableRoots: readonly string[], allowAbsoluteCwd: boolean,
): RuntimeRootApprovalBinding {
  const trimmedCwd = cwd == null ? '' : rustTrim(cwd);
  if (allowAbsoluteCwd && trimmedCwd !== '' && trimmedCwd !== '.' && path.isAbsolute(trimmedCwd)) {
    return shellHostCwdApprovalBinding(deps.settings, sessionId, trimmedCwd, deps.windowsFiles);
  }
  const selected = runtimeRootById(deps, sessionId, skillPackageRoots, rootId, true);
  selected.path = revalidateRuntimeRoot(deps.settings, selected, deps.windowsFiles);
  const relative = normalizeRuntimeRelativePath(cwd);
  let canonicalCwd: string;
  try { canonicalCwd = fs.realpathSync.native(path.join(selected.path, relative)); }
  catch (error) { throw new Error(`Failed to resolve shell cwd for approval: ${ioMessage(error)}`); }
  let validCwd = isWithin(selected.path, canonicalCwd);
  if (validCwd) {
    try { validCwd = fs.statSync(canonicalCwd).isDirectory(); } catch { validCwd = false; }
  }
  if (!validCwd) {
    throw new Error('Shell cwd is not a directory inside the selected runtime root');
  }
  const cwdIdentity = runtimeRootIdentity(canonicalCwd, deps.windowsFiles);
  const roots = runtimeRootsForSession(deps, sessionId, true)
    .filter(root => root.configured || root.kind === 'artifact' || root.kind === 'temp');
  if (!roots.some(root => root.id === selected.id)) roots.push({ ...selected });
  if (skillPackageRoots) for (const [skillId, rootPath] of skillPackageRoots) {
    roots.push(skillPackageRuntimeRoot(skillId, rootPath, skillPathOptions(deps)));
  }
  const readable: Array<[string, string]> = [];
  for (const root of roots) {
    root.path = revalidateRuntimeRoot(deps.settings, root, deps.windowsFiles);
    const display = stripWindowsVerbatimPath(root.path);
    if (readable.some(([existing]) => existing === display)) continue;
    readable.push([display, runtimeRootBindingToken(deps.settings, root, sessionId, deps.windowsFiles)]);
  }
  for (const support of supportReadableRoots) {
    let canonical: string;
    try { canonical = fs.realpathSync.native(support); }
    catch (error) { throw new Error(`Failed to resolve sandbox support root: ${ioMessage(error)}`); }
    const display = stripWindowsVerbatimPath(canonical);
    if (readable.some(([existing]) => existing === display)) continue;
    const payload = encodeRuntimeRootRecord({ kind: 'sandbox_support', canonical_path: canonical,
      identity: runtimeRootIdentity(canonical, deps.windowsFiles), access: 'read_only' });
    readable.push([display, createHash('sha256').update(payload).digest('hex')]);
  }
  readable.sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const selectedToken = runtimeRootBindingToken(deps.settings, selected, sessionId, deps.windowsFiles);
  return {
    rootId: selected.id, rootPath: stripWindowsVerbatimPath(selected.path), rootAccess: selected.access,
    rootSessionScoped: selected.session_scoped,
    rootBinding: shellApprovalBindingDigest(selectedToken, canonicalCwd, cwdIdentity, readable),
    readableRoots: readable.map(([rootPath]) => rootPath),
  };
}
