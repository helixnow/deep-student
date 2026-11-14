declare module 'pako' {
  export class Inflate {
    err: number;
    msg: string;
    ended: boolean;
    chunks: Uint8Array[];
    onData?: (chunk: Uint8Array) => void;
    constructor(options?: { raw?: boolean; chunkSize?: number });
    push(data: Uint8Array, flushMode?: boolean | number): boolean;
  }
  export function inflateRaw(input: Uint8Array): Uint8Array;
  export function deflateRaw(input: Uint8Array): Uint8Array;
  const pako: {
    Inflate: typeof Inflate;
    inflateRaw: typeof inflateRaw;
    deflateRaw: typeof deflateRaw;
  };
  export default pako;
}
