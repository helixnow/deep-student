/** Bilibili account, link items, playback protocol and browser bridge (`src/media/bilibili*.rs`). */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import type { SecretsService } from '../../../platform/secrets/api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import { attachmentToDstuNode, createdEvent } from '../../vfs/api.ts';
import type { VfsAttachment } from '../../vfs-repos/api.ts';
import { accountStatus, loadSession, loginQrPoll, logout, startLoginQr } from './bilibili-account.ts';
import { AttemptLock, BiliAttempt, type BiliAttemptDeps } from './bilibili-attempt.ts';
import { AuthClient } from './bilibili-auth.ts';
import { BRIDGE_BASE } from './bilibili-bridge.ts';
import { BridgeHub } from './bilibili-bridge-hub.ts';
import { BridgeServer } from './bilibili-bridge-server.ts';
import { BILIBILI_API_BASE, BiliLookupClient, descriptorFromLookup, type BiliLookup } from './bilibili-client.ts';
import { findLinkItem, linkItemRepos, upsertLinkItem } from './bilibili-link-items.ts';
import { pageUrl, pickTrack } from './bilibili-links.ts';
import { playInfoFor, playbackSession } from './bilibili-playback.ts';
import { BiliRequestError } from './bilibili-policy.ts';
import { createBiliStreamProtocolHandler } from './bilibili-protocol.ts';
import { biliStreamUrl, normalizeQn, parseStreamPath, rememberSource, type PlayInfo } from './bilibili-stream.ts';
import { BiliTaskRegistry } from './bilibili-tasks.ts';
import { BiliTransportState, decodeTransportSettings, transportStatus } from './bilibili-transport.ts';
import { MediaError } from './errors.ts';
import { importSubtitle, isLinkItem, loadMediaFile, readLinkDescriptor } from './media-commands.ts';
import type { MediaPluginDeps } from './plugin-deps.ts';
import { cancelMedia, mediaFailure } from './plugin-deps.ts';
import { parseSubtitle } from './subtitle.ts';

export function registerBilibiliCommands(ctx: Context, deps: MediaPluginDeps): void {
  const { vfsDatabase, vfsRepo } = deps;
  const secrets = (): SecretsService => {
    const service = ctx.get('secrets') as SecretsService | undefined;
    if (service === undefined) throw new CommandError('B 站账号存储不可用');
    return service;
  };
  const authClient = (): AuthClient =>
    new AuthClient('https://passport.bilibili.com', 'https://api.bilibili.com',
      (cookie) => BiliAttempt.native({ state: biliTransport, hub: bridgeHub, nativeCookie: cookie }));
  const bridgeHub = new BridgeHub();
  const bridgeServer = new BridgeServer(bridgeHub);
  ctx.effect(() => () => { void bridgeServer.close(); });
  const biliTasks = new BiliTaskRegistry();
  const biliCreateLock = new AttemptLock();
  const biliTransport = new BiliTransportState(ctx.settings);

  const authLog = ctx.logger('media.bilibili_auth');
  const authWarn = (message: string): void => { authLog.warn(message); };
  const authInfo = (message: string): void => { authLog.info(message); };
  ctx.commands.register('media_bilibili_auth_status', () =>
    accountStatus(secrets().openStore(ctx.app.dataDir), authClient(), authWarn, authInfo));
  ctx.commands.register('media_bilibili_logout', async () => {
    await logout(secrets().openStore(ctx.app.dataDir), authClient(), authWarn);
    return null;
  });
  ctx.commands.register<Commands['media_bilibili_cancel']['args'], null>(
    'media_bilibili_cancel',
    ({ taskId }) => { biliTasks.cancel(taskId); return null; });
  const biliLog = ctx.logger('media.bilibili');
  const biliStreamLog = ctx.logger('media.bilibili_stream');
  const importLog = ctx.logger('media.commands');
  const biliDeps = async (): Promise<BiliAttemptDeps> => {
    const session = await loadSession(secrets().openStore(ctx.app.dataDir));
    return {
      state: biliTransport,
      hub: bridgeHub,
      nativeCookie: session?.cookie ?? null,
    };
  };
  /** `bilibili.rs::task_client`：非媒体出口 + 60s 任务截止 + 取消登记。 */
  const taskClient = async (taskId: string | null | undefined) => {
    const attempt = await BiliAttempt.begin(await biliDeps(), false);
    const done = attempt.task(taskId ?? null, biliTasks);
    return { attempt, done };
  };
  // Rust `register_asynchronous_uri_scheme_protocol("bilistream", ...)`:
  // reuses the same playback attempt/cache as media_bilibili_stream_quality.
  ctx.protocols.register('bilistream', createBiliStreamProtocolHandler({
    session: async key => {
      const attempt = await playbackSession(key, await biliDeps());
      return {
        execute: async request => {
          const response = await attempt.execute({
            kind: request.kind ?? 'media',
            url: new URL(request.url),
            method: request.method,
            headers: request.headers,
            body: request.body,
            maxBytes: request.maxBytes,
            deadlineMs: request.deadlineMs,
          });
          return {
            status: response.status,
            header: name => response.header(name),
            body: response.body,
          };
        },
      };
    },
    playInfo: async (fileId, qn, epoch, attempt, fresh) => {
      const database = vfsDatabase();
      return await playInfoFor(
        await biliDeps(), database, linkItemRepos(vfsRepo()),
        fileId, qn, epoch, attempt, fresh);
    },
    remember: (key, info) => { rememberSource(key, info); },
    emitError: payload => {
      ctx.backendEvents.emit('media_bilibili_playback_error', payload);
    },
  }));
  /** Rust `transient`：只有超时 / 网络 / 桥离线允许自动换出口重试。 */
  const transientBili = (code: string): boolean =>
    code === 'bilibili-timeout' || code === 'bilibili-network'
    || code === 'bilibili-bridge-offline';
  const lookupWithFallback = async (
    attempt: BiliAttempt,
    input: string,
    page: number | null | undefined,
  ): Promise<{ attempt: BiliAttempt; lookup: BiliLookup }> => {
    const client = new BiliLookupClient(BILIBILI_API_BASE, { attempt });
    let first: { ok: true; lookup: BiliLookup } | { ok: false; error: unknown };
    try {
      const lookup = await client.lookup(input, page ?? null);
      if (lookup.subtitleError === null
        || !transientBili(lookup.subtitleError.code)) {
        return { attempt, lookup };
      }
      first = { ok: true, lookup };
    } catch (error) {
      const code = error instanceof MediaError ? error.code : '';
      if (!transientBili(code)) throw error;
      first = { ok: false, error };
    }
    let next: BiliAttempt | null = null;
    try { next = await attempt.fallback(); }
    catch { next = null; }
    if (next !== null) {
      const nextClient = new BiliLookupClient(BILIBILI_API_BASE, { attempt: next });
      return { attempt: next, lookup: await nextClient.lookup(input, page ?? null) };
    }
    if (first.ok) return { attempt, lookup: first.lookup };
    throw first.error;
  };
  const emitBiliCreated = (
    attachment: VfsAttachment,
    source: { window: string },
  ): void => {
    const node = attachmentToDstuNode(attachment);
    const event = createdEvent(node.path, node);
    try {
      ctx.backendEvents.emitTo({ kind: 'Window', label: source.window },
        `dstu:change:${node.path}`, event);
    } catch (error) {
      biliLog.warn(`[media::bilibili] emit dstu:change:${node.path} failed: ${
        error instanceof Error ? error.message : String(error)}`);
    }
    try {
      ctx.backendEvents.emitTo({ kind: 'Window', label: source.window }, 'dstu:change', event);
    } catch (error) {
      biliLog.warn(`[media::bilibili] emit dstu:change failed: ${
        error instanceof Error ? error.message : String(error)}`);
    }
  };
  ctx.commands.register<Commands['media_bilibili_probe']['args'],
    Commands['media_bilibili_probe']['result']>('media_bilibili_probe',
    async ({ input, page, taskId }) => {
      let done: (() => void) | null = null;
      try {
        const started = await taskClient(taskId);
        done = started.done;
        const found = await lookupWithFallback(started.attempt, input, page);
        const database = vfsDatabase();
        const existingId = findLinkItem(database, linkItemRepos(vfsRepo()),
          found.lookup.video.bvid, found.lookup.page.page);
        const defaultTrack = pickTrack(found.lookup.tracks, null);
        const cover = await new BiliLookupClient(BILIBILI_API_BASE, {
          attempt: found.attempt,
        }).coverDataUrl(found.lookup.video.cover);
        return {
          bvid: found.lookup.video.bvid,
          title: found.lookup.video.title,
          owner: found.lookup.video.owner,
          cover,
          durationMs: found.lookup.video.durationMs,
          pages: found.lookup.video.pages,
          page: found.lookup.page.page,
          tracks: found.lookup.tracks.map(({ lan, lanDoc, ai }) => ({
            lan, lanDoc, ai,
          })),
          defaultLan: defaultTrack?.lan ?? null,
          url: pageUrl(found.lookup.video.bvid, found.lookup.page.page),
          existingId,
          subtitleState: found.lookup.subtitleState,
          subtitleError: found.lookup.subtitleError?.message ?? null,
          route: found.attempt.route,
        };
      } catch (error) { return mediaFailure(error); }
      finally { done?.(); }
    });
  ctx.commands.register<Commands['media_bilibili_create']['args'],
    Commands['media_bilibili_create']['result']>('media_bilibili_create',
    async ({ input, page, lan, taskId }, call) => {
      let done: (() => void) | null = null;
      let release: (() => void) | null = null;
      try {
        const started = await taskClient(taskId);
        done = started.done;
        release = await started.attempt.waitCreate(biliCreateLock);
        const found = await lookupWithFallback(started.attempt, input, page);
        const database = vfsDatabase();
        const repos = vfsRepo();
        const links = linkItemRepos(repos);
        const pdf = deps.pdfService();
        const existing = findLinkItem(database, links,
          found.lookup.video.bvid, found.lookup.page.page);
        if (existing !== null) {
          const info = loadMediaFile(database.getConnSafe(), existing);
          const view = deps.transcriptViewOf(database, repos, info, pdf);
          if (view.segments.length > 0) {
            return {
              fileId: info.fileId,
              name: info.fileName,
              created: false,
              segments: view.segments.length,
              lan: lan ?? '',
              lanDoc: '',
              ai: false,
            };
          }
        }
        const client = new BiliLookupClient(BILIBILI_API_BASE, {
          attempt: found.attempt,
        });
        const [track, bytes] = await client.subtitleBytes(found.lookup, lan ?? null);
        // 字幕先解析通过再建条目，不留下没有字幕的空条目。
        parseSubtitle('bilibili.json', bytes);
        await found.attempt.verifyIdentity();
        const { info, attachment } = upsertLinkItem(
          database, links, descriptorFromLookup(found.lookup), bytes);
        deps.scheduleMediaIndex(deps.vfsIndex(), info);
        await deps.startMediaPipeline(pdf, info, false);
        const view = deps.transcriptViewOf(database, repos, info, pdf);
        if (attachment !== null) emitBiliCreated(attachment, call.source);
        biliLog.info('[media::bilibili] %s link item %s (%s p%d, %d cues, %s)',
          attachment !== null ? 'created' : 'updated', info.fileId,
          found.lookup.video.bvid, found.lookup.page.page,
          view.segments.length, track.lan);
        return {
          fileId: info.fileId,
          name: info.fileName,
          created: attachment !== null,
          segments: view.segments.length,
          lan: track.lan,
          lanDoc: track.lanDoc,
          ai: track.ai,
        };
      } catch (error) { return mediaFailure(error); }
      finally { release?.(); done?.(); }
    });
  ctx.commands.register<Commands['media_bilibili_import_subtitle']['args'],
    Commands['media_bilibili_import_subtitle']['result']>('media_bilibili_import_subtitle',
    async ({ resourceId, input, page, lan, taskId }) => {
      let done: (() => void) | null = null;
      try {
        const database = vfsDatabase();
        const repos = vfsRepo();
        const info = loadMediaFile(database.getConnSafe(), resourceId);
        const started = await taskClient(taskId);
        done = started.done;
        const found = await lookupWithFallback(started.attempt, input, page);
        if (isLinkItem(info)) {
          const own = readLinkDescriptor(
            database.getConnSafe(), repos.files, database.blobsDir(), info);
          if (own.bvid !== found.lookup.video.bvid
            || own.page !== found.lookup.page.page) {
            throw new MediaError('Bilibili',
              '链接条目只能重新获取它自己的字幕；要导入别的视频，请用「B 站链接」新建条目',
              'bilibili-invalid-link');
          }
        }
        const client = new BiliLookupClient(BILIBILI_API_BASE, {
          attempt: found.attempt,
        });
        const [, bytes] = await client.subtitleBytes(found.lookup, lan ?? null);
        const pdf = deps.pdfService();
        if (pdf?.isRunning(info.fileId) === true) cancelMedia(pdf, info.fileId);
        const count = importSubtitle(database.getConnSafe(), repos.mediaTranscripts,
          repos.files, info, 'bilibili.json', bytes);
        deps.scheduleMediaIndex(deps.vfsIndex(), info);
        importLog.info('[media::commands] imported %d subtitle cues for %s',
          count, info.fileId);
        await deps.startMediaPipeline(pdf, info, true);
        return deps.transcriptViewOf(database, repos, info, pdf);
      } catch (error) { return mediaFailure(error); }
      finally { done?.(); }
    });
  ctx.commands.register<Commands['media_bilibili_stream_quality']['args'],
    Commands['media_bilibili_stream_quality']['result']>('media_bilibili_stream_quality',
    async ({ fileId, qn, epoch, attempt }) => {
      const streamId = parseStreamPath(fileId);
      if (streamId === null) throw new CommandError('无效的 B 站链接条目');
      const requested = normalizeQn(qn);
      const attemptIndex = attempt ?? 0;
      const accountEpoch = epoch ?? 0;
      try {
        const database = vfsDatabase();
        const info: PlayInfo = await playInfoFor(
          await biliDeps(), database, linkItemRepos(vfsRepo()), streamId,
          requested, accountEpoch, attemptIndex, false);
        return {
          requested,
          current: info.quality,
          options: info.options,
          streamUrl: biliStreamUrl(
            ctx.app.platform, streamId, requested, accountEpoch, attemptIndex),
        };
      } catch (error) {
        const code = error instanceof MediaError
          ? error.code
          : error instanceof BiliRequestError ? error.payload.code : '';
        biliStreamLog.warn(
          '[media::bilibili_stream] quality file=%s qn=%d attempt=%d code=%s',
          streamId, requested, attemptIndex, code);
        throw new CommandError(error instanceof Error ? error.message : String(error));
      }
    });
  ctx.commands.register<Commands['media_bilibili_link_get']['args'],
    Commands['media_bilibili_link_get']['result']>('media_bilibili_link_get',
    ({ resourceId }) => {
      try {
        const database = vfsDatabase();
        const conn = database.getConnSafe();
        const info = loadMediaFile(conn, resourceId);
        if (!isLinkItem(info)) {
          throw new MediaError('InvalidInput', `不是 B 站链接条目: ${info.fileName}`);
        }
        return readLinkDescriptor(conn, vfsRepo().files, database.blobsDir(), info);
      } catch (error) { return mediaFailure(error); }
    });
  ctx.commands.register<Commands['media_bilibili_login_qr_start']['args'],
    Commands['media_bilibili_login_qr_start']['result']>('media_bilibili_login_qr_start',
    async () => {
      try { return await startLoginQr(authClient()); }
      catch (error) {
        throw new CommandError(error instanceof Error ? error.message : String(error));
      }
    });
  ctx.commands.register<Commands['media_bilibili_login_qr_poll']['args'],
    Commands['media_bilibili_login_qr_poll']['result']>('media_bilibili_login_qr_poll',
    async ({ qrcodeKey }) => {
      try {
        return await loginQrPoll(
          secrets().openStore(ctx.app.dataDir), authClient(), qrcodeKey, Date.now());
      } catch (error) {
        throw new CommandError(error instanceof Error ? error.message : String(error));
      }
    });
  ctx.commands.register('media_bilibili_transport_status', () =>
    transportStatus(biliTransport, bridgeHub));
  ctx.commands.register<Commands['media_bilibili_transport_configure']['args'], null>(
    'media_bilibili_transport_configure',
    ({ config }) => {
      try {
        biliTransport.configure(decodeTransportSettings(config));
        return null;
      } catch (error) {
        if (error instanceof BiliRequestError) throw new CommandError(JSON.stringify(error.payload));
        throw error;
      }
    });
  ctx.commands.register<Commands['media_bilibili_bridge_pair']['args'],
    Commands['media_bilibili_bridge_pair']['result']>('media_bilibili_bridge_pair', async () => {
    try {
      const port = await bridgeServer.start();
      const challenge = bridgeHub.startPairing(port);
      return {
        url: `http://127.0.0.1:${port}${BRIDGE_BASE}#${challenge}`,
        scriptUrl: `http://127.0.0.1:${port}${BRIDGE_BASE}deepstudent-bili-bridge.user.js`,
      };
    } catch (error) {
      if (error instanceof BiliRequestError) throw new CommandError(JSON.stringify(error.payload));
      throw error;
    }
  });
  ctx.commands.register<Commands['media_bilibili_bridge_approve']['args'], null>(
    'media_bilibili_bridge_approve',
    ({ connectionId }) => {
      try {
        bridgeHub.approve(connectionId);
        return null;
      } catch (error) {
        if (error instanceof BiliRequestError) throw new CommandError(JSON.stringify(error.payload));
        throw error;
      }
    });
  // Rust 在 Android 上还会调用 lifecycle setActive(false)；宿主桌面端没有前台服务。
  ctx.commands.register('media_bilibili_bridge_disconnect', () => {
    bridgeHub.revoke();
    return null;
  });
}
