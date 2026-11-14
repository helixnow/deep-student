/** `ulid::Ulid::new()`: 26-char Crockford Base32 (48-bit ms timestamp + 80 random bits). */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(time: number = Date.now()): string {
  let out = '';
  let t = BigInt(time);
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[Number(t & 31n)] + out;
    t >>= 5n;
  }
  let random = 0n;
  for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(10))) random = (random << 8n) | BigInt(byte);
  let tail = '';
  for (let i = 0; i < 16; i++) {
    tail = ALPHABET[Number(random & 31n)] + tail;
    random >>= 5n;
  }
  return out + tail;
}
