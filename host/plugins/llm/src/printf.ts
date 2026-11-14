/**
 * `node:util` 的两处可移植替代：printf 风格格式化与 MIME 参数解析。
 *
 * - `formatMessage` 对应 `util.format` 在本插件里的用法（`%s` `%d` `%i` `%f`
 *   `%j` `%o` `%O` `%c` `%%`，多余的参数按空格追加）；日志文本不作为数据使用，
 *   对象一律按 JSON 投影，不追求 `util.inspect` 的逐字外观。
 * - `mimeCharset` 对应 `new MIMEType(type).params.get('charset')`：只取 charset
 *   参数，未给出或类型不合法时返回 null。
 */

function inspectValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function numeric(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value);
}

/** `util.format(message, ...args)` 的可移植子集。 */
export function formatMessage(message: string, ...args: unknown[]): string {
  let index = 0;
  const replaced = message.replace(/%([sdifjoOc%])/g, (match, specifier: string) => {
    if (specifier === '%') return '%';
    if (index >= args.length) return match;
    const value = args[index++];
    switch (specifier) {
      case 's': return typeof value === 'string' ? value : inspectValue(value);
      case 'd': return String(typeof value === 'bigint' ? value : Math.trunc(numeric(value)));
      case 'i': return String(Number.parseInt(String(value), 10));
      case 'f': return String(Number.parseFloat(String(value)));
      case 'j': return inspectValue(value);
      case 'o':
      case 'O': return inspectValue(value);
      default: return ''; // %c：CSS 占位，Node 不输出内容。
    }
  });
  if (index >= args.length) return replaced;
  return `${replaced} ${args.slice(index).map(inspectValue).join(' ')}`;
}

/** `new MIMEType(type).params.get('charset')`：参数名大小写不敏感，值可带引号。 */
export function mimeCharset(contentType: string): string | null {
  const [type, ...parameters] = contentType.split(';');
  if (!type || !/^\s*[^\s/]+\/[^\s/]+\s*$/.test(type)) return null;
  for (const parameter of parameters) {
    const separator = parameter.indexOf('=');
    if (separator < 0) continue;
    if (parameter.slice(0, separator).trim().toLowerCase() !== 'charset') continue;
    const raw = parameter.slice(separator + 1).trim();
    const value = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    return value === '' ? null : value;
  }
  return null;
}
