/** Exact Display, stable_code and to_command_error from vfs/error.rs. */
export interface VfsErrorFields {
  Database: string;
  NotFound: { resource_type: string; id: string };
  AlreadyExists: { resource_type: string; id: string };
  HashCollision: { hash: string };
  Io: string;
  Serialization: string;
  InvalidArgument: { param: string; reason: string };
  PathParse: { path: string; reason: string };
  RefCount: { resource_id: string; reason: string };
  Migration: string;
  Pool: string;
  FolderNotFound: { folder_id: string };
  FolderAlreadyExists: { folder_id: string };
  FolderDepthExceeded: { folder_id: string; current_depth: number; max_depth: number };
  ItemNotFound: { item_type: string; item_id: string };
  InvalidParent: { folder_id: string; reason: string };
  FolderCountExceeded: { current_count: number; max_count: number };
  InvalidOperation: { operation: string; reason: string };
  InvalidState: { message: string };
  Maintenance: { component: string };
  Internal: string;
  Conflict: { key: string; message: string };
  Other: string;
}
export type VfsErrorKind = keyof VfsErrorFields;
export interface VfsCommandError {
  code: string;
  message: string;
  data?: Record<string, string>;
}

const messages: { [K in VfsErrorKind]: (value: VfsErrorFields[K]) => string } = {
  Database: v => `Database error: ${v}`,
  NotFound: v => `${v.resource_type} not found: ${v.id}`,
  AlreadyExists: v => `${v.resource_type} already exists: ${v.id}`,
  HashCollision: v => `Hash collision detected: ${v.hash}`,
  Io: v => `IO error: ${v}`,
  Serialization: v => `Serialization error: ${v}`,
  InvalidArgument: v => `Invalid argument '${v.param}': ${v.reason}`,
  PathParse: v => `Failed to parse path '${v.path}': ${v.reason}`,
  RefCount: v => `Ref count error for '${v.resource_id}': ${v.reason}`,
  Migration: v => `Migration error: ${v}`,
  Pool: v => `Connection pool error: ${v}`,
  FolderNotFound: v => `FOLDER_NOT_FOUND: ${v.folder_id}`,
  FolderAlreadyExists: v => `FOLDER_ALREADY_EXISTS: ${v.folder_id}`,
  FolderDepthExceeded: v => `FOLDER_DEPTH_EXCEEDED: ${v.folder_id} (depth ${v.current_depth} > max ${v.max_depth})`,
  ItemNotFound: v => `ITEM_NOT_FOUND: ${v.item_type}:${v.item_id}`,
  InvalidParent: v => `INVALID_PARENT: ${v.folder_id} - ${v.reason}`,
  FolderCountExceeded: v => `FOLDER_COUNT_EXCEEDED: ${v.current_count} folders (max ${v.max_count})`,
  InvalidOperation: v => `INVALID_OPERATION: ${v.operation} - ${v.reason}`,
  InvalidState: v => `INVALID_STATE: ${v.message}`,
  Maintenance: v => `MAINTENANCE_MODE: ${v.component} is temporarily unavailable`,
  Internal: v => `Internal error: ${v}`,
  Conflict: v => `CONFLICT(${v.key}): ${v.message}`,
  Other: v => v,
};
const codes: Record<VfsErrorKind, string> = {
  Database: 'VFS_STORAGE', Pool: 'VFS_STORAGE', Io: 'VFS_IO',
  NotFound: 'VFS_NOT_FOUND', ItemNotFound: 'VFS_NOT_FOUND', FolderNotFound: 'VFS_NOT_FOUND',
  AlreadyExists: 'VFS_ALREADY_EXISTS', FolderAlreadyExists: 'VFS_ALREADY_EXISTS',
  InvalidArgument: 'VFS_INVALID_ARGUMENT', PathParse: 'VFS_INVALID_ARGUMENT', InvalidParent: 'VFS_INVALID_ARGUMENT',
  InvalidOperation: 'VFS_INVALID_OPERATION', InvalidState: 'VFS_INVALID_OPERATION',
  Maintenance: 'VFS_MAINTENANCE', Conflict: 'VFS_CONFLICT', Serialization: 'VFS_SERIALIZATION',
  Migration: 'VFS_MIGRATION', RefCount: 'VFS_REF_COUNT', FolderDepthExceeded: 'VFS_LIMIT_EXCEEDED',
  FolderCountExceeded: 'VFS_LIMIT_EXCEEDED', HashCollision: 'VFS_INTERNAL', Internal: 'VFS_INTERNAL', Other: 'VFS_INTERNAL',
};

export class VfsError<K extends VfsErrorKind = VfsErrorKind> extends Error {
  readonly kind: K;
  readonly fields: VfsErrorFields[K];
  constructor(kind: K, fields: VfsErrorFields[K]) {
    super(messages[kind](fields));
    this.name = 'VfsError';
    this.kind = kind;
    this.fields = fields;
  }
  override toString(): string { return this.message; }
  stableCode(): string { return codes[this.kind]; }
  toCommandError(): VfsCommandError {
    const envelope: VfsCommandError = { code: this.stableCode(), message: this.message };
    const v: VfsErrorFields[VfsErrorKind] = this.fields;
    if (typeof v !== 'string') {
      if (this.kind === 'Conflict' && 'key' in v) envelope.data = { key: v.key };
      else if (this.kind === 'NotFound' && 'resource_type' in v) envelope.data = { resourceType: v.resource_type, id: v.id };
      else if (this.kind === 'ItemNotFound' && 'item_type' in v) envelope.data = { resourceType: v.item_type, id: v.item_id };
      else if (this.kind === 'FolderNotFound' && 'folder_id' in v) envelope.data = { id: v.folder_id };
      else if (this.kind === 'InvalidArgument' && 'param' in v) envelope.data = { param: v.param };
      else if (this.kind === 'Maintenance' && 'component' in v) envelope.data = { component: v.component };
    }
    return envelope;
  }
}
