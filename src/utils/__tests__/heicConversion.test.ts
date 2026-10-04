import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  convertHeicToJpeg,
  decodeHeicWithAndroidNative,
  describeHeicConversionError,
  fitWithinPixels,
  HeicConversionError,
  isHeicFile,
  prepareHeicFiles,
  sniffHeicMime,
  toJpegFileName,
  type HeicDecoder,
} from '@/utils/heicConversion';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const heic = (name = 'IMG_0001.HEIC', type = '') => new File(['heic-bytes'], name, { type, lastModified: 42 });
const jpegBlob = () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' });

describe('isHeicFile', () => {
  it('detects by extension (case-insensitive) even when MIME is empty', () => {
    expect(isHeicFile(heic('a.heic'))).toBe(true);
    expect(isHeicFile(heic('a.HEIF'))).toBe(true);
  });
  it('detects by MIME when the name has no HEIC extension', () => {
    expect(isHeicFile({ name: 'image:1234', type: 'image/heif' })).toBe(true);
  });
  it('ignores ordinary images', () => {
    expect(isHeicFile({ name: 'a.jpg', type: 'image/jpeg' })).toBe(false);
    expect(isHeicFile({ name: 'a.avif', type: 'image/avif' })).toBe(false);
  });
});

describe('sniffHeicMime', () => {
  const header = (brand: string) => new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...[...brand].map((c) => c.charCodeAt(0))]);
  it('recognizes HEIC and HEIF ftyp brands', () => {
    expect(sniffHeicMime(header('heic'))).toBe('image/heic');
    expect(sniffHeicMime(header('mif1'))).toBe('image/heif');
  });
  it('rejects AVIF and non-ISO-BMFF data', () => {
    expect(sniffHeicMime(header('avif'))).toBeNull();
    expect(sniffHeicMime(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(sniffHeicMime(new Uint8Array([0, 0, 0]))).toBeNull();
  });
});

describe('helpers', () => {
  it('renames to .jpg', () => {
    expect(toJpegFileName('IMG_0001.HEIC')).toBe('IMG_0001.jpg');
    expect(toJpegFileName('photo.v2.heif')).toBe('photo.v2.jpg');
    expect(toJpegFileName('noext')).toBe('noext.jpg');
  });
  it('caps pixel count while keeping aspect ratio', () => {
    expect(fitWithinPixels(4032, 3024, 16_000_000)).toEqual({ width: 4032, height: 3024 });
    const scaled = fitWithinPixels(8064, 6048, 16_000_000);
    expect(scaled.width * scaled.height).toBeLessThanOrEqual(16_000_000);
    expect(scaled.width / scaled.height).toBeCloseTo(8064 / 6048, 2);
  });
});

describe('convertHeicToJpeg dispatch', () => {
  it('uses the first decoder that succeeds and returns a JPEG File', async () => {
    const webview: HeicDecoder = vi.fn(async () => jpegBlob());
    const native: HeicDecoder = vi.fn(async () => jpegBlob());
    const out = await convertHeicToJpeg(heic(), [webview, native]);
    expect(out.name).toBe('IMG_0001.jpg');
    expect(out.type).toBe('image/jpeg');
    expect(out.lastModified).toBe(42);
    expect(native).not.toHaveBeenCalled();
  });

  it('falls through to the next decoder when one is unavailable (null)', async () => {
    const webview: HeicDecoder = vi.fn(async () => null);
    const native: HeicDecoder = vi.fn(async () => jpegBlob());
    await expect(convertHeicToJpeg(heic(), [webview, native])).resolves.toMatchObject({ type: 'image/jpeg' });
    expect(native).toHaveBeenCalledTimes(1);
  });

  it('falls through after a decoder throws and still succeeds later', async () => {
    const webview: HeicDecoder = vi.fn(async () => { throw new Error('canvas JPEG encoding failed'); });
    const native: HeicDecoder = vi.fn(async () => jpegBlob());
    await expect(convertHeicToJpeg(heic(), [webview, native])).resolves.toMatchObject({ name: 'IMG_0001.jpg' });
  });

  it("reports 'unsupported' when no decoder is available on the platform", async () => {
    const err = await convertHeicToJpeg(heic(), [async () => null, async () => null]).catch((e) => e);
    expect(err).toBeInstanceOf(HeicConversionError);
    expect(err.reason).toBe('unsupported');
    expect(err.fileName).toBe('IMG_0001.HEIC');
  });

  it('keeps the real failure reason when a decoder attempted and failed', async () => {
    const tooOld: HeicDecoder = async (file) => {
      throw new HeicConversionError('android_too_old', file.name, 'HEIC_UNSUPPORTED_OS');
    };
    const err = await convertHeicToJpeg(heic(), [async () => null, tooOld]).catch((e) => e);
    expect(err.reason).toBe('android_too_old');

    const generic = await convertHeicToJpeg(heic(), [async () => { throw new Error('boom'); }]).catch((e) => e);
    expect(generic).toBeInstanceOf(HeicConversionError);
    expect(generic.reason).toBe('decode_failed');
  });

  it('treats an empty blob as unavailable rather than success', async () => {
    const err = await convertHeicToJpeg(heic(), [async () => new Blob([])]).catch((e) => e);
    expect(err.reason).toBe('unsupported');
  });
});

describe('prepareHeicFiles', () => {
  it('passes non-HEIC through untouched, converts HEIC, and separates failures', async () => {
    const png = new File(['png'], 'a.png', { type: 'image/png' });
    const ok = heic('ok.heic');
    const bad = heic('bad.heic');
    const decoder: HeicDecoder = async (file) => {
      if (file.name === 'bad.heic') throw new Error('corrupt');
      return jpegBlob();
    };
    const { files, failures } = await prepareHeicFiles([png, ok, bad], [decoder]);
    expect(files.map((f) => f.name)).toEqual(['a.png', 'ok.jpg']);
    expect(files[0]).toBe(png);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ reason: 'decode_failed', fileName: 'bad.heic' });
  });
});

describe('describeHeicConversionError', () => {
  it('maps each reason to its own i18n key', () => {
    const t = (key: string) => key;
    expect(describeHeicConversionError(new HeicConversionError('unsupported', 'a', ''), t))
      .toBe('common:utils.notifications.heic_unsupported');
    expect(describeHeicConversionError(new HeicConversionError('android_too_old', 'a', ''), t))
      .toBe('common:utils.notifications.heic_android_too_old');
    expect(describeHeicConversionError(new HeicConversionError('decode_failed', 'a', ''), t))
      .toBe('common:utils.notifications.heic_decode_failed');
  });
});

describe('decodeHeicWithAndroidNative', () => {
  const originalUA = navigator.userAgent;
  const setUA = (ua: string) => Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });

  afterEach(() => {
    setUA(originalUA);
    delete (window as any).__TAURI_INTERNALS__;
    vi.mocked(invoke).mockReset();
  });

  it('is unavailable (null) outside Android Tauri without touching IPC', async () => {
    setUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    (window as any).__TAURI_INTERNALS__ = {};
    await expect(decodeHeicWithAndroidNative(heic())).resolves.toBeNull();
    setUA('Mozilla/5.0 (Linux; Android 14; Pixel 8; wv)');
    delete (window as any).__TAURI_INTERNALS__;
    await expect(decodeHeicWithAndroidNative(heic())).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('sends raw bytes to convert_heic_to_jpeg and wraps the result as JPEG', async () => {
    setUA('Mozilla/5.0 (Linux; Android 14; Pixel 8; wv)');
    (window as any).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockResolvedValue(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer);
    const blob = await decodeHeicWithAndroidNative(heic());
    expect(blob?.type).toBe('image/jpeg');
    expect(blob?.size).toBe(4);
    const [cmd, payload] = vi.mocked(invoke).mock.calls[0];
    expect(cmd).toBe('convert_heic_to_jpeg');
    expect(payload).toBeInstanceOf(Uint8Array);
  });

  it('maps the native API-level error to android_too_old', async () => {
    setUA('Mozilla/5.0 (Linux; Android 8.1; wv)');
    (window as any).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockRejectedValue({ message: 'HEIC_UNSUPPORTED_OS: requires Android 9' });
    await expect(decodeHeicWithAndroidNative(heic())).rejects.toMatchObject({ reason: 'android_too_old' });
    vi.mocked(invoke).mockRejectedValue('HEIC_DECODE_FAILED: bad file');
    await expect(decodeHeicWithAndroidNative(heic())).rejects.toMatchObject({ reason: 'decode_failed' });
  });
});
