import type { DstuError } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';

const prefixes = {
  InvalidPath: 'Invalid DSTU path', MissingSegment: 'Missing path segment', InvalidNodeType: 'Invalid node type',
  NotFound: 'Resource not found', AlreadyExists: 'Resource already exists', NotSupported: 'Operation not supported',
  PermissionDenied: 'Permission denied', VfsError: 'VFS error', DatabaseError: 'Database error',
  SerializationError: 'Serialization error', IoError: 'IO error', Internal: 'Internal error',
} as const;

/** Rust dstu/error.rs; the wire message is the inner string, not Display. */
export class DstuFailure extends Error {
  readonly type: keyof typeof prefixes;
  readonly detail: string;
  constructor(type: keyof typeof prefixes, detail: string) {
    super(`${prefixes[type]}: ${detail}`);
    this.name = 'DstuError'; this.type = type; this.detail = detail;
  }
  override toString(): string { return this.message; }
  toJSON(): DstuError { return { type: this.type, message: this.detail }; }
}
