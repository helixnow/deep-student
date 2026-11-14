// Port of browser/service.rs DownloadRuntime and its transitions:
// on_download_requested (:1316), on_download_finished (:1445),
// finish_download_hash (:1514), list_downloads / list_task_downloads.

import type { BrowserDownloadObservation } from '../../../../contracts/ipc/generated/L19-mcp-browser.ts';
import type { BrowserSession } from './session.ts';
import { formatTimestamp, nowTimestamp } from './time.ts';
import {
  downloadOwnerForSession, hashDownloadFileBounded, releaseTaskDownloadReservation,
  sanitizeDownloadFilename, taskDownloadBudgetAvailable, MAX_BROWSER_DOWNLOAD_BYTES,
  MAX_DOWNLOAD_OBSERVATIONS, type DownloadHashResult,
} from './service.ts';
import {
  TaskObjectHandleBuilder, derivedEdge, hashTransformParams, managedLocator, withParamsHash,
  type TaskObjectHandle,
} from '../../agent-skills/api.ts';

const DOWNLOAD_ARTIFACT_DIR = 'browser-downloads';

export interface DownloadRuntimeOptions {
  /** Artifact root resolver (chat runtime). Downloads stay user-owned while null. */
  artifactRoot: ((chatSessionId: string) => Promise<string>) | null;
  now: () => Date;
  logWarn: (message: string) => void;
  /** `create_dir_all`; throws like the Rust `io::Error`. */
  createDirAll: (path: string) => void;
  /** `remove_file`; throws like the Rust `io::Error`. */
  removeFile: (path: string) => void;
}

/** Owned by BrowserRuntimeService; detached hash work reaches it only through a WeakRef. */
export class DownloadRuntime {
  private readonly options: DownloadRuntimeOptions;
  private readonly observations: BrowserDownloadObservation[] = [];
  private readonly completedBytes = new Map<string, number>();
  private readonly reservedBytes = new Map<string, number>();
  private readonly byPath = new Map<string, string>();

  constructor(options: DownloadRuntimeOptions) {
    this.options = options;
  }

  list(sessionId: string): BrowserDownloadObservation[] {
    return this.observations.filter(item => item.browserSessionId === sessionId)
      .map(item => ({ ...item }));
  }

  listForTask(chatSessionId: string): BrowserDownloadObservation[] {
    return this.observations.filter(item => item.chatSessionId === chatSessionId)
      .map(item => ({ ...item }));
  }

  async requested(
    session: BrowserSession | null, browserSessionId: string, url: string, originalName: string,
  ): Promise<{ allow: boolean; path: string | null }> {
    const owner = downloadOwnerForSession(session, browserSessionId);
    if (!owner.ok) return { allow: false, path: null };
    if (owner.owner === null) return { allow: true, path: null };
    const { artifactRoot, now, logWarn, createDirAll } = this.options;
    if (artifactRoot === null) {
      logWarn('[browser] failed to resolve download artifact root: artifacts root unavailable');
      return { allow: false, path: null };
    }
    let root: string;
    try { root = await artifactRoot(owner.owner); }
    catch (error) {
      logWarn(`[browser] failed to resolve download artifact root: ${String(error)}`);
      return { allow: false, path: null };
    }
    try { createDirAll(`${root}/${DOWNLOAD_ARTIFACT_DIR}`); }
    catch (error) {
      logWarn(`[browser] failed to create download artifact directory: ${String(error)}`);
      return { allow: false, path: null };
    }
    const filenameSafe = sanitizeDownloadFilename(originalName);
    const id = `bd_${globalThis.crypto.randomUUID()}`;
    const filename = `${id.slice(3, 11)}-${filenameSafe}`;
    const relativePath = `${DOWNLOAD_ARTIFACT_DIR}/${filename}`;
    let objectHandle: TaskObjectHandle;
    try {
      objectHandle = new TaskObjectHandleBuilder(
        `browser_download:${id}`, 'file', filename, 'browser_download',
      )
        .sourceUri(url)
        .tool('browser_downloads')
        .derivedEdge(withParamsHash(derivedEdge(url, 'browser.download'), hashTransformParams({ url })))
        .locator(managedLocator('artifacts', relativePath))
        .capabilities({
          readable: true, materializable: true, writable: false,
          shareable: false, sendable: false, deletable: true,
        })
        .observedAt(formatTimestamp(now()))
        .build();
    } catch (error) {
      logWarn(`[browser] failed to build download object handle: ${String(error)}`);
      return { allow: false, path: null };
    }
    const completed = this.completedBytes.get(owner.owner) ?? 0;
    const reserved = this.reservedBytes.get(owner.owner) ?? 0;
    if (!taskDownloadBudgetAvailable(completed, reserved)) {
      logWarn('[browser] rejecting download because task budget is exhausted');
      return { allow: false, path: null };
    }
    this.reservedBytes.set(owner.owner, reserved + MAX_BROWSER_DOWNLOAD_BYTES);
    const observation: BrowserDownloadObservation = {
      id,
      browserSessionId,
      chatSessionId: owner.owner,
      url,
      filename,
      state: 'started',
      rootId: 'artifacts',
      relativePath,
      locator: `runtime://artifacts/${relativePath}`,
      sha256: null,
      sizeBytes: null,
      error: null,
      startedAt: nowTimestamp(now),
      finishedAt: null,
      objectHandle,
    };
    this.observations.push(observation);
    const controlledPath = `${root}/${relativePath}`;
    this.byPath.set(controlledPath, id);
    // Rust keeps `MAX_DOWNLOAD_OBSERVATIONS` entries and evicts the oldest
    // completed/failed observation; started downloads are never evicted.
    while (this.observations.length > MAX_DOWNLOAD_OBSERVATIONS) {
      const index = this.observations.findIndex(
        item => item.state === 'completed' || item.state === 'failed',
      );
      if (index < 0) break;
      const [removed] = this.observations.splice(index, 1);
      if (removed === undefined) break;
      for (const [path, mapped] of this.byPath) {
        if (mapped === removed.id) this.byPath.delete(path);
      }
    }
    return { allow: true, path: controlledPath };
  }

  finished(url: string, path: string | null, success: boolean): void {
    const byPath = path === null ? undefined : this.byPath.get(path);
    const observation = byPath !== undefined
      ? this.observations.find(item => item.id === byPath)
      : [...this.observations].reverse().find(
        item => item.url === url && item.state === 'started',
      );
    if (observation === undefined) return;
    if (!success) {
      releaseTaskDownloadReservation(this.reservedBytes, observation.chatSessionId);
      observation.state = 'failed';
      observation.error = 'native download reported failure';
      observation.finishedAt = nowTimestamp(this.options.now);
      return;
    }
    observation.state = 'processing';
    const controlledPath = path ?? [...this.byPath.entries()]
      .find(([, id]) => id === observation.id)?.[0] ?? null;
    if (controlledPath === null) return;
    const id = observation.id;
    // Rust captures Weak<BrowserService>: detached hash work must not retain the
    // service, which owns this runtime and its warn sink.
    const weak = new WeakRef(this);
    const result = hashDownloadFileBounded(controlledPath, MAX_BROWSER_DOWNLOAD_BYTES,
      message => { weak.deref()?.options.logWarn(message); });
    if (result instanceof Promise) {
      void result.then(hash => weak.deref()?.finishHash(id, controlledPath, hash));
    } else {
      // Rust's spawn failure finishes the inline fallback before this callback returns.
      this.finishHash(id, controlledPath, result);
    }
  }

  private finishHash(id: string, controlledPath: string, result: DownloadHashResult): void {
    const observation = this.observations.find(item => item.id === id);
    if (observation === undefined) return;
    releaseTaskDownloadReservation(this.reservedBytes, observation.chatSessionId);
    if (result.ok) {
      this.completedBytes.set(
        observation.chatSessionId,
        (this.completedBytes.get(observation.chatSessionId) ?? 0) + result.size,
      );
      observation.state = 'completed';
      observation.sha256 = result.sha256;
      observation.sizeBytes = result.size;
      const handle = observation.objectHandle as TaskObjectHandle | null;
      if (handle !== null) {
        handle.sha256 = result.sha256;
        handle.sizeBytes = result.size;
      }
    } else {
      if (result.error === 'download exceeds per-file byte limit') {
        // boundary-allow empty-catch: Rust finish_download_hash 用 `let _ = remove_file` 忽略删除失败
        try { this.options.removeFile(controlledPath); } catch { /* Rust ignores remove errors */ }
      }
      observation.state = 'failed';
      observation.error = result.error;
    }
    observation.finishedAt = nowTimestamp(this.options.now);
  }
}
