/** nanoid's default URL-safe alphabet and 10-character IDs used by the Rust crate. */
const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

export function nanoid(size: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let value = '';
  for (let index = 0; index < size; index += 1) value += ALPHABET[bytes[index]! & 63];
  return value;
}
