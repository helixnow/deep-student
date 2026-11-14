/**
 * Portable equivalent of Node's `http.validateHeaderValue`: a missing value or
 * any character outside `\t`, 0x20–0x7e and 0x80–0xff throws a `TypeError`
 * (callers surface `error.name`, which Node also reports as `TypeError`).
 */
export function validateHeaderValue(name: string, value: string | undefined): void {
  if (value === undefined) throw new TypeError(`Invalid value "undefined" for header "${name}"`);
  if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) throw new TypeError(`Invalid character in header content ["${name}"]`);
}
