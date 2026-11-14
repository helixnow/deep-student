declare module 'upng-js' {
  interface Png { width: number; height: number }
  const UPNG: {
    encode(frames: ArrayBuffer[], width: number, height: number, colors: number): ArrayBuffer;
    decode(data: ArrayBuffer): Png;
    toRGBA8(png: Png): ArrayBuffer[];
  };
  export default UPNG;
}
