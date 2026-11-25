import { afterEach, describe, expect, it, vi } from 'vitest';
import jsQR from 'jsqr';
import { encodeQrCodeMatrix, renderQrCodeSvgString } from '../qrCodeSvg';
import {
  decodePairingFrame,
  decodePairingImage,
  decodePairingPixels,
  extractPairingCode,
  locatePairingQrRegions,
} from '../decodePairingQr';

interface CanvasBuf {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function createBuffer(width: number, height: number, r: number, g: number, b: number): CanvasBuf {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { data, width, height };
}

function fillRect(
  buf: CanvasBuf,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(buf.width, Math.ceil(x + w));
  const y1 = Math.min(buf.height, Math.ceil(y + h));
  for (let py = y0; py < y1; py++) {
    const row = py * buf.width;
    for (let px = x0; px < x1; px++) {
      const p = (row + px) * 4;
      buf.data[p] = r;
      buf.data[p + 1] = g;
      buf.data[p + 2] = b;
      buf.data[p + 3] = 255;
    }
  }
}

/**
 * Simulates realistic desktop UI chrome (sidebar, header, icons, checkboxes, dense rows)
 * that creates false-positive finder pattern candidates for single-pass jsQR.
 */
function paintDesktopChrome(buf: CanvasBuf, darkMode: boolean): void {
  const sidebar = darkMode ? [22, 27, 38] : [238, 242, 247];
  const header = darkMode ? [18, 23, 34] : [244, 247, 250];
  const border = darkMode ? [52, 62, 82] : [203, 213, 225];
  const text = darkMode ? [210, 218, 230] : [30, 41, 59];
  const bg = darkMode ? [15, 20, 30] : [248, 250, 252];

  // Sidebar & top bar
  fillRect(buf, 0, 0, Math.round(buf.width * 0.18), buf.height, sidebar[0]!, sidebar[1]!, sidebar[2]!);
  fillRect(buf, 0, 0, buf.width, Math.round(buf.height * 0.07), header[0]!, header[1]!, header[2]!);
  fillRect(buf, Math.round(buf.width * 0.18), 0, 2, buf.height, border[0]!, border[1]!, border[2]!);

  // Paint repeated square icon/checkbox glyphs (1:1:3:1:1 finder-like concentric squares!)
  // in the sidebar and left settings form to trigger jsQR's MAX_FINDERPATTERNS_TO_SEARCH=4 ceiling.
  const drawFinderDecoy = (cx: number, cy: number, unit: number) => {
    const size = unit * 7;
    fillRect(buf, cx - unit, cy - unit, size + unit * 2, size + unit * 2, bg[0]!, bg[1]!, bg[2]!);
    fillRect(buf, cx, cy, size, size, text[0]!, text[1]!, text[2]!);
    fillRect(buf, cx + unit, cy + unit, size - unit * 2, size - unit * 2, bg[0]!, bg[1]!, bg[2]!);
    fillRect(buf, cx + unit * 2, cy + unit * 2, size - unit * 4, size - unit * 4, text[0]!, text[1]!, text[2]!);
  };

  for (let row = 0; row < 8; row++) {
    const y = Math.round(buf.height * (0.12 + row * 0.095));
    // Sidebar icon decoys
    drawFinderDecoy(Math.round(buf.width * 0.025), y, Math.max(2, Math.round(buf.width / 480)));
    // Sidebar text bar
    fillRect(buf, Math.round(buf.width * 0.06), y + 4, Math.round(buf.width * 0.09), 6, text[0]!, text[1]!, text[2]!);
    // Settings form checkbox decoys (light-filled active checkbox with dark inner glyph, matching dark & light themes)
    const cbUnit = Math.max(2, Math.round(buf.width / 420));
    const cbX = Math.round(buf.width * 0.24);
    const cbSize = cbUnit * 7;
    fillRect(buf, cbX - cbUnit, y - cbUnit, cbSize + cbUnit * 2, cbSize + cbUnit * 2, 236, 240, 248);
    fillRect(buf, cbX, y, cbSize, cbSize, 24, 32, 48);
    fillRect(buf, cbX + cbUnit, y + cbUnit, cbSize - cbUnit * 2, cbSize - cbUnit * 2, 236, 240, 248);
    fillRect(buf, cbX + cbUnit * 2, y + cbUnit * 2, cbSize - cbUnit * 4, cbSize - cbUnit * 4, 24, 32, 48);
    for (let seg = 0; seg < 6; seg++) {
      fillRect(
        buf,
        Math.round(buf.width * (0.28 + seg * 0.045)),
        y + 5,
        Math.round(buf.width * 0.032),
        5,
        text[0]!,
        text[1]!,
        text[2]!,
      );
    }
  }
}

function drawQrMatrix(
  buf: CanvasBuf,
  text: string,
  opts: {
    x: number;
    y: number;
    size: number;
    quietModules?: number;
    cardPaddingPx?: number;
    darkRgb?: [number, number, number];
    lightRgb?: [number, number, number];
    ecc?: 'L' | 'M';
    /** Simulate browser anti-aliased subpixel SVG rasterization (4x4 supersampled area average). */
    antiAliased?: boolean;
  },
): { cardX: number; cardY: number; cardW: number; cardH: number } {
  const matrix = encodeQrCodeMatrix(text, opts.ecc ?? 'L');
  const modules = matrix.length;
  const quiet = opts.quietModules ?? 3;
  const totalModules = modules + quiet * 2;
  const pad = opts.cardPaddingPx ?? 0;
  const dark = opts.darkRgb ?? [15, 23, 42];
  const light = opts.lightRgb ?? [255, 255, 255];

  const cardX = opts.x - pad;
  const cardY = opts.y - pad;
  const cardW = opts.size + pad * 2;
  const cardH = opts.size + pad * 2;

  if (pad > 0 || quiet > 0) {
    fillRect(buf, cardX, cardY, cardW, cardH, light[0], light[1], light[2]);
  }

  for (let py = 0; py < opts.size; py++) {
    const rowOffset = (opts.y + py) * buf.width;
    for (let px = 0; px < opts.size; px++) {
      let darkCoverage = 0;
      if (opts.antiAliased) {
        for (let sy = 0; sy < 4; sy++) {
          const my = Math.floor((((py + (sy + 0.5) / 4) * totalModules) / opts.size)) - quiet;
          for (let sx = 0; sx < 4; sx++) {
            const mx = Math.floor((((px + (sx + 0.5) / 4) * totalModules) / opts.size)) - quiet;
            if (mx >= 0 && my >= 0 && mx < modules && my < modules && matrix[my]?.[mx]) {
              darkCoverage += 1 / 16;
            }
          }
        }
      } else {
        const my = Math.floor((py * totalModules) / opts.size) - quiet;
        const mx = Math.floor((px * totalModules) / opts.size) - quiet;
        darkCoverage = mx >= 0 && my >= 0 && mx < modules && my < modules && matrix[my]?.[mx] ? 1 : 0;
      }
      const lightCoverage = 1 - darkCoverage;
      const p = (rowOffset + opts.x + px) * 4;
      buf.data[p] = Math.round(dark[0] * darkCoverage + light[0] * lightCoverage);
      buf.data[p + 1] = Math.round(dark[1] * darkCoverage + light[1] * lightCoverage);
      buf.data[p + 2] = Math.round(dark[2] * darkCoverage + light[2] * lightCoverage);
      buf.data[p + 3] = 255;
    }
  }

  return { cardX, cardY, cardW, cardH };
}

function boxBlurRegion(buf: CanvasBuf, x0: number, y0: number, w: number, h: number): void {
  const copy = new Uint8ClampedArray(buf.data);
  const rx0 = Math.max(1, Math.floor(x0));
  const ry0 = Math.max(1, Math.floor(y0));
  const rx1 = Math.min(buf.width - 2, Math.ceil(x0 + w));
  const ry1 = Math.min(buf.height - 2, Math.ceil(y0 + h));

  for (let y = ry0; y <= ry1; y++) {
    for (let x = rx0; x <= rx1; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const row = (y + dy) * buf.width;
        for (let dx = -1; dx <= 1; dx++) {
          const p = (row + x + dx) * 4;
          sr += copy[p]!;
          sg += copy[p + 1]!;
          sb += copy[p + 2]!;
        }
      }
      const dst = (y * buf.width + x) * 4;
      buf.data[dst] = Math.round(sr / 9);
      buf.data[dst + 1] = Math.round(sg / 9);
      buf.data[dst + 2] = Math.round(sb / 9);
    }
  }
}

describe('decodePairingQr multi-pass screenshot locator & decoder', () => {
  // Realistic ~580-char DSPAIR1 payload matching AES-GCM encrypted WebDAV + credentials + sync prefs (QR Version 16, 81x81 modules)
  const sampleDenseCode = `DSPAIR1:${'QWERTYUIOPASDFGHJKLZXCVBNM0123456789-_'.repeat(15)}`;
  const sampleMediumCode =
    'DSPAIR1:eyJ2IjoxLCJwcm92aWRlciI6IndlYmRhdiIsImVuZHBvaW50IjoiaHR0cHM6Ly9kYXYuZXhhbXBsZS5jb20vc3luYyIsInVzZXIiOiJkZXNrdG9wIn0';

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).BarcodeDetector;
  });

  it('decodes a dense anti-aliased DSPAIR1 QR card embedded off-center in a full 1440x900 dark-mode desktop screenshot', async () => {
    const screenBuf = createBuffer(1440, 900, 15, 20, 30);
    paintDesktopChrome(screenBuf, true);

    // Real-world 1x desktop rendering: dense ~580-char DSPAIR1 QR rasterized with subpixel anti-aliasing at 196x196
    // inside a white card off-center in the right panel (exact layout of DevicePairingSection)
    drawQrMatrix(screenBuf, sampleDenseCode, {
      x: 1096,
      y: 265,
      size: 196,
      quietModules: 3,
      cardPaddingPx: 10,
      antiAliased: true,
    });

    // Confirm raw single-pass jsQR fails on this realistic full dark-mode desktop screenshot
    expect(jsQR(screenBuf.data, screenBuf.width, screenBuf.height)).toBeNull();

    const regions = locatePairingQrRegions(screenBuf.data, screenBuf.width, screenBuf.height);
    expect(regions.length).toBeGreaterThan(0);

    const decoded = await decodePairingPixels(screenBuf.data, screenBuf.width, screenBuf.height);
    expect(decoded).toBe(sampleDenseCode);
  });

  it('decodes a centered tall white modal card inside a 1440x900 dark-mode screenshot', async () => {
    const screenBuf = createBuffer(1440, 900, 14, 18, 28);
    paintDesktopChrome(screenBuf, true);

    // Tall white modal dialog (width 300, height 520) with QR code in the upper square & fake PIN/textarea lines below
    fillRect(screenBuf, 570, 180, 300, 520, 250, 251, 253);
    drawQrMatrix(screenBuf, sampleMediumCode, {
      x: 615,
      y: 210,
      size: 210,
      quietModules: 3,
      cardPaddingPx: 0,
    });
    // Fake PIN digits + encrypted code text block inside lower half of the same white modal
    fillRect(screenBuf, 645, 455, 150, 22, 30, 41, 59);
    for (let i = 0; i < 6; i++) {
      fillRect(screenBuf, 600, 505 + i * 24, 240, 10, 100, 116, 139);
    }

    const decoded = await decodePairingPixels(screenBuf.data, screenBuf.width, screenBuf.height);
    expect(decoded).toBe(sampleMediumCode);
  });

  it('decodes a small dense QR code inside a 1440x900 light-mode desktop screenshot (no dark backdrop)', async () => {
    const screenBuf = createBuffer(1440, 900, 248, 250, 252);
    paintDesktopChrome(screenBuf, false);

    // White card on near-white page, placed off-center in the right panel
    drawQrMatrix(screenBuf, sampleMediumCode, {
      x: 1080,
      y: 310,
      size: 204,
      quietModules: 3,
      cardPaddingPx: 8,
    });

    expect(jsQR(screenBuf.data, screenBuf.width, screenBuf.height)).toBeNull();

    const decoded = await decodePairingPixels(screenBuf.data, screenBuf.width, screenBuf.height);
    expect(decoded).toBe(sampleMediumCode);
  });

  it('decodes a 2880x1800 Retina dark-mode desktop screenshot containing a dense DSPAIR1 QR card', async () => {
    const retinaBuf = createBuffer(2880, 1800, 16, 21, 32);
    paintDesktopChrome(retinaBuf, true);

    drawQrMatrix(retinaBuf, sampleDenseCode, {
      x: 2160,
      y: 520,
      size: 400,
      quietModules: 3,
      cardPaddingPx: 20,
    });

    const decoded = await decodePairingPixels(retinaBuf.data, retinaBuf.width, retinaBuf.height);
    expect(decoded).toBe(sampleDenseCode);
  });

  it('recovers anti-aliased, slightly blurred, low-contrast QR screenshots via high-contrast binarization', async () => {
    const screenBuf = createBuffer(1280, 800, 20, 26, 38);
    paintDesktopChrome(screenBuf, true);

    // Render slightly low-contrast (dark gray on off-white) and apply 3x3 blur to simulate anti-aliased screenshot scaling
    const card = drawQrMatrix(screenBuf, sampleMediumCode, {
      x: 840,
      y: 230,
      size: 260,
      quietModules: 4,
      cardPaddingPx: 14,
      darkRgb: [58, 66, 82],
      lightRgb: [224, 228, 234],
    });
    boxBlurRegion(screenBuf, card.cardX, card.cardY, card.cardW, card.cardH);

    const decoded = await decodePairingPixels(screenBuf.data, screenBuf.width, screenBuf.height);
    expect(decoded).toBe(sampleMediumCode);
  });

  it('rescues a tightly cropped small dense QR screenshot with zero quiet zone via padding and upscaling', async () => {
    // 144x144 dense QR (~61x61 modules -> ~2.36px/module) with 0 quiet zone and subpixel anti-aliasing
    const tightBuf = createBuffer(144, 144, 15, 23, 42);
    drawQrMatrix(tightBuf, sampleDenseCode, {
      x: 0,
      y: 0,
      size: 144,
      quietModules: 0,
      cardPaddingPx: 0,
      antiAliased: true,
    });

    // Raw single-pass jsQR fails on a tightly cropped small anti-aliased dense QR with zero quiet zone
    expect(jsQR(tightBuf.data, tightBuf.width, tightBuf.height)).toBeNull();

    const decoded = await decodePairingPixels(tightBuf.data, tightBuf.width, tightBuf.height);
    expect(decoded).toBe(sampleDenseCode);
  });

  it('decodes dark-mode inverted QR codes (light modules on dark card) and dense DSPAIR2 packets', async () => {
    const dspair2Packet = `DSPAIR2.${'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-'.repeat(7)}`;
    const screenBuf = createBuffer(1440, 900, 18, 24, 36);
    paintDesktopChrome(screenBuf, true);

    drawQrMatrix(screenBuf, dspair2Packet, {
      x: 560,
      y: 260,
      size: 280,
      quietModules: 4,
      cardPaddingPx: 12,
      darkRgb: [245, 248, 255],
      lightRgb: [15, 23, 42],
    });

    const decoded = await decodePairingPixels(screenBuf.data, screenBuf.width, screenBuf.height);
    expect(decoded).toBe(dspair2Packet);
  });

  it('returns null cleanly for non-QR screenshots and QR codes containing non-pairing URLs', async () => {
    const noQrBuf = createBuffer(800, 500, 24, 30, 42);
    paintDesktopChrome(noQrBuf, true);
    expect(await decodePairingPixels(noQrBuf.data, noQrBuf.width, noQrBuf.height)).toBeNull();

    const urlQrBuf = createBuffer(260, 260, 255, 255, 255);
    drawQrMatrix(urlQrBuf, 'https://example.com/not-a-pairing-code', {
      x: 10,
      y: 10,
      size: 240,
      quietModules: 4,
    });
    expect(await decodePairingPixels(urlQrBuf.data, urlQrBuf.width, urlQrBuf.height)).toBeNull();
  });

  it('extracts DSPAIR1 and DSPAIR2 payloads cleanly while rejecting unrelated strings', () => {
    expect(extractPairingCode(`prefix ${sampleMediumCode} suffix`)).toBe(sampleMediumCode);
    expect(extractPairingCode('DSPAIR1:abc\n def_123')).toBe('DSPAIR1:abc');
    expect(extractPairingCode('DSPAIR2.abcdefghij123456')).toBe('DSPAIR2.abcdefghij123456');
    expect(extractPairingCode('https://example.com')).toBeNull();
  });

  it('decodes exported SVG files directly via decodePairingImage', async () => {
    const svg = renderQrCodeSvgString(sampleMediumCode);
    const file = new File([svg], 'deepstudent-sync-qr.svg', { type: 'image/svg+xml' });
    await expect(decodePairingImage(file)).resolves.toBe(sampleMediumCode);
  });

  it('uses native BarcodeDetector fast path in decodePairingFrame when available and falls back safely on errors', async () => {
    const detectMock = vi.fn().mockResolvedValue([{ rawValue: sampleMediumCode }]);
    (globalThis as Record<string, unknown>).BarcodeDetector = class MockBarcodeDetector {
      detect = detectMock;
    };

    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(),
    } as unknown as HTMLCanvasElement;
    const fakeSource = {} as CanvasImageSource;

    const detected = await decodePairingFrame(fakeCanvas, fakeSource, 1440, 900);
    expect(detected).toBe(sampleMediumCode);
    expect(detectMock).toHaveBeenCalledWith(fakeSource);
    expect(fakeCanvas.getContext).not.toHaveBeenCalled();

    // When BarcodeDetector throws, decodePairingFrame falls back cleanly to canvas + jsQR
    const throwingDetect = vi.fn().mockRejectedValue(new Error('not supported'));
    (globalThis as Record<string, unknown>).BarcodeDetector = class ThrowingBarcodeDetector {
      detect = throwingDetect;
    };

    const buf = createBuffer(260, 260, 255, 255, 255);
    drawQrMatrix(buf, sampleMediumCode, { x: 10, y: 10, size: 240, quietModules: 4 });
    const mockCtx = {
      imageSmoothingEnabled: true,
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: buf.data, width: buf.width, height: buf.height })),
    };
    const fallbackCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => mockCtx),
    } as unknown as HTMLCanvasElement;

    const fallbackDecoded = await decodePairingFrame(fallbackCanvas, fakeSource, 260, 260);
    expect(fallbackDecoded).toBe(sampleMediumCode);
    expect(throwingDetect).toHaveBeenCalledTimes(1);
    expect(mockCtx.drawImage).toHaveBeenCalledTimes(1);
  });
});
