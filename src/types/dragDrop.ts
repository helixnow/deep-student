/**
 * 统一拖拽组件类型定义
 * 
 * 为 UnifiedDragDropZone 组件提供完整的 TypeScript 类型支持
 */

/**
 * 文件类型定义
 */
export interface FileTypeDefinition {
  /** 支持的文件扩展名（不含点号，如 'jpg', 'pdf'） */
  extensions: string[];
  /** 支持的 MIME 类型 */
  mimeTypes: string[];
  /** 文件类型描述（用于错误提示和UI显示） */
  description: string;
}

/**
 * 拖拽事件类型
 */
export type DragEventType = 'enter' | 'leave' | 'drop' | 'over' | 'cancel';

/**
 * 拖拽事件负载
 */
export interface DragDropPayload {
  /** 事件类型 */
  type: DragEventType;
  /** 文件路径列表（仅在 drop 事件中存在） */
  paths?: string[];
  /** 鼠标位置（可选） */
  position?: {
    x: number;
    y: number;
  };
}

/**
 * 文件验证结果
 */
export interface FileValidationResult {
  /** 是否通过验证 */
  valid: boolean;
  /** 文件对象（如果验证通过） */
  file?: File;
  /** 错误原因（如果验证失败） */
  reason?: string;
}

/**
 * 文件处理状态
 */
export interface FileProcessingState {
  /** 当前正在处理 */
  isProcessing: boolean;
  /** 已处理的文件数量 */
  processedCount: number;
  /** 总文件数量 */
  totalCount: number;
  /** 处理进度（0-100） */
  progress: number;
}

/**
 * 拖拽区域配置选项
 */
export interface DragDropZoneConfig {
  /** 唯一标识，用于区分不同的拖拽区域 */
  zoneId: string;
  /** 是否启用拖拽功能 */
  enabled?: boolean;
  /** 接受的文件类型 */
  acceptedFileTypes?: FileTypeDefinition[];
  /** 最大文件数量 */
  maxFiles?: number;
  /** 最大文件大小（字节） */
  maxFileSize?: number;
  /** 是否显示拖拽提示覆盖层 */
  showOverlay?: boolean;
  /** 自定义拖拽提示文本 */
  customOverlayText?: string;
  /** 自定义样式类名 */
  className?: string;
}

/**
 * 拖拽区域回调函数
 */
export interface DragDropZoneCallbacks {
  /** 文件放置回调 */
  onFilesDropped: (files: File[]) => void | Promise<void>;
  /** 错误回调 */
  onError?: (error: string) => void;
  /** 验证错误回调（用于细粒度错误处理） */
  onValidationError?: (error: string, rejectedFiles: string[]) => void;
  /** 拖拽状态变化回调 */
  onDragStateChange?: (isDragging: boolean) => void;
  /** 处理进度回调 */
  onProcessingProgress?: (state: FileProcessingState) => void;
}

/**
 * 拖拽区域完整属性
 */
export interface UnifiedDragDropZoneProps extends DragDropZoneConfig, DragDropZoneCallbacks {
  /** 子元素 */
  children?: React.ReactNode;
}

/**
 * 拖拽区域状态
 */
export interface DragDropZoneState {
  /** 是否正在拖拽 */
  isDragging: boolean;
  /** 是否正在处理文件 */
  isProcessing: boolean;
  /** 拖拽区域是否可见 */
  isVisible: boolean;
  /** 拖拽区域是否启用 */
  isEnabled: boolean;
}

/**
 * 拖拽区域注册信息
 */
export interface DragDropZoneRegistry {
  /** 区域ID */
  zoneId: string;
  /** 是否激活 */
  isActive: boolean;
  /** 注册时间戳 */
  registeredAt: number;
  /** 最后活动时间戳 */
  lastActiveAt: number;
}

/**
 * 预定义文件类型常量类型
 */
export type PredefinedFileType = 'IMAGE' | 'DOCUMENT' | 'ARCHIVE' | 'ALL';

/**
 * 文件拒绝原因
 */
export enum FileRejectionReason {
  /** 文件类型不支持 */
  UNSUPPORTED_TYPE = 'unsupported_type',
  /** 文件过大 */
  FILE_TOO_LARGE = 'file_too_large',
  /** 文件数量超限 */
  TOO_MANY_FILES = 'too_many_files',
  /** 读取文件失败 */
  READ_ERROR = 'read_error',
  /** 其他错误 */
  OTHER = 'other',
}

/**
 * 被拒绝的文件信息
 */
export interface RejectedFile {
  /** 文件路径或名称 */
  path: string;
  /** 文件名 */
  name: string;
  /** 拒绝原因 */
  reason: FileRejectionReason;
  /** 详细错误信息 */
  message: string;
  /** 文件大小（如果可用） */
  size?: number;
}

/**
 * 文件处理结果
 */
export interface FileProcessingResult {
  /** 成功处理的文件 */
  acceptedFiles: File[];
  /** 被拒绝的文件 */
  rejectedFiles: RejectedFile[];
  /** 处理总数 */
  totalCount: number;
  /** 成功数 */
  successCount: number;
  /** 失败数 */
  failureCount: number;
}

/**
 * 拖拽区域实用工具函数类型
 */
export interface DragDropZoneUtils {
  /** 获取支持的文件格式描述 */
  getSupportedFormatsDescription: () => string;
  /** 获取支持的文件扩展名列表 */
  getSupportedExtensions: () => string;
  /** 验证单个文件 */
  validateFile: (file: File) => FileValidationResult;
  /** 批量验证文件 */
  validateFiles: (files: File[]) => FileProcessingResult;
}

/**
 * 平台检测结果
 */
export interface PlatformInfo {
  /** 是否为 Tauri 环境 */
  isTauri: boolean;
  /** 是否为移动平台 */
  isMobile: boolean;
  /** 平台名称 */
  platform: 'windows' | 'macos' | 'linux' | 'ios' | 'android' | 'web';
  /** 是否支持原生拖拽 */
  supportsNativeDragDrop: boolean;
}

/**
 * 拖拽区域上下文类型
 */
export interface DragDropZoneContext {
  /** 所有活动的拖拽区域 */
  activeZones: Map<string, DragDropZoneRegistry>;
  /** 当前激活的区域ID */
  currentActiveZone: string | null;
  /** 注册拖拽区域 */
  registerZone: (zoneId: string, isActive: boolean) => void;
  /** 注销拖拽区域 */
  unregisterZone: (zoneId: string) => void;
  /** 检查区域是否应该接收文件 */
  shouldZoneReceiveFiles: (zoneId: string) => boolean;
  /** 获取平台信息 */
  getPlatformInfo: () => PlatformInfo;
}

