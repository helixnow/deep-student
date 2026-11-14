// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickBackupFile } from '../../src/shell/backup-picker.ts';

afterEach(() => { document.body.replaceChildren(); });

function selectFile(read: () => Promise<ArrayBuffer>) {
  const input = document.querySelector('input')!;
  Object.defineProperty(input, 'files', { value: [{ name: 'backup.zip', arrayBuffer: read }] });
  input.dispatchEvent(new Event('change'));
}

describe('backup file picker', () => {
  it('rejects and removes the input when OPFS writing fails', async () => {
    const pending = pickBackupFile('/backup.zip', async () => { throw new Error('quota exceeded'); });
    const rejection = expect(pending).rejects.toThrow('quota exceeded');
    selectFile(async () => new ArrayBuffer(3));
    await rejection;
    await expect.poll(() => document.querySelector('input')).toBeNull();
  });

  it('rejects and cleans up a read failure', async () => {
    const write = vi.fn();
    const pending = pickBackupFile('/backup.zip', write);
    const rejection = expect(pending).rejects.toThrow('read failed');
    selectFile(async () => { throw new Error('read failed'); });
    await rejection;
    expect(write).not.toHaveBeenCalled();
    await expect.poll(() => document.querySelector('input')).toBeNull();
  });

  it('waits for the write before returning the selected file', async () => {
    const write = vi.fn(async () => undefined);
    const pending = pickBackupFile('/backup.zip', write);
    selectFile(async () => new Uint8Array([1, 2, 3]).buffer);
    await expect(pending).resolves.toEqual({ path: '/backup.zip', name: 'backup.zip', size: 3 });
    expect(write).toHaveBeenCalledWith('/backup.zip', new Uint8Array([1, 2, 3]));
  });
});
