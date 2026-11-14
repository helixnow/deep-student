import { Service, type Context } from '@deepseek-ai/cordis';
import { definePlugin } from '../../../kernel/api.ts';
import type { HostPlugin, PluginPlatform } from '../../../kernel/core.ts';
import type { NativeOfficeText } from '../../../platform/native/api.ts';
import type { NativePdfium } from '../../../platform/native/pdfium/api.ts';
import type { NotesService } from '../../notes/api.ts';
import type { QbankService } from '../../qbank/api.ts';
import {
  vfsMaintenanceService, vfsRepoService, vfsWorkerService,
  type AttachmentProcessingAdapter, type VfsReposService,
} from '../api.ts';
import { idAliasRepository } from '../repository/id-alias.ts';
import { PathCacheRepo } from '../repository/path-cache.ts';
import { QuestionRepo } from '../repository/questions.ts';
import { TodoRepo } from '../repository/todos.ts';
import { FolderRepo } from '../repository/folders.ts';
import { BlobRepo } from '../repository/blobs.ts';
import { FileRepo } from '../repository/files.ts';
import { ResourceRepo } from '../repository/resources.ts';
import { EmbeddingDimRepo } from '../repository/embedding-dims.ts';
import { IndexSegmentRepo } from '../repository/index-segments.ts';
import { IndexUnitRepo } from '../repository/index-units.ts';
import { EmbeddingDimensionRepo, IndexStateRepo, IndexingConfigRepo } from '../repository/embedding-repo.ts';
import { MediaTranscriptRepo } from '../repository/media-transcripts.ts';
import { PomodoroRepo } from '../repository/pomodoros.ts';
import { TextbookRepo } from '../repository/textbooks.ts';
import { TranslationRepo } from '../repository/translations.ts';
import { ReviewPlanRepo } from '../repository/review-plans.ts';
import { EssayRepo } from '../repository/essays.ts';
import { ExamRepo } from '../repository/exams.ts';
import { AttachmentRepo } from '../repository/attachments.ts';
import { MindmapRepo } from '../repository/mindmaps.ts';
import { StudySpaceRepo } from '../repository/study-spaces.ts';
import { MaintenanceRepo } from '../repository/maintenance.ts';
import { NoteOwnerWritesRepo } from '../repository/note-owner-writes.ts';
import { setRepositoryLogger } from '../repository/logger.ts';
import type { PdfImageEncoder } from '../repository/pdf-preview.ts';
import { setVfsReposLocalRuntime, type VfsReposLocalRuntime } from './local-runtime.ts';
import { NativeAttachmentProcessing, type AttachmentDocs } from './attachment-processing.ts';
import { VfsMaintenance } from './maintenance-service.ts';
import { VfsWorker } from './worker-service.ts';

export interface VfsReposPluginOptions {
  /** 运行平台（profile 生成与入口校验用；桌面 `['desktop']`、移动 `['mobile']`）。 */
  readonly platforms?: readonly PluginPlatform[];
  /** 入口注入的同步本地运行时（`node:fs` / `node:worker_threads`）；不注入则按不可用降级。 */
  readonly localRuntime?: (ctx: Context) => VfsReposLocalRuntime;
}

/**
 * `Worker.terminate()` cannot interrupt a native synchronous call (a long SQLite statement), so
 * unload stops waiting after this long. Host shutdown disposes plugins one at a time in reverse
 * install order and already stops waiting on each after PLUGIN_DISPOSE_TIMEOUT_MS (1.5 s); this
 * bound ends a plain unload or reload.
 */
const WORKER_DISPOSE_MS = 2_000;

async function disposeWorkerBounded(worker: VfsWorker, logger: ReturnType<Context['logger']>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<true>(resolve => { timer = setTimeout(() => resolve(true), WORKER_DISPOSE_MS); });
  try {
    const expired = await Promise.race([worker.dispose().then(() => false as const), timedOut]);
    if (expired) logger.warn(`vfs worker did not terminate within ${WORKER_DISPOSE_MS}ms; continuing unload`);
  } finally {
    clearTimeout(timer);
  }
}

/** F4 候选 d85995b4b `ctx.paths.dataSpaceDeviceId()`：Rust data_space 底层身份入口。 */
interface DataSpaceDeviceIdentity {
  dataSpaceDeviceId(): Promise<string>;
}

class VfsRepos extends Service implements VfsReposService {
  readonly noteOwnerWrites = new NoteOwnerWritesRepo();
  readonly idAlias = idAliasRepository;
  readonly pathCache = new PathCacheRepo();
  readonly questions = new QuestionRepo();
  readonly todos = new TodoRepo();
  readonly blobs = new BlobRepo();
  readonly files = new FileRepo();
  readonly resources = new ResourceRepo();
  readonly embeddingDims = new EmbeddingDimRepo();
  readonly embeddingSegments = new IndexSegmentRepo();
  readonly embeddingUnits = new IndexUnitRepo();
  readonly embeddingDimensions = new EmbeddingDimensionRepo();
  readonly indexStates = new IndexStateRepo();
  readonly indexingConfig = new IndexingConfigRepo();
  readonly mediaTranscripts = new MediaTranscriptRepo();
  readonly pomodoros = new PomodoroRepo();
  readonly textbooks = new TextbookRepo();
  readonly translations: TranslationRepo;
  readonly reviewPlans = new ReviewPlanRepo();
  readonly essays = new EssayRepo();
  // qbank itself consumes vfsRepo; resolving only at operation time avoids a static inject cycle.
  readonly exams = new ExamRepo(() => (this.ctx.get('qbank') as QbankService | undefined)?.examCascade);
  readonly attachments: AttachmentRepo;
  readonly mindmaps = new MindmapRepo();
  readonly studySpaces = new StudySpaceRepo();
  readonly folders = new FolderRepo({
    adapters: {
      note: {
        softDelete: (conn, itemId) => { this.notes().repository.deleteNote(itemId, conn); },
        restore: (conn, itemId) => { this.notes().repository.restoreNote(itemId, conn); },
        purge: (conn, itemId) => { this.notes().repository.purgeNote(itemId, conn); },
      },
      file: {
        softDelete: (conn, itemId) => { this.files.deleteFile(conn, itemId); },
        restore: (conn, itemId) => { this.files.restoreFile(conn, itemId); },
        purge: (conn, itemId, blobsDir) => { this.files.purgeFileWithConn(conn, itemId, blobsDir); },
      },
      image: {
        softDelete: (conn, itemId) => { this.files.deleteFile(conn, itemId); },
        restore: (conn, itemId) => { this.files.restoreFile(conn, itemId); },
        purge: (conn, itemId, blobsDir) => { this.files.purgeFileWithConn(conn, itemId, blobsDir); },
      },
      exam: {
        softDelete: (conn, itemId) => { this.exams.deleteExamSheet(conn, itemId); },
        restore: (conn, itemId) => { this.exams.restoreExam(conn, itemId); },
        purge: (conn, itemId) => { this.exams.purgeExamSheetWithConn(conn, itemId); },
      },
      translation: {
        softDelete: (conn, itemId) => { this.translations.deleteTranslation(conn, itemId); },
        restore: (conn, itemId) => { this.translations.restoreTranslation(conn, itemId); },
        purge: (conn, itemId) => { this.translations.purgeTranslation(conn, itemId); },
      },
      essay: {
        softDelete: (conn, itemId) => { this.essays.deleteEssay(conn, itemId); },
        restore: (conn, itemId) => { this.essays.restoreEssay(conn, itemId); },
        purge: (conn, itemId) => { this.essays.purgeEssayWithConn(conn, itemId); },
      },
      essay_session: {
        softDelete: (conn, itemId) => { this.essays.deleteSession(conn, itemId); },
        restore: (conn, itemId) => { this.essays.restoreSession(conn, itemId); },
        purge: (conn, itemId) => { this.essays.purgeSessionWithConn(conn, itemId); },
      },
      mindmap: {
        softDelete: (conn, itemId) => { this.mindmaps.deleteMindmapWithConn(conn, itemId); },
        restore: (conn, itemId) => { this.mindmaps.restoreMindmapWithConn(conn, itemId); },
        purge: (conn, itemId) => { this.mindmaps.purgeMindmapWithConn(conn, itemId); },
      },
    },
    cleanupUnreferencedBlobs: (conn, blobsDir) => {
      if (blobsDir !== undefined) this.blobs.cleanupUnreferenced(conn, blobsDir);
    },
  });
  readonly maintenance = new MaintenanceRepo({
    folders: this.folders,
    todos: this.todos,
    blobs: this.blobs,
  });
  /**
   * notes 是按需依赖：仅文件夹级联的笔记软删除/恢复/清除用到。notes 自身注入 vfsRepo，
   * 若这里在 inject 中声明 notes 会形成循环注入，两个插件都无法启动；因此调用时再取。
   */
  private notes(): NotesService {
    const notes = this.ctx.get('notes') as NotesService | undefined;
    if (notes === undefined) throw new Error('notes service is not available: folder cascade on notes requires the notes plugin');
    return notes;
  }
  readonly attachmentProcessing: AttachmentProcessingAdapter;
  constructor(ctx: Context, deviceId: string, processing: AttachmentProcessingAdapter) {
    super(ctx, vfsRepoService.name);
    this.translations = new TranslationRepo(deviceId);
    this.attachmentProcessing = processing;
    this.attachments = new AttachmentRepo(processing);
  }
}

export function createVfsReposPlugin(options: VfsReposPluginOptions = {}): HostPlugin {
  return definePlugin({
  meta: {
    id: 'dstu.vfs-repos',
    lane: 'L11-vfs-repos',
    commands: [],
    provides: [vfsRepoService.name, vfsMaintenanceService.name, vfsWorkerService.name],
    ...(options.platforms === undefined ? {} : { platforms: options.platforms }),
  },
  inject: ['storage', 'paths'],
  async apply(ctx) {
    setVfsReposLocalRuntime(options.localRuntime?.(ctx) ?? null);
    ctx.effect(() => () => setVfsReposLocalRuntime(null));
    setRepositoryLogger(ctx.logger('dstu_vfs::repos'));
    // R11-01: Rust translation_repo.rs:65-70 uses data_space::device_id
    // (env -> primary -> legacy). F4 publishes that exact entry as
    // `dataSpaceDeviceId()`. main does not have it yet, so this branch is
    // pending F4 integration; do not fall back to the legacy-root-first
    // `deviceId()` wrapper (different identity when old root and env coexist),
    // and do not copy F4's resolver/normalization/cache here.
    const paths = ctx.paths as typeof ctx.paths & DataSpaceDeviceIdentity;
    const deviceId = await paths.dataSpaceDeviceId();
    // F7/L18 providers are resolved per upload so late installs are picked up.
    let repos: VfsRepos;
    const processing = new NativeAttachmentProcessing({
      pdfium: () => (ctx.get('nativePdfium') as NativePdfium | undefined) ?? null,
      image: () => (ctx.get('nativeImage') as PdfImageEncoder | undefined) ?? null,
      docs: () => (ctx.get('docs') as AttachmentDocs | undefined) ?? null,
      officeText: () => (ctx.get('nativeOfficeText') as NativeOfficeText | undefined) ?? null,
      blobs: () => repos.blobs,
    });
    repos = new VfsRepos(ctx, deviceId, processing);
    new VfsMaintenance(ctx, repos);
    // R13-02: owner execution service; the worker opens its own F3 handle lazily.
    const worker = new VfsWorker(ctx, deviceId, ctx.storage.pathOf('vfs'));
    // R11-05: F3 `registerMaintenanceParticipant` (main 9900d8dda) closes worker-thread connections.
    const unregisterMaintenance = ctx.storage.registerMaintenanceParticipant('vfs-worker', {
      databases: ['vfs'],
      enterMaintenance: async () => {
        try {
          // F3 先拒绝主线程借用，再调用参与者；关卡内不得再启动新的 worker 操作。
          await worker.pauseAndDrain();
        } catch (error) {
          // F3 不会为失败的参与者调用 exit；排空失败（含超时强制终止）后自行解除暂停，
          // 否则 storage 已回滚而 worker 永久停在 maintenance。
          worker.resume();
          throw error;
        }
      },
      exitMaintenance: () => { worker.resume(); },
    });
    ctx.effect(() => async () => {
      unregisterMaintenance();
      await disposeWorkerBounded(worker, ctx.logger('dstu_vfs::repos'));
    });
  },
  });
}
