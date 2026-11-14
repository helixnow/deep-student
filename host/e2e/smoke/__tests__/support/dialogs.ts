/**
 * Answer the next native file dialog from the Electron main process (X1 `dialog-answer.mjs` approach, extended
 * to save dialogs). The shell dialog plugin, its scope grant and every IPC stay production; only the OS
 * chooser's answer is supplied. Each stub answers once and restores the original.
 */
import type { LaunchedApp } from './app.ts';

export interface DialogCall { kind: 'save' | 'open'; answer: string | string[] }

export async function answerNextSaveDialog(app: LaunchedApp, filePath: string): Promise<void> {
  await app.app.evaluate(({ dialog }, filePath) => {
    const g = globalThis as unknown as { __w12DialogCalls?: Array<{ kind: string; answer: unknown }> };
    g.__w12DialogCalls ??= [];
    const original = dialog.showSaveDialog;
    dialog.showSaveDialog = (async () => {
      dialog.showSaveDialog = original;
      g.__w12DialogCalls!.push({ kind: 'save', answer: filePath });
      return { canceled: false, filePath };
    }) as typeof dialog.showSaveDialog;
  }, filePath);
}

export async function answerNextOpenDialog(app: LaunchedApp, filePaths: string[]): Promise<void> {
  await app.app.evaluate(({ dialog }, filePaths) => {
    const g = globalThis as unknown as { __w12DialogCalls?: Array<{ kind: string; answer: unknown }> };
    g.__w12DialogCalls ??= [];
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = (async () => {
      dialog.showOpenDialog = original;
      g.__w12DialogCalls!.push({ kind: 'open', answer: filePaths });
      return { canceled: false, filePaths };
    }) as typeof dialog.showOpenDialog;
  }, filePaths);
}

export async function dialogCalls(app: LaunchedApp): Promise<DialogCall[]> {
  return app.app.evaluate(() => ((globalThis as unknown as { __w12DialogCalls?: DialogCall[] }).__w12DialogCalls ?? []));
}
