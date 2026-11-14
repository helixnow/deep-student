/** `node:fs/promises` 占位，语义见 `./fs.ts`。 */
import { constants, promises } from './fs.ts';

export const { readFile, readdir, stat, lstat, access, realpath, writeFile, appendFile, chmod, rmdir, mkdtemp, mkdir, rm, unlink, rename, copyFile, open } = promises;
export { constants };
export default { ...promises, constants };
