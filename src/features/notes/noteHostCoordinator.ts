import type { FullDocumentSearchApi } from './fullDocument';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface NoteLeaseAuth { participant_id: string; token: string }
export interface NoteLeaseStatus { token: string; operation_id: string; owner_id: string; phase: string; expires_at: number; notes: Array<{ note_id: string; updated_at: string }>; waiting_for: string[] }
type ParticipantStatus = { participant_id: string; expires_at: number; active_lease: NoteLeaseStatus | null };
type FrozenDraft = { markdown: string; expected_updated_at: string };
type LeaseCancellation = { token: string; note_ids: string[]; reason: string };

export interface NoteHostParticipant {
  id: string;
  noteId: string;
  windowId?: string;
  api: FullDocumentSearchApi;
  dirty(): boolean;
  /** Freeze interaction and ordinary autosave; privileged flush remains available. */
  lock(): () => void;
  /** Wait for writes that started before the lock. Does not start queued writes. */
  settle(): Promise<void>;
  flush(): Promise<void>;
  invalidate(): void;
  refresh(): Promise<void>;
}

/** Every editor instance registers, including inactive classic panes. */
export class NoteHostCoordinator {
  private participants = new Map<string, NoteHostParticipant>();
  private locked = new Set<string>();
  private waiters = new Set<() => void>();
  private lockReleases = new Map<string, Array<() => void>>();
  private remote = new Map<string, { participantId: string; stopHeartbeat: () => void }>();
  private registrations = new Map<NoteHostParticipant, Promise<void>>();
  private activeLease: { auth: NoteLeaseAuth; noteIds: string[]; status: NoteLeaseStatus } | null = null;
  private leaseEvents: Promise<UnlistenFn> | null = null;
  private leaseEndedEvents: Promise<UnlistenFn> | null = null;
  private remoteLocks = new Map<string, Array<{ noteId: string; participantId: string; release: () => void }>>();
  private acknowledgements = new Map<string, Promise<void>>();
  private pendingParticipantLocks = new Map<string, { noteId: string; release: () => void }>();
  private startingOperationId: string | null = null;
  constructor(private assertWindowScope: () => Promise<void> = async () => {}) {}
  private isTauri() { return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window; }
  private async ensureLeaseEvents() {
    if (!this.isTauri()) return;
    if (!this.leaseEvents) this.leaseEvents = listen<NoteLeaseStatus>('notes:lease-changed', event => { void this.onLeaseChanged(event.payload); });
    if (!this.leaseEndedEvents) this.leaseEndedEvents = listen<LeaseCancellation>('notes:lease-ended', event => { void this.onLeaseEnded(event.payload); });
    await Promise.all([this.leaseEvents, this.leaseEndedEvents]);
  }
  private registerRemote(participant: NoteHostParticipant): Promise<void> {
    if (!this.isTauri() || this.remote.has(participant.id)) return Promise.resolve();
    const pending = this.registrations.get(participant);
    if (pending) return pending;
    const registration = this.installRemote(participant).finally(() => this.registrations.delete(participant));
    this.registrations.set(participant, registration);
    return registration;
  }
  private async installRemote(participant: NoteHostParticipant) {
    await this.ensureLeaseEvents();
    const result = await invoke<ParticipantStatus>('notes_editor_register', { noteId: participant.noteId });
    if (this.participants.get(participant.id) !== participant) {
      await invoke('notes_editor_unregister', { participantId: result.participant_id });
      return;
    }
    let stopped = false;
    const timer = window.setInterval(() => {
      if (!stopped) void invoke<ParticipantStatus>('notes_editor_heartbeat', { participantId: result.participant_id })
        .then(async status => {
          if (status.active_lease) await this.onLeaseChanged(status.active_lease);
          else for (const [token, locks] of this.remoteLocks) {
            if (locks.some(lock => lock.participantId === participant.id)) await this.onLeaseEnded({ token, note_ids: [], reason: 'expired' });
          }
        })
        .catch(error => { participant.invalidate(); console.warn('[notes] lease heartbeat failed', error); });
    }, 15000);
    this.remote.set(participant.id, { participantId: result.participant_id, stopHeartbeat: () => { stopped = true; window.clearInterval(timer); } });
    if (result.active_lease) await this.onLeaseChanged(result.active_lease);
  }
  private async unregisterRemote(participantId: string) {
    const remote = this.remote.get(participantId);
    if (!remote) return;
    this.pendingParticipantLocks.get(participantId)?.release();
    this.pendingParticipantLocks.delete(participantId);
    remote.stopHeartbeat(); this.remote.delete(participantId);
    await invoke('notes_editor_unregister', { participantId: remote.participantId }).catch(() => {});
  }
  register(participant: NoteHostParticipant): () => void {
    this.participants.set(participant.id, participant);
    void this.registerRemote(participant).catch(error => { participant.invalidate(); console.warn('[notes] lease registration failed', error); });
    // A mount racing an operation may read the old storage head. Keep it blocked
    // until refresh, rather than letting it join with an uncoordinated draft.
    if (this.locked.has(participant.noteId)) {
      this.pendingParticipantLocks.set(participant.id, { noteId: participant.noteId, release: participant.lock() });
      participant.invalidate();
    }
    this.waiters.forEach(notify => notify());
    return () => {
      if (this.participants.get(participant.id) === participant) this.participants.delete(participant.id);
      void this.unregisterRemote(participant.id);
    };
  }
  all(noteIds: readonly string[]) {
    return [...this.participants.values()].filter(entry => noteIds.includes(entry.noteId));
  }
  get(noteId: string, windowId?: string) {
    const entries = this.all([noteId]);
    return entries.find(entry => windowId !== undefined && entry.windowId === windowId) ?? entries.at(-1);
  }
  async waitFor(noteId: string, windowId?: string): Promise<NoteHostParticipant> {
    const existing = this.get(noteId, windowId);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const notify = () => { const entry = this.get(noteId, windowId); if (entry) { clearTimeout(timer); this.waiters.delete(notify); resolve(entry); } };
      const timer = setTimeout(() => { this.waiters.delete(notify); reject(new Error('笔记编辑器打开超时，请重试。')); }, 15000);
      this.waiters.add(notify);
      notify();
    });
  }
  async withLockedNotes<T>(ids: readonly string[], task: () => Promise<T>): Promise<T> {
    await this.assertWindowScope();
    const noteIds = [...new Set(ids)].sort();
    if (this.activeLease || this.startingOperationId || noteIds.some(id => this.locked.has(id))) throw new Error('笔记正在执行另一项操作，请稍后重试。');
    noteIds.forEach(id => this.locked.add(id));
    noteIds.forEach(id => this.lockReleases.set(id, []));
    let lease: { auth: NoteLeaseAuth; noteIds: string[]; status: NoteLeaseStatus } | null = null;
    try {
      for (const entry of this.all(noteIds)) this.lockReleases.get(entry.noteId)!.push(entry.lock());
      lease = await this.beginLease(noteIds);
      this.activeLease = lease;
      const result = await task();
      if (lease) await this.endLease(lease);
      lease = null;
      return result;
    } catch (error) {
      if (lease) {
        // A prior flush or migration may already have committed. Keep old save
        // baselines invalid even after releasing the temporary interaction lock.
        this.invalidateNotes(noteIds);
        await invoke('notes_editor_release', { lease: lease.auth, cancel: true }).catch(() => {});
      }
      this.activeLease = null;
      throw error;
    } finally {
      for (const id of noteIds) {
        for (const release of (this.lockReleases.get(id) ?? []).reverse()) release();
        this.lockReleases.delete(id);
        this.locked.delete(id);
        for (const [participantId, lock] of this.pendingParticipantLocks) {
          if (lock.noteId === id) { lock.release(); this.pendingParticipantLocks.delete(participantId); }
        }
      }
    }
  }
  async flushPendingSaves(ids: readonly string[]) {
    if (this.activeLease) {
      for (const noteId of new Set(ids)) {
        // The agreed draft may live only in another WebView. Flush by lease scope,
        // never by this renderer's dirty list. Unopened notes have no draft.
        await this.invokeWithLease('notes_editor_flush', { noteId, capabilities: ['ds-columns-v1'] });
      }
      this.invalidateNotes(ids);
      await this.refreshNotes(ids);
      return;
    }
    for (const noteId of new Set(ids)) {
      const entries = this.all([noteId]);
      await Promise.all(entries.map(entry => entry.settle()));
      const dirty = entries.filter(entry => entry.dirty());
      const drafts = dirty.map(entry => entry.api.getFullDocument().markdown);
      if (drafts.some(draft => draft !== drafts[0])) {
        throw new Error('同一笔记存在不同的未保存草稿。请先处理各窗口的草稿冲突。');
      }
      // One draft owns the write. Clean/identical siblings must not save an older
      // token after it, and must receive the confirmed storage head before use.
      if (dirty.length) {
        await dirty[0].flush();
        for (const sibling of entries.filter(entry => entry !== dirty[0])) {
          sibling.invalidate();
          await sibling.refresh();
        }
      } else if (!this.activeLease) {
        // Also drains an already in-flight save while interaction is frozen.
        for (const entry of entries) await entry.flush();
      }
    }
  }
  invalidateNotes(ids: readonly string[]) { this.all(ids).forEach(entry => entry.invalidate()); }
  async refreshNotes(ids: readonly string[]) {
    const results = await Promise.allSettled(this.all(ids).map(entry => entry.refresh()));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  getLeaseAuth(noteId?: string): NoteLeaseAuth | undefined {
    return this.activeLease && (!noteId || this.activeLease.noteIds.includes(noteId)) ? this.activeLease.auth : undefined;
  }
  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.invokeWithLease<T>(command, args);
  }
  private async invokeWithLease<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const lease = this.activeLease?.auth;
    return invoke<T>(command, lease && args.lease === undefined ? { ...args, lease } : args);
  }
  private async beginLease(noteIds: string[]) {
    if (!this.isTauri()) return null;
    const entries = this.all(noteIds);
    await Promise.all(entries.map(entry => this.registerRemote(entry)));
    await Promise.all(entries.map(entry => entry.settle()));
    const owner = entries.find(entry => noteIds.includes(entry.noteId));
    const ownerRemote = owner && this.remote.get(owner.id);
    if (!ownerRemote) throw new Error('笔记编辑器尚未完成跨窗口注册，请重试。');
    const operationId = `note-op-${crypto.randomUUID()}`;
    this.startingOperationId = operationId;
    let auth: NoteLeaseAuth | null = null;
    try {
      let status = await invoke<NoteLeaseStatus>('notes_editor_begin', {
        participantId: ownerRemote.participantId, operationId, noteIds,
      });
      auth = { participant_id: ownerRemote.participantId, token: status.token };
      await Promise.all(entries.map(entry => this.freezeAck(entry, auth!)));
      while (status.phase !== 'ready') {
        if (Date.now() >= status.expires_at * 1000) throw new Error('等待其他笔记窗口冻结超时，请重试。');
        await new Promise(resolve => setTimeout(resolve, 50));
        const next = await invoke<NoteLeaseStatus | null>('notes_editor_lease_status', { token: status.token });
        if (!next) throw new Error('笔记操作租约已取消，请重试。');
        status = next;
      }
      return { auth, noteIds, status };
    } catch (error) {
      if (auth) await invoke('notes_editor_release', { lease: auth, cancel: true }).catch(() => {});
      throw error;
    } finally {
      this.startingOperationId = null;
    }
  }
  private async freezeAck(entry: NoteHostParticipant, auth: NoteLeaseAuth) {
    const remote = this.remote.get(entry.id);
    if (!remote) throw new Error('笔记编辑器尚未完成跨窗口注册，请重试。');
    await entry.settle();
    const expected = entry.api.getStorageUpdatedAt?.();
    if (!expected) throw new Error('笔记编辑器缺少保存版本，请重新打开笔记。');
    const draft: FrozenDraft = { markdown: entry.api.getFullDocument().markdown, expected_updated_at: expected };
    await invoke('notes_editor_freeze_ack', { lease: { participant_id: remote.participantId, token: auth.token }, draft });
  }
  private async endLease(lease: { auth: NoteLeaseAuth; noteIds: string[]; status: NoteLeaseStatus }) {
    if (!this.activeLease || this.activeLease.auth.token !== lease.auth.token) return;
    try {
      const status = await invoke<NoteLeaseStatus>('notes_editor_finish', { lease: lease.auth });
      await Promise.all(this.all(lease.noteIds).map(entry => this.onParticipantLease(entry, status)));
      const deadline = Date.now() + 30000;
      let finalStatus = await invoke<NoteLeaseStatus | null>('notes_editor_lease_status', { token: lease.auth.token });
      while (finalStatus?.waiting_for.length) {
        if (Date.now() >= Math.min(deadline, finalStatus.expires_at * 1000)) throw new Error('等待其他笔记窗口刷新超时，请重试。');
        await new Promise(resolve => setTimeout(resolve, 50));
        finalStatus = await invoke<NoteLeaseStatus | null>('notes_editor_lease_status', { token: lease.auth.token });
      }
      if (!finalStatus) throw new Error('笔记操作租约已取消，请重试。');
      await invoke('notes_editor_release', { lease: lease.auth, cancel: false });
    } finally {
      this.activeLease = null;
    }
  }
  private async onLeaseChanged(status: NoteLeaseStatus) {
    if (!this.isTauri() || this.startingOperationId === status.operation_id) return;
    const entries = this.all(status.notes.map(note => note.note_id));
    if (!entries.length) return;
    await Promise.all(entries.map(entry => this.onParticipantLease(entry, status)))
      .catch(error => console.warn('[notes] remote lease update failed', error));
  }
  private async onParticipantLease(entry: NoteHostParticipant, status: NoteLeaseStatus) {
    const remote = this.remote.get(entry.id);
    const note = status.notes.find(item => item.note_id === entry.noteId);
    if (!remote || !note) return;
    if (!status.waiting_for.includes(remote.participantId)) return;
    const key = `${status.token}/${status.phase}/${remote.participantId}`;
    const pendingAck = this.acknowledgements.get(key);
    if (pendingAck) return pendingAck;
    const work = this.acknowledgeParticipant(entry, status, remote.participantId, note.updated_at);
    this.acknowledgements.set(key, work);
    return work;
  }
  private async acknowledgeParticipant(entry: NoteHostParticipant, status: NoteLeaseStatus, participantId: string, updatedAt: string) {
    const owned = this.activeLease?.auth.token === status.token;
    const locks = this.remoteLocks.get(status.token) ?? [];
    if (!owned && !locks.some(lock => lock.participantId === entry.id)) {
      const pending = this.pendingParticipantLocks.get(entry.id);
      const release = pending?.release ?? entry.lock();
      this.pendingParticipantLocks.delete(entry.id);
      this.locked.add(entry.noteId);
      locks.push({ noteId: entry.noteId, participantId: entry.id, release });
      this.remoteLocks.set(status.token, locks);
    }
    if (status.phase === 'refreshing') {
      entry.invalidate();
      await entry.refresh();
      if (entry.api.getStorageUpdatedAt?.() !== updatedAt) throw new Error('笔记刷新版本不匹配，请重试。');
      await invoke('notes_editor_refresh_ack', { lease: { participant_id: participantId, token: status.token }, updatedAt });
      return;
    }
    if (status.phase !== 'pending') return;
    await this.freezeAck(entry, { participant_id: participantId, token: status.token });
  }
  private async onLeaseEnded(event: LeaseCancellation) {
    for (const key of this.acknowledgements.keys()) if (key.startsWith(`${event.token}/`)) this.acknowledgements.delete(key);
    const locks = this.remoteLocks.get(event.token);
    if (!locks) return;
    this.remoteLocks.delete(event.token);
    for (const lock of locks) {
      if (event.reason !== 'released') this.participants.get(lock.participantId)?.invalidate();
      lock.release();
      this.locked.delete(lock.noteId);
    }
  }
}

export const noteHostCoordinator = new NoteHostCoordinator();
