import { workshopInstallation, type WorkshopRemote } from './host-adapter';

export interface WorkshopRuntimeFailure { id: string; version?: string; error: string }

/** Route the exact failed release, never an old renderer's late error, to the managed task. */
export async function reportWorkshopRuntimeFailure(remote: WorkshopRemote, failure: WorkshopRuntimeFailure): Promise<void> {
  if (!failure.version) return;
  const card = (await remote.list()).find(item => item.pluginId === failure.id);
  if (!card) return;
  const installed = workshopInstallation(card);
  if (installed?.version !== failure.version || installed.state !== 'installed') return;
  if (card.validation?.version === failure.version && card.validation.status === 'pending' && remote.reportValidation) {
    await remote.reportValidation(card.id, failure.version, card.validation.revision, { ok: false, detail: failure.error });
  } else if (remote.reportFault) {
    await remote.reportFault(card.id, failure.error, failure.version);
  }
}
