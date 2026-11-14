declare module 'pngjs' {
  interface PNGOptions { width: number; height: number; colorType?: number; inputColorType?: number; bitDepth?: number; inputHasAlpha?: boolean }
  export class PNG {
    constructor(options: PNGOptions);
    data: Buffer;
    static sync: { write(png: PNG, options?: Omit<PNGOptions, 'width' | 'height'>): Buffer };
  }
}
