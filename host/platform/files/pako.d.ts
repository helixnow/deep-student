declare module 'pako' {
  export class Inflate {
    err: number;
    msg: string;
    ended: boolean;
    strm: { avail_in: number };
    chunks: Uint8Array[];
    onData?: (chunk: Uint8Array) => void;
    constructor(options?: { raw?: boolean; chunkSize?: number });
    push(data: Uint8Array, flushMode?: boolean | number): boolean;
  }
  export class Deflate extends Inflate {
    constructor(options?: { raw?: boolean; chunkSize?: number; level?: number });
  }
  export function inflateRaw(input: Uint8Array): Uint8Array;
  export function deflateRaw(input: Uint8Array): Uint8Array;
  export function deflate(input: Uint8Array): Uint8Array;
  const pako: {
    Inflate: typeof Inflate;
    Deflate: typeof Deflate;
    inflateRaw: typeof inflateRaw;
    deflateRaw: typeof deflateRaw;
    deflate: typeof deflate;
  };
  export default pako;
}
