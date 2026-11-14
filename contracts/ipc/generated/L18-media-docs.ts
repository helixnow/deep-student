// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L18-media-docs.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** deep_student_lib::cmd::ocr::AvailableOcrModelResponse */
export type AvailableOcrModelResponse = {
  configId: string;
  model: string;
  engineType: string;
  name: string;
  isFree: boolean;
  description: string | null;
  supportsGrounding: boolean;
  enabled: boolean;
  priority: number;
};
/** dstu_media::media::bilibili_auth::BiliAccountStatus */
export type BiliAccountStatus = {
  loggedIn: boolean;
  mid: number | null;
  uname: string | null;
  face: string | null;
  vip: boolean;
  verified: boolean;
  expired: boolean;
};
/** dstu_media::media::bilibili::BiliCreateResult */
export type BiliCreateResult = {
  fileId: string;
  name: string;
  created: boolean;
  segments: number;
  lan: string;
  lanDoc: string;
  ai: boolean;
};
/** dstu_media::media::bilibili_transport::types::BiliError */
export type BiliError = {
  code: string;
  message: string;
  stage: string;
  requestId: number;
  attemptId: string;
  route: Route;
  retryable: boolean;
  httpStatus: number | null;
  businessCode: number | null;
};
/** dstu_media::media::bilibili::BiliLinkDescriptor */
export type BiliLinkDescriptor = {
  kind: string;
  version: number;
  bvid: string;
  aid: number;
  cid: number;
  page: number;
  pageCount: number;
  title: string;
  part: string;
  owner: string | null;
  cover: string | null;
  durationMs: number;
  url: string;
};
/** dstu_media::media::bilibili_auth::BiliLoginPoll */
export type BiliLoginPoll = {
  state: string;
  status: BiliAccountStatus | null;
};
/** dstu_media::media::bilibili_auth::BiliLoginQr */
export type BiliLoginQr = {
  qrcodeKey: string;
  qrPng: string;
  expiresInSecs: number;
};
/** dstu_media::media::bilibili::BiliPage */
export type BiliPage = {
  page: number;
  cid: number;
  part: string;
  durationMs: number;
};
/** dstu_media::media::bilibili::BiliProbeView */
export type BiliProbeView = {
  bvid: string;
  title: string;
  owner: string | null;
  cover: string | null;
  durationMs: number;
  pages: BiliPage[];
  page: number;
  tracks: BiliSubtitleTrack[];
  defaultLan: string | null;
  url: string;
  existingId: string | null;
  subtitleState: string;
  subtitleError: string | null;
  route: Route;
};
/** dstu_media::media::bilibili::BiliSubtitleTrack */
export type BiliSubtitleTrack = {
  lan: string;
  lanDoc: string;
  ai: boolean;
};
/** dstu_media::media::bilibili_transport::bridge::BridgeAccount */
export type BridgeAccount = {
  loggedIn: boolean;
  mid: number | null;
  uname: string | null;
};
/** dstu_media::media::bilibili_transport::bridge::BridgeStatus */
export type BridgeStatus = {
  state: string;
  connectionId: string | null;
  scriptVersion: string | null;
  parsing: boolean;
  media: boolean;
  account: BridgeAccount | null;
  generation: number;
  lastError: BiliError | null;
};
/** dstu_media::cmd::media::CompressImageResult */
export type CompressImageResult = {
  bytesBase64: string | null;
  filePath: string | null;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  originalSize: number;
  compressedSize: number;
  format: string;
};
/** dstu_media::media::ledger::MediaChapter */
export type MediaChapter = {
  title: string;
  seconds: number;
};
/** dstu_media::media::ledger::MediaCheckpoint */
export type MediaCheckpoint = {
  questionId: string;
  examId: string;
  seconds: number;
  content: string;
  questionType: string;
  optionsJson: string | null;
  answer: string | null;
  explanation: string | null;
  attemptCount: number;
  isCorrect: boolean | null;
};
/** dstu_media::media::library::MediaLibraryItem */
export type MediaLibraryItem = {
  id: string;
  resourceId: string | null;
  name: string;
  folderId: string | null;
  folderName: string | null;
  folderPath: string[];
  size: number;
  mimeType: string;
  kind: string;
  isLink: boolean;
  coverUrl: string | null;
  createdAt: number;
  updatedAt: number;
  durationMs: number | null;
  transcript: MediaLibraryTranscript;
  progress: MediaLibraryProgress;
  lastWatchedAt: number | null;
  handoutCount: number;
  lastActivityAt: number;
};
/** dstu_media::media::library::MediaLibraryProgress */
export type MediaLibraryProgress = {
  lastPositionMs: number;
  watchedMs: number;
  finished: boolean;
};
/** dstu_media::media::library::MediaLibraryTranscript */
export type MediaLibraryTranscript = {
  status: string;
  completedSegments: number;
  totalSegments: number;
  failedSegments: number;
  source: string | null;
};
/** dstu_vfs::vfs::repos::media_transcript_repo::MediaProgressRow */
export type MediaProgressRow = {
  resourceId: string;
  lastPositionMs: number;
  durationMs: number | null;
  watchedMs: number;
  finished: boolean;
  updatedAt: number;
};
/** dstu_media::media::library::MediaRelatedNote */
export type MediaRelatedNote = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};
/** dstu_media::media::ledger::MediaStudyLedger */
export type MediaStudyLedger = {
  resourceId: string;
  cardCount: number;
  cardsDue: number;
  cardsNew: number;
  cardIds: string[];
  questionCount: number;
  questionsAttempted: number;
  attemptTotal: number;
  correctTotal: number;
  questionsWrong: number;
  examIds: string[];
};
/** deep_student_lib::cmd::ocr::OcrEngineInfoResponse */
export type OcrEngineInfoResponse = {
  engineType: string;
  name: string;
  description: string;
  recommendedModel: string;
  supportsGrounding: boolean;
  isFree: boolean;
};
/** deep_student_lib::cmd::ocr::OcrTestRegion */
export type OcrTestRegion = {
  text: string;
  bbox: number[] | null;
  label: string | null;
};
/** deep_student_lib::cmd::ocr::OcrTestRequest */
export type OcrTestRequest = {
  imageBase64: string;
  engineType: string;
  configId?: string | null;
};
/** deep_student_lib::cmd::ocr::OcrTestResponse */
export type OcrTestResponse = {
  engineType: string;
  engineName: string;
  text: string;
  regions: OcrTestRegion[];
  elapsedMs: number;
  success: boolean;
  error: string | null;
};
/** dstu_media::media::bilibili_transport::bridge_server::PairingView */
export type PairingView = {
  url: string;
  scriptUrl: string;
};
/** dstu_core::models::PdfOcrPageInput */
export type PdfOcrPageInput = {
  page_index: number;
  image_base64: string;
  width?: number | null;
  height?: number | null;
};
/** dstu_core::models::PdfOcrPageResult */
export type PdfOcrPageResult = {
  page_index: number;
  width: number;
  height: number;
  image_path?: string | null;
  blocks: PdfOcrTextBlock[];
};
/** dstu_core::models::PdfOcrRequest */
export type PdfOcrRequest = {
  pdf_base64: string;
  pdf_name?: string | null;
  pages: PdfOcrPageInput[];
};
/** dstu_core::models::PdfOcrResult */
export type PdfOcrResult = {
  temp_id: string;
  source_pdf_path: string;
  pdfstream_url: string;
  page_results: PdfOcrPageResult[];
};
/** dstu_core::models::PdfOcrTextBlock */
export type PdfOcrTextBlock = {
  text: string;
  bbox: Shared.ExamCardBBox;
};
/** dstu_media::media::bilibili_stream::QualityOption */
export type QualityOption = {
  qn: number;
  label: string;
};
/** dstu_media::media::bilibili_transport::session::RequestDiagnostic */
export type RequestDiagnostic = {
  requestId: number;
  attemptId: string;
  route: Route;
  stage: RequestKind;
  host: string;
  elapsedMs: number;
  status: number | null;
  errorCode: string | null;
  bytes: number;
};
/** dstu_media::media::bilibili_transport::types::RequestKind */
export type RequestKind = "short_link" | "api" | "subtitle" | "media" | "passport" | "cover";
/** dstu_media::media::bilibili_transport::types::Route */
export type Route = "native" | "browser_bridge" | "proxy";
/** dstu_media::media::bilibili_transport::types::RouteMode */
export type RouteMode = "auto" | "native" | "browser_bridge" | "proxy";
/** dstu_media::media::bilibili_transport::types::RouteMode */
export type RouteMode__De = ("auto" | "native" | "browser_bridge" | "proxy") | {
  auto: null;
} | {
  native: null;
} | {
  browser_bridge: null;
} | {
  proxy: null;
};
/** deep_student_lib::cmd::ocr::SaveOcrModelRequest */
export type SaveOcrModelRequest = {
  configId: string;
  model: string;
  engineType: string;
  name: string;
  isFree?: boolean;
  enabled?: boolean | null;
  priority?: number | null;
};
/** dstu_media::media::bilibili_stream::StreamQualityView */
export type StreamQualityView = {
  requested: number;
  current: number;
  options: QualityOption[];
  streamUrl?: string | null;
};
/** dstu_vfs::textbooks_db::Textbook */
export type Textbook = {
  id: string;
  sha256: string;
  file_name: string;
  file_path: string;
  size: number;
  page_count: number | null;
  tags_json: string;
  favorite: number;
  last_opened_at: string | null;
  last_page: number | null;
  bookmarks_json: string;
  cover_key: string | null;
  origin_json: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};
/** deep_student_lib::cmd::textbooks::TextbookImportProgress */
export type TextbookImportProgress = {
  file_name: string;
  stage: string;
  current_page: number | null;
  total_pages: number | null;
  progress: number;
  error: string | null;
};
/** dstu_media::media::commands::TranscribeEstimate */
export type TranscribeEstimate = {
  durationMs: number | null;
  plannedSegments: number | null;
  asrModel: string;
  asrConfigured: boolean;
  exact: boolean;
};
/** dstu_media::media::commands::TranscriptExportResult */
export type TranscriptExportResult = {
  path: string;
  format: string;
  segments: number;
  bytes: number;
};
/** dstu_media::media::commands::TranscriptProgressView */
export type TranscriptProgressView = {
  stage: string | null;
  percent: number;
  completedSegments: number;
  totalSegments: number;
  failedSegments: number;
  durationMs: number | null;
  source: string | null;
  planVersion: number | null;
  error: string | null;
};
/** dstu_media::media::commands::TranscriptSegmentView */
export type TranscriptSegmentView = {
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
  status: number;
};
/** dstu_media::media::commands::TranscriptStatusView */
export type TranscriptStatusView = {
  resourceId: string;
  mediaType: string;
  status: string;
  progress: TranscriptProgressView;
};
/** dstu_media::media::commands::TranscriptView */
export type TranscriptView = {
  resourceId: string;
  mediaType: string;
  status: string;
  segments: TranscriptSegmentView[];
  progress: TranscriptProgressView;
};
/** dstu_media::media::bilibili_transport::session::TransportSettings */
export type TransportSettings = {
  mode: RouteMode;
  proxyUrl: string | null;
  proxyInAuto: boolean;
};
/** dstu_media::media::bilibili_transport::session::TransportSettings */
export type TransportSettings__De = {
  mode: RouteMode__De;
  proxyUrl?: string | null;
  proxyInAuto: boolean;
};
/** dstu_media::media::bilibili_transport::bridge_server::TransportView */
export type TransportView = {
  settings: TransportSettings;
  bridge: BridgeStatus;
  diagnostics: RequestDiagnostic[];
};
/** deep_student_lib::cmd::ocr::UpdateOcrPriorityItem */
export type UpdateOcrPriorityItem = {
  configId: string;
  enabled: boolean;
};
/** deep_student_lib::cmd::ocr::ValidateOcrModelResponse */
export type ValidateOcrModelResponse = {
  isValid: boolean;
  recommendedModel: string | null;
};
/** dstu_media::voice_input::VoiceInputTranscribeRequest */
export type VoiceInputTranscribeRequest = {
  audioBase64: string;
  mimeType: string;
  providerId?: string | null;
  model?: string | null;
  configId?: string | null;
  language?: string | null;
  prompt?: string | null;
  durationMs?: number | null;
};
/** dstu_media::voice_input::VoiceInputTranscribeResponse */
export type VoiceInputTranscribeResponse = {
  text: string;
  language: string | null;
  durationMs: number | null;
  providerId: string;
  model: string;
};

export interface Commands {
  /** src/cmd/ocr.rs:447 `add_ocr_engine` */
  add_ocr_engine: {
    args: {
      configId: string;
      model: string;
      name: string;
      engineType?: string | null;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/commands.rs:787 `cancel_pdf_ocr_session` */
  cancel_pdf_ocr_session: {
    args: {
      sessionId: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** crates/dstu-media/src/cmd/media.rs:54 `compress_image` */
  compress_image: {
    args: {
      sourcePath?: string | null;
      bytesBase64?: string | null;
      maxEdge?: number | null;
      quality?: number | null;
      outputMode?: string | null;
    };
    result: CompressImageResult;
    error: string;
  };
  /** src/heic_decoder.rs:78 `convert_heic_to_jpeg` */
  convert_heic_to_jpeg: {
    args: Record<string, never>;
    result: unknown;
    error: Shared.AppError;
  };
  /** src/cmd/ocr.rs:154 `get_available_ocr_models` */
  get_available_ocr_models: {
    args: Record<string, never>;
    result: AvailableOcrModelResponse[];
    error: Shared.AppError;
  };
  /** src/commands.rs:8493 `get_image_as_base64` */
  get_image_as_base64: {
    args: {
      relativePath: string;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/ocr.rs:56 `get_ocr_engine_type` */
  get_ocr_engine_type: {
    args: Record<string, never>;
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/ocr.rs:38 `get_ocr_engines` */
  get_ocr_engines: {
    args: Record<string, never>;
    result: OcrEngineInfoResponse[];
    error: Shared.AppError;
  };
  /** src/cmd/ocr.rs:137 `get_ocr_prompt_template` */
  get_ocr_prompt_template: {
    args: {
      engineType: string;
      mode: string;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/ocr.rs:70 `get_ocr_thinking_enabled` */
  get_ocr_thinking_enabled: {
    args: Record<string, never>;
    result: boolean;
    error: Shared.AppError;
  };
  /** src/commands.rs:875 `get_pdf_ocr_temp_dir` */
  get_pdf_ocr_temp_dir: {
    args: Record<string, never>;
    result: string;
    error: Shared.AppError;
  };
  /** src/commands.rs:7062 `get_recent_document_tasks` */
  get_recent_document_tasks: {
    args: {
      limit?: number | null;
    };
    result: Shared.DocumentTask[];
    error: Shared.AppError;
  };
  /** src/cmd/handout.rs:129 `handout_cancel` */
  handout_cancel: {
    args: {
      requestId: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/cmd/handout.rs:74 `handout_llm_complete` */
  handout_llm_complete: {
    args: {
      prompt: string;
      jsonMode?: boolean | null;
      requestId?: string | null;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/handout.rs:135 `handout_release` */
  handout_release: {
    args: {
      requestId: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/cmd/handout.rs:96 `handout_vlm_caption` */
  handout_vlm_caption: {
    args: {
      prompt: string;
      imageBase64: string;
      mime?: string | null;
      requestId?: string | null;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/ocr.rs:106 `infer_ocr_engine_from_model` */
  infer_ocr_engine_from_model: {
    args: {
      model: string;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/commands.rs:727 `init_pdf_ocr_session` */
  init_pdf_ocr_session: {
    args: {
      pdfName?: string | null;
      pdfBase64: string;
      totalPages: number;
    };
    result: string;
    error: Shared.AppError;
  };
  /** crates/dstu-media/src/media/bilibili_auth.rs:461 `media_bilibili_auth_status` */
  media_bilibili_auth_status: {
    args: Record<string, never>;
    result: BiliAccountStatus;
    error: string;
  };
  /** crates/dstu-media/src/media/bilibili_transport/bridge_server.rs:523 `media_bilibili_bridge_approve` */
  media_bilibili_bridge_approve: {
    args: {
      connectionId: string;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-media/src/media/bilibili_transport/bridge_server.rs:529 `media_bilibili_bridge_disconnect` */
  media_bilibili_bridge_disconnect: {
    args: Record<string, never>;
    result: null;
    error: string;
  };
  /** crates/dstu-media/src/media/bilibili_transport/bridge_server.rs:509 `media_bilibili_bridge_pair` */
  media_bilibili_bridge_pair: {
    args: Record<string, never>;
    result: PairingView;
    error: string;
  };
  /** crates/dstu-media/src/media/bilibili_transport/session.rs:440 `media_bilibili_cancel` */
  media_bilibili_cancel: {
    args: {
      taskId: string;
    };
    result: null;
    error: never;
  };
  /** crates/dstu-media/src/media/bilibili.rs:1212 `media_bilibili_create` */
  media_bilibili_create: {
    args: {
      input: string;
      page?: number | null;
      lan?: string | null;
      taskId?: string | null;
    };
    result: BiliCreateResult;
    error: string;
  };
  /** crates/dstu-media/src/media/bilibili.rs:1311 `media_bilibili_import_subtitle` */
  media_bilibili_import_subtitle: {
    args: {
      resourceId: string;
      input: string;
      page?: number | null;
      lan?: string | null;
      taskId?: string | null;
    };
    result: TranscriptView;
    error: string;
  };
  /** crates/dstu-media/src/media/bilibili.rs:1353 `media_bilibili_link_get` */
  media_bilibili_link_get: {
    args: {
      resourceId: string;
    };
    result: BiliLinkDescriptor;
    error: string;
  };
  /** crates/dstu-media/src/media/bilibili_auth.rs:500 `media_bilibili_login_qr_poll` */
  media_bilibili_login_qr_poll: {
    args: {
      qrcodeKey: string;
    };
    result: BiliLoginPoll;
    error: string;
  };
  /** crates/dstu-media/src/media/bilibili_auth.rs:488 `media_bilibili_login_qr_start` */
  media_bilibili_login_qr_start: {
    args: Record<string, never>;
    result: BiliLoginQr;
    error: string;
  };
  /** crates/dstu-media/src/media/bilibili_auth.rs:529 `media_bilibili_logout` */
  media_bilibili_logout: {
    args: Record<string, never>;
    result: null;
    error: string;
  };
  /** crates/dstu-media/src/media/bilibili.rs:1172 `media_bilibili_probe` */
  media_bilibili_probe: {
    args: {
      input: string;
      page?: number | null;
      taskId?: string | null;
    };
    result: BiliProbeView;
    error: string;
  };
  /** crates/dstu-media/src/media/bilibili_stream.rs:512 `media_bilibili_stream_quality` */
  media_bilibili_stream_quality: {
    args: {
      fileId: string;
      qn?: number | null;
      epoch?: number | null;
      attempt?: number | null;
    };
    result: StreamQualityView;
    error: string;
  };
  /** crates/dstu-media/src/media/bilibili_transport/bridge_server.rs:494 `media_bilibili_transport_configure` */
  media_bilibili_transport_configure: {
    args: {
      config: TransportSettings__De;
    };
    result: null;
    error: string;
  };
  /** crates/dstu-media/src/media/bilibili_transport/bridge_server.rs:485 `media_bilibili_transport_status` */
  media_bilibili_transport_status: {
    args: Record<string, never>;
    result: TransportView;
    error: string;
  };
  /** src/media/ledger.rs:19 `media_chapters` */
  media_chapters: {
    args: {
      resourceId: string;
    };
    result: MediaChapter[];
    error: string;
  };
  /** src/media/ledger.rs:11 `media_checkpoints` */
  media_checkpoints: {
    args: {
      resourceId: string;
    };
    result: MediaCheckpoint[];
    error: string;
  };
  /** crates/dstu-media/src/media/library.rs:410 `media_library_list` */
  media_library_list: {
    args: {
      limit?: number | null;
    };
    result: MediaLibraryItem[];
    error: string;
  };
  /** crates/dstu-media/src/media/commands.rs:533 `media_progress_get` */
  media_progress_get: {
    args: {
      resourceId: string;
    };
    result: MediaProgressRow | null;
    error: string;
  };
  /** crates/dstu-media/src/media/commands.rs:544 `media_progress_set` */
  media_progress_set: {
    args: {
      resourceId: string;
      positionMs?: number | null;
      durationMs?: number | null;
      watchedDeltaMs?: number | null;
      finished?: boolean | null;
    };
    result: MediaProgressRow;
    error: string;
  };
  /** crates/dstu-media/src/media/library.rs:440 `media_related_notes` */
  media_related_notes: {
    args: {
      resourceId: string;
    };
    result: MediaRelatedNote[];
    error: string;
  };
  /** src/media/ledger.rs:27 `media_study_ledger` */
  media_study_ledger: {
    args: {
      resourceIds: string[];
      includeCardIds?: boolean | null;
    };
    result: MediaStudyLedger[];
    error: string;
  };
  /** crates/dstu-media/src/media/commands.rs:366 `media_transcribe_cancel` */
  media_transcribe_cancel: {
    args: {
      resourceId: string;
    };
    result: TranscriptStatusView;
    error: string;
  };
  /** src/media/commands.rs:19 `media_transcribe_estimate` */
  media_transcribe_estimate: {
    args: {
      resourceId: string;
    };
    result: TranscribeEstimate;
    error: string;
  };
  /** src/media/commands.rs:28 `media_transcribe_start` */
  media_transcribe_start: {
    args: {
      resourceId: string;
    };
    result: TranscriptStatusView;
    error: string;
  };
  /** crates/dstu-media/src/media/commands.rs:504 `media_transcript_export` */
  media_transcript_export: {
    args: {
      resourceId: string;
      format: string;
      dest: string;
    };
    result: TranscriptExportResult;
    error: string;
  };
  /** crates/dstu-media/src/media/commands.rs:382 `media_transcript_get` */
  media_transcript_get: {
    args: {
      resourceId: string;
    };
    result: TranscriptView;
    error: string;
  };
  /** crates/dstu-media/src/media/commands.rs:422 `media_transcript_import` */
  media_transcript_import: {
    args: {
      resourceId: string;
      path: string;
    };
    result: TranscriptView;
    error: string;
  };
  /** src/cmd/handout.rs:146 `notes_export_docx` */
  notes_export_docx: {
    args: {
      spec: unknown;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/commands.rs:4121 `parse_document_from_base64` */
  parse_document_from_base64: {
    args: {
      fileName: string;
      base64Content: string;
    };
    result: string;
    error: string;
  };
  /** src/commands.rs:4093 `parse_document_from_path` */
  parse_document_from_path: {
    args: {
      filePath: string;
    };
    result: string;
    error: string;
  };
  /** src/commands.rs:802 `pause_pdf_ocr_session` */
  pause_pdf_ocr_session: {
    args: {
      sessionId: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/commands.rs:356 `pin_images` */
  pin_images: {
    args: {
      tempId: string;
      images: string[];
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/commands.rs:774 `process_pdf_ocr` */
  process_pdf_ocr: {
    args: {
      request: PdfOcrRequest;
    };
    result: PdfOcrResult;
    error: Shared.AppError;
  };
  /** src/cmd/ocr.rs:527 `remove_ocr_engine` */
  remove_ocr_engine: {
    args: {
      configId: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/commands.rs:814 `resume_pdf_ocr_session` */
  resume_pdf_ocr_session: {
    args: {
      sessionId: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/ocr.rs:356 `save_available_ocr_models` */
  save_available_ocr_models: {
    args: {
      models: SaveOcrModelRequest[];
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/commands.rs:891 `save_pdf_to_temp` */
  save_pdf_to_temp: {
    args: {
      pdfBase64: string;
      fileName: string;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/ocr.rs:88 `set_ocr_engine_type` */
  set_ocr_engine_type: {
    args: {
      engineType: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/ocr.rs:76 `set_ocr_thinking_enabled` */
  set_ocr_thinking_enabled: {
    args: {
      enabled: boolean;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/commands.rs:829 `skip_pdf_ocr_page` */
  skip_pdf_ocr_page: {
    args: {
      sessionId: string;
      pageIndex: number;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/commands.rs:846 `start_pdf_ocr_backend` */
  start_pdf_ocr_backend: {
    args: {
      pdfPath: string;
      pdfName?: string | null;
      renderDpi?: number | null;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/cmd/ocr.rs:612 `test_ocr_engine` */
  test_ocr_engine: {
    args: {
      request: OcrTestRequest;
    };
    result: OcrTestResponse;
    error: Shared.AppError;
  };
  /** crates/dstu-docs/src/pdfium_utils.rs:192 `test_pdfium_status` */
  test_pdfium_status: {
    args: Record<string, never>;
    result: { [key: string]: string };
    error: string;
  };
  /** src/cmd/textbooks.rs:114 `textbooks_add` */
  textbooks_add: {
    args: {
      sources: string[];
      folderId?: string | null;
    };
    result: Textbook[];
    error: Shared.AppError;
  };
  /** src/cmd/textbooks.rs:700 `textbooks_relink` */
  textbooks_relink: {
    args: {
      id: string;
      newPath: string;
    };
    result: Textbook;
    error: Shared.AppError;
  };
  /** src/cmd/textbooks.rs:821 `textbooks_update_bookmarks` */
  textbooks_update_bookmarks: {
    args: {
      id: string;
      bookmarks: unknown[];
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/tts.rs:25 `tts_check_available` */
  tts_check_available: {
    args: Record<string, never>;
    result: boolean;
    error: Shared.AppError;
  };
  /** host/plugins/media/src/register-voice.ts */
  tts_deepseek: {
    args: {
      text: string;
      voiceId?: string | null;
    };
    result: string;
    error: Shared.AppError;
  };
  /** src/tts.rs:59 `tts_speak` */
  tts_speak: {
    args: {
      text: string;
      lang?: string | null;
      rate?: number | null;
      volume?: number | null;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/tts.rs:93 `tts_stop` */
  tts_stop: {
    args: Record<string, never>;
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:384 `unpin_images` */
  unpin_images: {
    args: {
      tempId: string;
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/cmd/ocr.rs:403 `update_ocr_engine_priority` */
  update_ocr_engine_priority: {
    args: {
      engineList: UpdateOcrPriorityItem[];
    };
    result: boolean;
    error: Shared.AppError;
  };
  /** src/commands.rs:747 `upload_pdf_ocr_page` */
  upload_pdf_ocr_page: {
    args: {
      sessionId: string;
      page: PdfOcrPageInput;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/cmd/ocr.rs:113 `validate_ocr_model` */
  validate_ocr_model: {
    args: {
      model: string;
      engineType: string;
    };
    result: ValidateOcrModelResponse;
    error: Shared.AppError;
  };
  /** src/cmd/textbooks.rs:785 `vfs_get_file_blob_path` */
  vfs_get_file_blob_path: {
    args: {
      id: string;
    };
    result: string | null;
    error: Shared.AppError;
  };
  /** src/voice_input.rs:21 `voice_input_transcribe` */
  voice_input_transcribe: {
    args: {
      request: VoiceInputTranscribeRequest;
    };
    result: VoiceInputTranscribeResponse;
    error: Shared.AppError;
  };
}

export interface Events {
  "dstu:change": (Shared.DstuWatchEvent | {
    type: string;
    path: string;
  });
  [name: `dstu:change:${string}`]: (Shared.DstuWatchEvent | {
    type: string;
    path: string;
  });
  "media_bilibili_playback_error": {
    fileId: string;
    qn: number;
    epoch: number;
    attempt: number;
    message: string;
  };
  "pdf-annotations:changed": {
    textbook_id: string;
    resource_path: string;
    kind: string;
    action: string;
    updated_at: string;
  } | {
    textbook_id: string;
    resource_path: string;
    kind: string;
    updated_at: string;
  };
  "pdf_ocr_progress": ({
    type: string;
    session_id: string;
    page_index: number;
    attempt: number;
    max_attempts: number;
    backoff_ms: number;
    hint: string;
  } | {
    type: string;
    session_id: string;
    page_index: number;
    completed: number;
    total: number;
    cached: boolean;
    page_result: {
      page_index: number;
      width: number;
      height: number;
      blocks: PdfOcrTextBlock[];
    };
  } | {
    type: string;
    session_id: string;
    page_index: number;
    error: string;
  } | {
    type: string;
    session_id: string;
    page_index: number;
    rendered: number;
    total: number;
  } | {
    type: string;
    session_id: string;
    total_pages: number;
  } | unknown);
  "textbook-import-progress": TextbookImportProgress;
}

export type CommandName = keyof Commands;
export type AddOcrEngineCommandArgs = Commands['add_ocr_engine']['args'];
export type AddOcrEngineCommandResult = Commands['add_ocr_engine']['result'];
export type CancelPdfOcrSessionCommandArgs = Commands['cancel_pdf_ocr_session']['args'];
export type CancelPdfOcrSessionCommandResult = Commands['cancel_pdf_ocr_session']['result'];
export type CompressImageCommandArgs = Commands['compress_image']['args'];
export type CompressImageCommandResult = Commands['compress_image']['result'];
export type ConvertHeicToJpegCommandArgs = Commands['convert_heic_to_jpeg']['args'];
export type ConvertHeicToJpegCommandResult = Commands['convert_heic_to_jpeg']['result'];
export type GetAvailableOcrModelsCommandArgs = Commands['get_available_ocr_models']['args'];
export type GetAvailableOcrModelsCommandResult = Commands['get_available_ocr_models']['result'];
export type GetImageAsBase64CommandArgs = Commands['get_image_as_base64']['args'];
export type GetImageAsBase64CommandResult = Commands['get_image_as_base64']['result'];
export type GetOcrEngineTypeCommandArgs = Commands['get_ocr_engine_type']['args'];
export type GetOcrEngineTypeCommandResult = Commands['get_ocr_engine_type']['result'];
export type GetOcrEnginesCommandArgs = Commands['get_ocr_engines']['args'];
export type GetOcrEnginesCommandResult = Commands['get_ocr_engines']['result'];
export type GetOcrPromptTemplateCommandArgs = Commands['get_ocr_prompt_template']['args'];
export type GetOcrPromptTemplateCommandResult = Commands['get_ocr_prompt_template']['result'];
export type GetOcrThinkingEnabledCommandArgs = Commands['get_ocr_thinking_enabled']['args'];
export type GetOcrThinkingEnabledCommandResult = Commands['get_ocr_thinking_enabled']['result'];
export type GetPdfOcrTempDirCommandArgs = Commands['get_pdf_ocr_temp_dir']['args'];
export type GetPdfOcrTempDirCommandResult = Commands['get_pdf_ocr_temp_dir']['result'];
export type GetRecentDocumentTasksCommandArgs = Commands['get_recent_document_tasks']['args'];
export type GetRecentDocumentTasksCommandResult = Commands['get_recent_document_tasks']['result'];
export type HandoutCancelCommandArgs = Commands['handout_cancel']['args'];
export type HandoutCancelCommandResult = Commands['handout_cancel']['result'];
export type HandoutLlmCompleteCommandArgs = Commands['handout_llm_complete']['args'];
export type HandoutLlmCompleteCommandResult = Commands['handout_llm_complete']['result'];
export type HandoutReleaseCommandArgs = Commands['handout_release']['args'];
export type HandoutReleaseCommandResult = Commands['handout_release']['result'];
export type HandoutVlmCaptionCommandArgs = Commands['handout_vlm_caption']['args'];
export type HandoutVlmCaptionCommandResult = Commands['handout_vlm_caption']['result'];
export type InferOcrEngineFromModelCommandArgs = Commands['infer_ocr_engine_from_model']['args'];
export type InferOcrEngineFromModelCommandResult = Commands['infer_ocr_engine_from_model']['result'];
export type InitPdfOcrSessionCommandArgs = Commands['init_pdf_ocr_session']['args'];
export type InitPdfOcrSessionCommandResult = Commands['init_pdf_ocr_session']['result'];
export type MediaBilibiliAuthStatusCommandArgs = Commands['media_bilibili_auth_status']['args'];
export type MediaBilibiliAuthStatusCommandResult = Commands['media_bilibili_auth_status']['result'];
export type MediaBilibiliBridgeApproveCommandArgs = Commands['media_bilibili_bridge_approve']['args'];
export type MediaBilibiliBridgeApproveCommandResult = Commands['media_bilibili_bridge_approve']['result'];
export type MediaBilibiliBridgeDisconnectCommandArgs = Commands['media_bilibili_bridge_disconnect']['args'];
export type MediaBilibiliBridgeDisconnectCommandResult = Commands['media_bilibili_bridge_disconnect']['result'];
export type MediaBilibiliBridgePairCommandArgs = Commands['media_bilibili_bridge_pair']['args'];
export type MediaBilibiliBridgePairCommandResult = Commands['media_bilibili_bridge_pair']['result'];
export type MediaBilibiliCancelCommandArgs = Commands['media_bilibili_cancel']['args'];
export type MediaBilibiliCancelCommandResult = Commands['media_bilibili_cancel']['result'];
export type MediaBilibiliCreateCommandArgs = Commands['media_bilibili_create']['args'];
export type MediaBilibiliCreateCommandResult = Commands['media_bilibili_create']['result'];
export type MediaBilibiliImportSubtitleCommandArgs = Commands['media_bilibili_import_subtitle']['args'];
export type MediaBilibiliImportSubtitleCommandResult = Commands['media_bilibili_import_subtitle']['result'];
export type MediaBilibiliLinkGetCommandArgs = Commands['media_bilibili_link_get']['args'];
export type MediaBilibiliLinkGetCommandResult = Commands['media_bilibili_link_get']['result'];
export type MediaBilibiliLoginQrPollCommandArgs = Commands['media_bilibili_login_qr_poll']['args'];
export type MediaBilibiliLoginQrPollCommandResult = Commands['media_bilibili_login_qr_poll']['result'];
export type MediaBilibiliLoginQrStartCommandArgs = Commands['media_bilibili_login_qr_start']['args'];
export type MediaBilibiliLoginQrStartCommandResult = Commands['media_bilibili_login_qr_start']['result'];
export type MediaBilibiliLogoutCommandArgs = Commands['media_bilibili_logout']['args'];
export type MediaBilibiliLogoutCommandResult = Commands['media_bilibili_logout']['result'];
export type MediaBilibiliProbeCommandArgs = Commands['media_bilibili_probe']['args'];
export type MediaBilibiliProbeCommandResult = Commands['media_bilibili_probe']['result'];
export type MediaBilibiliStreamQualityCommandArgs = Commands['media_bilibili_stream_quality']['args'];
export type MediaBilibiliStreamQualityCommandResult = Commands['media_bilibili_stream_quality']['result'];
export type MediaBilibiliTransportConfigureCommandArgs = Commands['media_bilibili_transport_configure']['args'];
export type MediaBilibiliTransportConfigureCommandResult = Commands['media_bilibili_transport_configure']['result'];
export type MediaBilibiliTransportStatusCommandArgs = Commands['media_bilibili_transport_status']['args'];
export type MediaBilibiliTransportStatusCommandResult = Commands['media_bilibili_transport_status']['result'];
export type MediaChaptersCommandArgs = Commands['media_chapters']['args'];
export type MediaChaptersCommandResult = Commands['media_chapters']['result'];
export type MediaCheckpointsCommandArgs = Commands['media_checkpoints']['args'];
export type MediaCheckpointsCommandResult = Commands['media_checkpoints']['result'];
export type MediaLibraryListCommandArgs = Commands['media_library_list']['args'];
export type MediaLibraryListCommandResult = Commands['media_library_list']['result'];
export type MediaProgressGetCommandArgs = Commands['media_progress_get']['args'];
export type MediaProgressGetCommandResult = Commands['media_progress_get']['result'];
export type MediaProgressSetCommandArgs = Commands['media_progress_set']['args'];
export type MediaProgressSetCommandResult = Commands['media_progress_set']['result'];
export type MediaRelatedNotesCommandArgs = Commands['media_related_notes']['args'];
export type MediaRelatedNotesCommandResult = Commands['media_related_notes']['result'];
export type MediaStudyLedgerCommandArgs = Commands['media_study_ledger']['args'];
export type MediaStudyLedgerCommandResult = Commands['media_study_ledger']['result'];
export type MediaTranscribeCancelCommandArgs = Commands['media_transcribe_cancel']['args'];
export type MediaTranscribeCancelCommandResult = Commands['media_transcribe_cancel']['result'];
export type MediaTranscribeEstimateCommandArgs = Commands['media_transcribe_estimate']['args'];
export type MediaTranscribeEstimateCommandResult = Commands['media_transcribe_estimate']['result'];
export type MediaTranscribeStartCommandArgs = Commands['media_transcribe_start']['args'];
export type MediaTranscribeStartCommandResult = Commands['media_transcribe_start']['result'];
export type MediaTranscriptExportCommandArgs = Commands['media_transcript_export']['args'];
export type MediaTranscriptExportCommandResult = Commands['media_transcript_export']['result'];
export type MediaTranscriptGetCommandArgs = Commands['media_transcript_get']['args'];
export type MediaTranscriptGetCommandResult = Commands['media_transcript_get']['result'];
export type MediaTranscriptImportCommandArgs = Commands['media_transcript_import']['args'];
export type MediaTranscriptImportCommandResult = Commands['media_transcript_import']['result'];
export type NotesExportDocxCommandArgs = Commands['notes_export_docx']['args'];
export type NotesExportDocxCommandResult = Commands['notes_export_docx']['result'];
export type ParseDocumentFromBase64CommandArgs = Commands['parse_document_from_base64']['args'];
export type ParseDocumentFromBase64CommandResult = Commands['parse_document_from_base64']['result'];
export type ParseDocumentFromPathCommandArgs = Commands['parse_document_from_path']['args'];
export type ParseDocumentFromPathCommandResult = Commands['parse_document_from_path']['result'];
export type PausePdfOcrSessionCommandArgs = Commands['pause_pdf_ocr_session']['args'];
export type PausePdfOcrSessionCommandResult = Commands['pause_pdf_ocr_session']['result'];
export type PinImagesCommandArgs = Commands['pin_images']['args'];
export type PinImagesCommandResult = Commands['pin_images']['result'];
export type ProcessPdfOcrCommandArgs = Commands['process_pdf_ocr']['args'];
export type ProcessPdfOcrCommandResult = Commands['process_pdf_ocr']['result'];
export type RemoveOcrEngineCommandArgs = Commands['remove_ocr_engine']['args'];
export type RemoveOcrEngineCommandResult = Commands['remove_ocr_engine']['result'];
export type ResumePdfOcrSessionCommandArgs = Commands['resume_pdf_ocr_session']['args'];
export type ResumePdfOcrSessionCommandResult = Commands['resume_pdf_ocr_session']['result'];
export type SaveAvailableOcrModelsCommandArgs = Commands['save_available_ocr_models']['args'];
export type SaveAvailableOcrModelsCommandResult = Commands['save_available_ocr_models']['result'];
export type SavePdfToTempCommandArgs = Commands['save_pdf_to_temp']['args'];
export type SavePdfToTempCommandResult = Commands['save_pdf_to_temp']['result'];
export type SetOcrEngineTypeCommandArgs = Commands['set_ocr_engine_type']['args'];
export type SetOcrEngineTypeCommandResult = Commands['set_ocr_engine_type']['result'];
export type SetOcrThinkingEnabledCommandArgs = Commands['set_ocr_thinking_enabled']['args'];
export type SetOcrThinkingEnabledCommandResult = Commands['set_ocr_thinking_enabled']['result'];
export type SkipPdfOcrPageCommandArgs = Commands['skip_pdf_ocr_page']['args'];
export type SkipPdfOcrPageCommandResult = Commands['skip_pdf_ocr_page']['result'];
export type StartPdfOcrBackendCommandArgs = Commands['start_pdf_ocr_backend']['args'];
export type StartPdfOcrBackendCommandResult = Commands['start_pdf_ocr_backend']['result'];
export type TestOcrEngineCommandArgs = Commands['test_ocr_engine']['args'];
export type TestOcrEngineCommandResult = Commands['test_ocr_engine']['result'];
export type TestPdfiumStatusCommandArgs = Commands['test_pdfium_status']['args'];
export type TestPdfiumStatusCommandResult = Commands['test_pdfium_status']['result'];
export type TextbooksAddCommandArgs = Commands['textbooks_add']['args'];
export type TextbooksAddCommandResult = Commands['textbooks_add']['result'];
export type TextbooksRelinkCommandArgs = Commands['textbooks_relink']['args'];
export type TextbooksRelinkCommandResult = Commands['textbooks_relink']['result'];
export type TextbooksUpdateBookmarksCommandArgs = Commands['textbooks_update_bookmarks']['args'];
export type TextbooksUpdateBookmarksCommandResult = Commands['textbooks_update_bookmarks']['result'];
export type TtsCheckAvailableCommandArgs = Commands['tts_check_available']['args'];
export type TtsCheckAvailableCommandResult = Commands['tts_check_available']['result'];
export type TtsDeepseekCommandArgs = Commands['tts_deepseek']['args'];
export type TtsDeepseekCommandResult = Commands['tts_deepseek']['result'];
export type TtsSpeakCommandArgs = Commands['tts_speak']['args'];
export type TtsSpeakCommandResult = Commands['tts_speak']['result'];
export type TtsStopCommandArgs = Commands['tts_stop']['args'];
export type TtsStopCommandResult = Commands['tts_stop']['result'];
export type UnpinImagesCommandArgs = Commands['unpin_images']['args'];
export type UnpinImagesCommandResult = Commands['unpin_images']['result'];
export type UpdateOcrEnginePriorityCommandArgs = Commands['update_ocr_engine_priority']['args'];
export type UpdateOcrEnginePriorityCommandResult = Commands['update_ocr_engine_priority']['result'];
export type UploadPdfOcrPageCommandArgs = Commands['upload_pdf_ocr_page']['args'];
export type UploadPdfOcrPageCommandResult = Commands['upload_pdf_ocr_page']['result'];
export type ValidateOcrModelCommandArgs = Commands['validate_ocr_model']['args'];
export type ValidateOcrModelCommandResult = Commands['validate_ocr_model']['result'];
export type VfsGetFileBlobPathCommandArgs = Commands['vfs_get_file_blob_path']['args'];
export type VfsGetFileBlobPathCommandResult = Commands['vfs_get_file_blob_path']['result'];
export type VoiceInputTranscribeCommandArgs = Commands['voice_input_transcribe']['args'];
export type VoiceInputTranscribeCommandResult = Commands['voice_input_transcribe']['result'];
