export const ICON_SOURCE: string;
export const ICON_DIR: string;
/** `[OSType, 边长]`。 */
export const ICNS_ENTRIES: ReadonlyArray<readonly [string, number]>;
export const ICO_SIZES: readonly number[];
export const LINUX_SIZES: readonly number[];
export function icns(source: Buffer): Promise<Buffer>;
export function ico(source: Buffer): Promise<Buffer>;
