/** Rust: chat_v2/error.rs. Display and command conversion are deliberately distinct. */
export interface ChatV2ErrorData {
  SessionNotFound: string;
  GroupNotFound: string;
  MessageNotFound: string;
  BlockNotFound: string;
  ResourceNotFound: string;
  VariantNotFound: string;
  VariantCannotActivateFailed: string;
  VariantCannotDeleteLast: undefined;
  VariantAlreadyStreaming: string;
  VariantCannotRetry: [string, string];
  LimitExceeded: string;
  Database: string;
  Llm: string;
  ContextWindowExceeded: { message: string; details: unknown };
  Tool: string;
  Cancelled: undefined;
  Serialization: string;
  Validation: string;
  Other: string;
  IoError: string;
  InvalidInput: string;
  DatabaseCorrupted: { original_error: string; rollback_error: string };
  Timeout: string;
}

const codes: Record<keyof ChatV2ErrorData, string> = {
  SessionNotFound: 'SESSION_NOT_FOUND', GroupNotFound: 'GROUP_NOT_FOUND',
  MessageNotFound: 'MESSAGE_NOT_FOUND', BlockNotFound: 'BLOCK_NOT_FOUND',
  ResourceNotFound: 'RESOURCE_NOT_FOUND', VariantNotFound: 'VARIANT_NOT_FOUND',
  VariantCannotActivateFailed: 'VARIANT_CANNOT_ACTIVATE', VariantCannotDeleteLast: 'VARIANT_CANNOT_DELETE_LAST',
  VariantAlreadyStreaming: 'VARIANT_ALREADY_STREAMING', VariantCannotRetry: 'VARIANT_CANNOT_RETRY',
  LimitExceeded: 'LIMIT_EXCEEDED', Database: 'DATABASE_ERROR', Llm: 'LLM_ERROR',
  ContextWindowExceeded: 'CONTEXT_WINDOW_EXCEEDED', Tool: 'TOOL_ERROR', Cancelled: 'CANCELLED',
  Serialization: 'SERIALIZATION_ERROR', Validation: 'VALIDATION_ERROR', Other: 'OTHER',
  IoError: 'IO_ERROR', InvalidInput: 'INVALID_INPUT', DatabaseCorrupted: 'DATABASE_CORRUPTED', Timeout: 'TIMEOUT',
};

function display(kind: keyof ChatV2ErrorData, value: ChatV2ErrorData[keyof ChatV2ErrorData]): string {
  switch (kind) {
    case 'SessionNotFound': return `Session not found: ${value}`;
    case 'GroupNotFound': return `Group not found: ${value}`;
    case 'MessageNotFound': return `Message not found: ${value}`;
    case 'BlockNotFound': return `Block not found: ${value}`;
    case 'ResourceNotFound': return `Resource not found: ${value}`;
    case 'VariantNotFound': return `Variant not found: ${value}`;
    case 'VariantCannotActivateFailed': return `Cannot activate failed variant: ${value}`;
    case 'VariantCannotDeleteLast': return 'Cannot delete last variant';
    case 'VariantAlreadyStreaming': return `Variant already streaming: ${value}`;
    case 'VariantCannotRetry': {
      const [id, status] = value as [string, string];
      return `Cannot retry variant: ${id}, current status: ${status}`;
    }
    case 'LimitExceeded': return `Limit exceeded: ${value}`;
    case 'Database': return `Database error: ${value}`;
    case 'Llm': return `LLM error: ${value}`;
    case 'ContextWindowExceeded': return (value as ChatV2ErrorData['ContextWindowExceeded']).message;
    case 'Tool': return `Tool error: ${value}`;
    case 'Cancelled': return 'Cancelled';
    case 'Serialization': return `Serialization error: ${value}`;
    case 'Validation': return `Validation error: ${value}`;
    case 'Other': return value as string;
    case 'IoError': return `IO error: ${value}`;
    case 'InvalidInput': return `Invalid input: ${value}`;
    case 'DatabaseCorrupted': {
      const data = value as ChatV2ErrorData['DatabaseCorrupted'];
      return `DATABASE CORRUPTED - Original error: ${data.original_error}, Rollback error: ${data.rollback_error}. Database may be in inconsistent state.`;
    }
    case 'Timeout': return `Tool execution timeout: ${value}`;
  }
}

export class ChatV2Error<K extends keyof ChatV2ErrorData = keyof ChatV2ErrorData> extends Error {
  readonly kind: K;
  readonly data: ChatV2ErrorData[K];

  constructor(kind: K, ...args: ChatV2ErrorData[K] extends undefined ? [] : [ChatV2ErrorData[K]]) {
    const value = args[0] as ChatV2ErrorData[K];
    super(display(kind, value));
    this.name = 'ChatV2Error';
    this.kind = kind;
    this.data = value;
  }

  code(): string { return codes[this.kind]; }
  override toString(): string { return this.message; }
  toCommandError(): string { return JSON.stringify({ code: this.code(), message: this.message }); }
  toJSON(): unknown { return this.data === undefined ? this.kind : { [this.kind]: this.data }; }
}
