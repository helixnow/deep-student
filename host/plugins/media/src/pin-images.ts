/**
 * `src/commands.rs:356-395` pin_images / unpin_images. The temp session is owned by L22
 * (`appCommandState.modifyTempSession` = commands.rs:248-285); its errors propagate as-is.
 * The `pinned_images:<tempId>` settings mirror is best-effort, like Rust `let _ =`.
 */
import type { AppCommandState } from '../../integration/api.ts';
import type { SettingsService } from '../../../platform/settings/api.ts';

export interface PinImagesDeps {
  appCommandState(): AppCommandState;
  settings: Pick<SettingsService, 'save' | 'delete'>;
}

function ignore(operation: () => unknown): void {
  // boundary-allow empty-catch: commands.rs:374-378,392 `let _ =` ignores settings failures
  try { operation(); } catch { /* ignored */ }
}

export async function pinImages(deps: PinImagesDeps, tempId: string, images: string[]): Promise<boolean> {
  const pinned = images.length === 0 ? null : [...images];
  await deps.appCommandState().modifyTempSession(tempId, (session) => {
    session.pinned_images = pinned === null ? null : [...pinned];
  });
  const pinKey = `pinned_images:${tempId}`;
  if (images.length === 0) {
    ignore(() => deps.settings.delete(pinKey));
  } else {
    // serde_json::to_string(Vec<String>) cannot fail; JSON.stringify matches its compact form.
    const imagesJson = JSON.stringify(images);
    ignore(() => deps.settings.save(pinKey, imagesJson));
  }
  return true;
}

export async function unpinImages(deps: PinImagesDeps, tempId: string): Promise<boolean> {
  await deps.appCommandState().modifyTempSession(tempId, (session) => {
    session.pinned_images = null;
  });
  ignore(() => deps.settings.delete(`pinned_images:${tempId}`));
  return true;
}
