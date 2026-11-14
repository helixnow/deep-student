/**
 * `node:stream` / `node:zlib` 占位：只让桌面专用模块（`host/platform/zip/node/file.ts`，经 kernel 插件管理器进入闭包）能被求值。
 * 移动端用 Web 流（`ReadableStream` / `CompressionStream`）；这里的类构造或静态方法一被调用就抛 `UNSUPPORTED_ON_PLATFORM`。
 */
function unsupported(name: string): never {
  const error = new Error(`UNSUPPORTED_ON_PLATFORM: ${name} is not available on mobile; use Web streams`) as Error & { code: string };
  error.code = 'UNSUPPORTED_ON_PLATFORM';
  throw error;
}

function streamClass(name: string) {
  return class {
    constructor() {
      unsupported(`stream.${name}`);
    }

    static from(): never { return unsupported(`stream.${name}.from`); }
    static fromWeb(): never { return unsupported(`stream.${name}.fromWeb`); }
    static toWeb(): never { return unsupported(`stream.${name}.toWeb`); }
  };
}

export const Stream = streamClass('Stream');
export const Readable = streamClass('Readable');
export const Writable = streamClass('Writable');
export const Duplex = streamClass('Duplex');
export const Transform = streamClass('Transform');
export const PassThrough = streamClass('PassThrough');
export const pipeline = (): never => unsupported('stream.pipeline');
export const finished = (): never => unsupported('stream.finished');

export default { Stream, Readable, Writable, Duplex, Transform, PassThrough, pipeline, finished };
