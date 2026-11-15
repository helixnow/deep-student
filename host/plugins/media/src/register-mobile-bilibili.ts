import type { Context } from '@deepseek-ai/cordis';
import type { Commands } from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { HttpService } from '../../../platform/http/api.ts';
import type { SecretsService } from '../../../platform/secrets/api.ts';
import type { VfsIndexService } from '../../vfs-index/api.ts';
import { BILIBILI_API_BASE, BiliLookupClient, descriptorFromLookup } from './bilibili-client.ts';
import { findLinkItem, linkItemRepos, upsertLinkItem } from './bilibili-link-items.ts';
import { descriptorToBytes, pageUrl, pickTrack } from './bilibili-links.ts';
import { BILIBILI_LINK_EXTENSION } from './media-types.ts';
import { BiliRequestError, credentialHost, validateRequest } from './bilibili-policy.ts';
import { AuthClient } from './bilibili-auth.ts';
import { accountStatus, loadSession, loginQrPoll, logout, startLoginQr } from './bilibili-account.ts';
import { currentAuthEpoch } from './bilibili-auth-generation.ts';
import type { BiliRequest, BiliResponse } from './bilibili-attempt.ts';
import { buildTranscriptView, importSubtitle, isLinkItem, loadMediaFile, readLinkDescriptor } from './media-commands.ts';
import type { PortableMediaDeps } from './register-media-portable.ts';
import { MediaError } from './errors.ts';
import { attachmentToDstuNode, createdEvent } from '../../vfs/api.ts';

export function registerMobileBilibili(ctx: Context, deps: Pick<PortableMediaDeps, 'vfsDatabase' | 'vfsRepo'>): void {
  const tasks = new Map<string, AbortController>();
  const fail = (error: unknown): never => {
    const value = error instanceof MediaError ? error
      : error instanceof BiliRequestError ? new MediaError('Bilibili', error.message, error.payload.code)
        : new MediaError('Bilibili', error instanceof Error ? error.message : String(error), 'bilibili-request-failed');
    throw new CommandError(value.toPayloadString());
  };

  const store = () => {
    const secrets = ctx.reflect.get('secrets', false) as SecretsService | undefined;
    if (!secrets) throw new Error('移动凭据存储不可用');
    return secrets.openStore(ctx.app.dataDir);
  };
  function attempt(signal: AbortSignal, cookie: string | null, epoch: number) {
    const verifyIdentity = async () => {
      signal.throwIfAborted();
      if (epoch !== currentAuthEpoch()) throw new BiliRequestError('cancelled', 'B 站登录状态已变化，请重试');
    };
    return {
        verifyIdentity,
        async execute(input: Partial<BiliRequest> & Pick<BiliRequest, 'kind' | 'url'>): Promise<BiliResponse> {
          const http = ctx.reflect.get('http', false) as HttpService | undefined;
          if (!http) throw new Error('移动网络服务不可用');
          const method = input.method ?? 'GET', body = input.body ?? new Uint8Array();
          const maxBytes = input.maxBytes ?? 1024 * 1024;
          const deadline = input.deadlineMs ?? Date.now() + 20_000;
          let url = input.url;
          for (let hop = 0; hop <= 5; hop++) {
            await verifyIdentity();
            validateRequest({ kind: input.kind, url, method, body, maxBytes, headers: input.headers ?? {} });
            const timeoutMs = deadline - Date.now();
            if (timeoutMs <= 0) throw new BiliRequestError('timeout', 'B 站请求超时');
            const reply = await http.fetchBytes(url, {
              method, body: body.length === 0 ? undefined : body, maxBytes, timeoutMs,
              headers: { referer: 'https://www.bilibili.com/', ...input.headers,
                ...(cookie && credentialHost(url) ? { cookie } : {}) },
              redirect: 'manual', destination: 'public-pinned', signal,
            });
            await verifyIdentity();
            const location = reply.headers.location;
            // Short-link resolution already applies its own host checks and resolves the video id.
            // For asset redirects, check every hop against the same request policy.
            if (location && [301, 302, 303, 307, 308].includes(reply.status)
                && input.kind !== 'short_link' && method === 'GET') {
              url = new URL(location, url);
              continue;
            }
            return { status: reply.status, body: reply.bytes, headers: { ...reply.headers },
              header: name => reply.headers[name.toLowerCase()] ?? null,
              finalUrl: url, setCookies: credentialHost(url)
                ? (reply.headers['set-cookie'] ?? '').split(/,(?=\s*\w+=)/u).filter(Boolean) : [] };
          }
          throw new BiliRequestError('unsafe-url', 'B 站请求跳转次数过多');
        },
    };
  }

  const authClient = () => new AuthClient('https://passport.bilibili.com', BILIBILI_API_BASE, cookie =>
    attempt(new AbortController().signal, cookie, currentAuthEpoch()));
  async function auth<R>(call: () => Promise<R>): Promise<R> {
    try { return await call(); }
    catch (error) { throw new CommandError(error instanceof Error ? error.message : String(error)); }
  }
  ctx.commands.register('media_bilibili_auth_status', () => auth(() => accountStatus(store(), authClient())));
  ctx.commands.register('media_bilibili_logout', () => auth(async () => { await logout(store(), authClient()); return null; }));
  ctx.commands.register('media_bilibili_login_qr_start', () => auth(() => startLoginQr(authClient())));
  ctx.commands.register<Commands['media_bilibili_login_qr_poll']['args'], Commands['media_bilibili_login_qr_poll']['result']>(
    'media_bilibili_login_qr_poll', ({ qrcodeKey }) => auth(() => loginQrPoll(store(), authClient(), qrcodeKey, Date.now())));

  async function withClient<R>(taskId: string | null | undefined, run: (client: BiliLookupClient) => Promise<R>): Promise<R> {
    const controller = new AbortController();
    if (taskId) { tasks.get(taskId)?.abort(); tasks.set(taskId, controller); }
    try {
      const epoch = currentAuthEpoch();
      const session = await loadSession(store());
      const client = new BiliLookupClient(BILIBILI_API_BASE, {
        attempt: attempt(controller.signal, session?.cookie ?? null, epoch), cookie: session?.cookie ?? null,
      });
      return await run(client);
    } catch (error) { return fail(error); }
    finally { if (taskId && tasks.get(taskId) === controller) tasks.delete(taskId); }
  }

  function index(resourceId: string | null) {
    const vfs = ctx.get('vfsIndex') as VfsIndexService | undefined;
    if (resourceId && vfs) void vfs.indexing.indexResource(resourceId).catch(error =>
      ctx.logger('media.bilibili').warn('B 站条目已保存，索引更新失败: %s', String(error)));
  }

  ctx.commands.register<Commands['media_bilibili_cancel']['args'], null>('media_bilibili_cancel', ({ taskId }) => {
    tasks.get(taskId)?.abort();
    return null;
  });
  ctx.commands.register<Commands['media_bilibili_probe']['args'], Commands['media_bilibili_probe']['result']>(
    'media_bilibili_probe', ({ input, page, taskId }) => withClient(taskId, async client => {
      const result = await client.lookup(input, page);
      const { video, page: selected, tracks } = result;
      const existingId = findLinkItem(deps.vfsDatabase(), linkItemRepos(deps.vfsRepo()), video.bvid, selected.page);
      const cover = await client.coverDataUrl(video.cover);
      return { bvid: video.bvid, title: video.title, owner: video.owner, cover,
        durationMs: video.durationMs, pages: video.pages, page: selected.page,
        tracks: tracks.map(({ lan, lanDoc, ai }) => ({ lan, lanDoc, ai })),
        defaultLan: pickTrack(tracks, null)?.lan ?? null,
        url: pageUrl(video.bvid, selected.page), existingId, route: 'native',
        subtitleState: result.subtitleState, subtitleError: result.subtitleError?.message ?? null };
    }));
  ctx.commands.register<Commands['media_bilibili_create']['args'], Commands['media_bilibili_create']['result']>(
    'media_bilibili_create', ({ input, page, lan, taskId }, call) => withClient(taskId, async client => {
      const result = await client.lookup(input, page);
      const [track, bytes] = await client.subtitleBytes(result, lan ?? null);
      await client.attempt?.verifyIdentity();
      const db = deps.vfsDatabase(), repos = deps.vfsRepo();
      const descriptor = descriptorFromLookup(result);
      const linkRepos = linkItemRepos(repos);
      const existing = findLinkItem(db, linkRepos, descriptor.bvid, descriptor.page);
      const persisted = existing === null ? await repos.blobs.persistBlob(db.getConnSafe(), db.blobsDir(),
        descriptorToBytes(descriptor), BILIBILI_LINK_EXTENSION) : undefined;
      const { info, attachment } = upsertLinkItem(db, linkRepos, descriptor, bytes, persisted);
      if (attachment) {
        const node = attachmentToDstuNode(attachment);
        const event = createdEvent(node.path, node);
        const target = { kind: 'Window' as const, label: call.source.window };
        ctx.backendEvents.emitTo(target, 'dstu:change', event);
        ctx.backendEvents.emitTo(target, `dstu:change:${node.path}`, event);
      }
      index(info.resourceId);
      return { fileId: info.fileId, name: info.fileName, created: attachment !== null,
        segments: repos.mediaTranscripts.listSegments(db.getConnSafe(), info.fileId).length,
        lan: track.lan, lanDoc: track.lanDoc, ai: track.ai };
    }));
  ctx.commands.register<Commands['media_bilibili_import_subtitle']['args'], Commands['media_bilibili_import_subtitle']['result']>(
    'media_bilibili_import_subtitle', ({ resourceId, input, page, lan, taskId }) => withClient(taskId, async client => {
      const db = deps.vfsDatabase(), repos = deps.vfsRepo(), conn = db.getConnSafe();
      const info = loadMediaFile(conn, resourceId);
      const result = await client.lookup(input, page);
      if (isLinkItem(info)) {
        const own = readLinkDescriptor(conn, repos.files, db.blobsDir(), info);
        if (own.bvid !== result.video.bvid || own.page !== result.page.page) {
          throw new MediaError('InvalidInput', '链接条目只能重新获取它自己的字幕');
        }
      }
      const [, bytes] = await client.subtitleBytes(result, lan ?? null);
      await client.attempt?.verifyIdentity();
      importSubtitle(conn, repos.mediaTranscripts, repos.files, info, 'bilibili.json', bytes);
      index(info.resourceId);
      return buildTranscriptView(conn, repos.mediaTranscripts, info, false, true);
    }));
  ctx.commands.register<Commands['media_bilibili_link_get']['args'], Commands['media_bilibili_link_get']['result']>(
    'media_bilibili_link_get', ({ resourceId }) => {
      try {
        const db = deps.vfsDatabase(), conn = db.getConnSafe(), info = loadMediaFile(conn, resourceId);
        if (!isLinkItem(info)) throw new MediaError('InvalidInput', '不是 B 站链接条目');
        return readLinkDescriptor(conn, deps.vfsRepo().files, db.blobsDir(), info);
      } catch (error) { return fail(error); }
    });
}
