/**
 * `dstu-media/src/media/bilibili_stream.rs::playback_session` + `play_info_for`:
 * one BiliAttempt per `(file, qn, auth epoch, attempt)` stream key, reused by
 * the quality query and the subsequent range fetches.
 */
import type { VfsDatabase } from '../../vfs/api.ts';
import type { BiliLinkDescriptor } from '../api.ts';
import { BiliAttempt, type BiliAttemptDeps } from './bilibili-attempt.ts';
import { BiliLookupClient, BILIBILI_API_BASE } from './bilibili-client.ts';
import {
  cachedSource, attemptCacheKey, rememberSource, resolvePlayInfo, staleSource,
  PLAY_SOURCE_TTL_SECONDS, type PlayInfo,
} from './bilibili-stream.ts';
import { readLinkDescriptor, type LinkItemRepos } from './bilibili-link-items.ts';
import { MediaError } from './errors.ts';
import { BiliRequestError } from './bilibili-policy.ts';

const MAX_SESSIONS = 256;

interface Session {
  attempt: BiliAttempt;
  lastUsed: number;
}

const sessions = new Map<string, Session>();

export async function playbackSession(
  key: string,
  deps: BiliAttemptDeps,
): Promise<BiliAttempt> {
  const existing = sessions.get(key);
  if (existing !== undefined) {
    if (!existing.attempt.valid()
      || Date.now() - existing.lastUsed >= PLAY_SOURCE_TTL_SECONDS * 1000) {
      throw new BiliRequestError('identity-changed', '播放出口或账号已变化，请重新开始播放');
    }
    existing.lastUsed = Date.now();
    return existing.attempt;
  }
  if (sessions.size >= MAX_SESSIONS) {
    throw new BiliRequestError('session-limit',
      '播放会话已达本次运行上限，请重启应用后重试');
  }
  const attempt = await BiliAttempt.begin(deps, true);
  sessions.set(key, { attempt, lastUsed: Date.now() });
  return attempt;
}

/**
 * `bilibili_stream.rs::play_info_for`：复用播放会话，命中未过期的签名地址缓存；
 * 重新取地址后若清晰度或文件大小与旧地址不一致，说明视频源已改变。
 */
export async function playInfoFor(
  deps: BiliAttemptDeps,
  database: Pick<VfsDatabase, 'getConnSafe' | 'blobsDir'>,
  repos: LinkItemRepos,
  fileId: string,
  qn: number,
  epoch: number,
  attempt: number,
  fresh = false,
): Promise<PlayInfo> {
  const key = attemptCacheKey(fileId, qn, epoch, attempt);
  const session = await playbackSession(key, deps);
  if (!fresh) {
    const cached = cachedSource(key);
    if (cached !== null) return cached;
  }
  const descriptor: BiliLinkDescriptor = readLinkDescriptor(
    database.getConnSafe(), repos, database.blobsDir(), fileId);
  const client = new BiliLookupClient(BILIBILI_API_BASE, { attempt: session });
  await session.verifyIdentity();
  const info = await resolvePlayInfo(client, descriptor, qn);
  const previous = staleSource(key);
  if (previous !== null && (previous.quality !== info.quality
    || (previous.size !== null && info.size !== null && previous.size !== info.size))) {
    throw new MediaError('InvalidInput', '视频源已改变，请重新开始播放');
  }
  rememberSource(key, info);
  return info;
}

/** Test hook；生产命令只通过 `playbackSession` 访问。 */
export function forgetPlaybackSessions(): void {
  sessions.clear();
}
