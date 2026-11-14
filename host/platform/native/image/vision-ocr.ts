import { execFile } from 'node:child_process';

/** The bundled Vision helper receives only the image over stdin; no temporary file or network. */
export function recognizeWithVision(executable: string, image: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, [], { timeout: 25_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.on('error', reject);
    child.stdin?.end(image);
  });
}
