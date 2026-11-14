import { AppError, CommandError } from '../../errors/api.ts';
import type { NativeHeic } from './api.ts';

function rawBody(body: unknown): Uint8Array {
  const bytes = body instanceof Uint8Array ? body : body instanceof ArrayBuffer ? new Uint8Array(body) : null;
  if (bytes === null) throw new CommandError(AppError.validation('HEIC_INVALID_INPUT: expected raw binary request body'));
  if (bytes.length === 0) throw new CommandError(AppError.validation('HEIC_INVALID_INPUT: empty image body'));
  if (bytes.length > 50 * 1024 * 1024) throw new CommandError(AppError.validation('HEIC_INVALID_INPUT: image exceeds 50 MB'));
  return bytes;
}

export const heic: NativeHeic = {
  convertToJpeg(body): never {
    rawBody(body);
    throw new CommandError(AppError.validation('HEIC_UNSUPPORTED_PLATFORM: native HEIC conversion is only available on Android'));
  },
};
