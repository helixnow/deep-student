/** `node:zlib` 占位，语义见 `./stream.ts`：可求值，调用即抛 `UNSUPPORTED_ON_PLATFORM`（移动端压缩走 `CompressionStream`）。 */
function unsupported(name: string) {
  return (): never => {
    const error = new Error(`UNSUPPORTED_ON_PLATFORM: zlib.${name} is not available on mobile; use CompressionStream`) as Error & { code: string };
    error.code = 'UNSUPPORTED_ON_PLATFORM';
    throw error;
  };
}

export const createDeflateRaw = unsupported('createDeflateRaw');
export const createInflateRaw = unsupported('createInflateRaw');
export const createGzip = unsupported('createGzip');
export const createGunzip = unsupported('createGunzip');
export const deflateRawSync = unsupported('deflateRawSync');
export const inflateRawSync = unsupported('inflateRawSync');
export const gzipSync = unsupported('gzipSync');
export const gunzipSync = unsupported('gunzipSync');
export const crc32 = unsupported('crc32');
export const constants = {};

export default { createDeflateRaw, createInflateRaw, createGzip, createGunzip, deflateRawSync, inflateRawSync, gzipSync, gunzipSync, crc32, constants };
