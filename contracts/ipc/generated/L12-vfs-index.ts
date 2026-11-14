// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L12-vfs-index.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** dstu_vfs::vfs::pdf_processing_service::MediaProcessingCompletedEvent */
export type MediaProcessingCompletedEvent = {
  fileId: string;
  readyModes: string[];
  stage: string;
  mediaType: string;
};
/** dstu_vfs::vfs::pdf_processing_service::MediaProcessingErrorEvent */
export type MediaProcessingErrorEvent = {
  fileId: string;
  error: string;
  stage: string;
  mediaType: string;
};
/** dstu_vfs::vfs::pdf_processing_service::MediaProcessingProgressEvent */
export type MediaProcessingProgressEvent = {
  fileId: string;
  status: Shared.ProcessingProgress;
  mediaType: string;
};
/** dstu_vfs::vfs::pdf_processing_service::MediaTranscriptionCompletedEvent */
export type MediaTranscriptionCompletedEvent = {
  fileId: string;
  readyModes: string[];
  stage: string;
  mediaType: string;
  completedSegments: number;
  totalSegments: number;
};
/** dstu_vfs::vfs::pdf_processing_service::MediaTranscriptionProgressEvent */
export type MediaTranscriptionProgressEvent = {
  fileId: string;
  status: Shared.ProcessingProgress;
  mediaType: string;
  stage: string;
  completedSegments?: number | null;
  totalSegments?: number | null;
};

export interface Commands {
  /** src/commands.rs:2012 `clear_message_embeddings` */
  clear_message_embeddings: {
    args: {
      messageIds: string[];
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:2088 `optimize_chat_embeddings_table` */
  optimize_chat_embeddings_table: {
    args: {
      olderThanDays?: number | null;
      deleteUnverified?: boolean | null;
      force?: boolean | null;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/commands.rs:6898 `optimize_lance_database` */
  optimize_lance_database: {
    args: {
      parallelism?: number | null;
      force?: boolean | null;
    };
    result: unknown;
    error: Shared.AppError;
  };
}

export interface Events {
  "media-processing-completed": (MediaProcessingCompletedEvent | MediaTranscriptionCompletedEvent);
  "media-processing-error": MediaProcessingErrorEvent;
  "media-processing-progress": (MediaProcessingProgressEvent | MediaTranscriptionProgressEvent);
  "pdf-processing-completed": MediaProcessingCompletedEvent;
  "pdf-processing-error": MediaProcessingErrorEvent;
  "pdf-processing-progress": MediaProcessingProgressEvent;
  "vfs-index-progress": {
    type: string;
    resourceId: string;
    blockId: string;
    chunks: number;
    embeddingDim: number;
  } | {
    type: string;
    resourceId: string;
    blockId: string;
    current: unknown /* x-unresolved: json! value `done` type not determinable statically */;
    total: unknown /* x-unresolved: json! value `total` type not determinable statically */;
    progress: number;
  } | {
    type: string;
    resourceId: string;
    blockId: string;
    error: string;
  } | {
    type: string;
    resourceId: string;
    blockId: string;
  } | {
    type: string;
    resourceId: string;
    chunkCount: number;
    current: number;
    total: number;
    progress: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    chunkCount: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    chunksProcessed: number;
    chunksTotal: number;
    progress: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    current: number;
    total: number;
    chunksProcessed: number;
    chunksTotal: number;
    progress: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    current: number;
    total: number;
    progress: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    error: string;
    current: number;
    total: number;
    progress: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    error: string;
    message: string;
  } | {
    type: string;
    resourceId: string;
    fileId: string;
    currentPage: number;
    totalPages: number;
    successCount: number;
    percent: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    fileId: string;
    success: boolean;
    successCount: number;
    failCount: number;
    totalPages: number;
    textLength: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    fileId: string;
    success: boolean;
    successCount: number;
    failCount: number;
    totalPages: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    fileId: string;
    totalPages: number;
    message: string;
  } | {
    type: string;
    resourceId: string;
    message: string;
  } | {
    type: string;
    successCount: number;
    failCount: number;
    total: number;
    progress: number;
    message: string;
  } | {
    type: string;
    total: number;
    message: string;
  };
}

export type CommandName = keyof Commands;
export type ClearMessageEmbeddingsCommandArgs = Commands['clear_message_embeddings']['args'];
export type ClearMessageEmbeddingsCommandResult = Commands['clear_message_embeddings']['result'];
export type OptimizeChatEmbeddingsTableCommandArgs = Commands['optimize_chat_embeddings_table']['args'];
export type OptimizeChatEmbeddingsTableCommandResult = Commands['optimize_chat_embeddings_table']['result'];
export type OptimizeLanceDatabaseCommandArgs = Commands['optimize_lance_database']['args'];
export type OptimizeLanceDatabaseCommandResult = Commands['optimize_lance_database']['result'];
