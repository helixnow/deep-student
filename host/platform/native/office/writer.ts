import type { NativeOfficeWriter } from './api.ts';

export function createOfficeWriter(warn: (message: string) => void): NativeOfficeWriter {
  return {
    async generateDocx(spec) { return (await import('./docx.ts')).generateDocx(spec); },
    async generatePptx(spec) { return (await import('./pptx.ts')).generatePptx(spec); },
    async generateXlsx(spec) { return (await import('./xlsx.ts')).generateXlsx(spec); },
    async editXlsxCells(bytes, edits) { return (await import('./xlsx.ts')).editXlsxCells(bytes, edits, warn); },
    async readXlsxSpec(bytes) { return (await import('./xlsx-reader.ts')).readXlsxSpec(bytes); },
    async readXlsxTables(bytes) { return (await import('./xlsx-reader.ts')).readXlsxTables(bytes); },
    async readXlsxMetadata(bytes) { return (await import('./xlsx-reader.ts')).readXlsxMetadata(bytes); },
    async replaceXlsxText(bytes, replacements) { return (await import('./xlsx-reader.ts')).replaceXlsxText(bytes, replacements); },
  };
}
