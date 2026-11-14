/**
 * Desktop host side of skill updates: `updates-core.ts` carries the whole flow; this module
 * re-exports it and binds the Node zip worker for tap repacks.
 */
import { isZipWorkerInfrastructureError, runZipTask } from './workers/zip-pool.ts';
import {
  SkillUpdates as CoreSkillUpdates, type SkillSubdirRepack, type SkillUpdateDeps,
} from './updates-core.ts';

export {
  AGENT_INSTALLED_MARKER, DEFAULT_AGENT_SKILLS_BASE, isRefetchableKind, isValidSkillId,
  parseStoredProvenance, refetchPackageBytes, resolveSkillMarketIdentity,
} from './updates-core.ts';
export type {
  RefetchDeps, RepoZipFetcher, SkillSubdirRepack, SkillUpdateDeps, SkillUpdateLogger,
  StoredProvenance, UpdateCommittedPackage, UpdatePackages, UpdatePreparedPackage,
} from './updates-core.ts';

/** Tap refetch repack stays on the Node zip worker (`Handoff`-style infra/content split). */
export const desktopTapRepack: SkillSubdirRepack = async (zipBytes, subdir, fallbackDirName) => {
  try {
    return await runZipTask<Uint8Array>('repackSkillSubdir', { zipBytes, subdir, fallbackDirName });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isZipWorkerInfrastructureError(error)) throw new Error(`Repack task failed: ${message}`);
    throw error;
  }
};

export class SkillUpdates extends CoreSkillUpdates {
  constructor(deps: SkillUpdateDeps) {
    super({ ...deps, repack: deps.repack ?? desktopTapRepack });
  }
}
