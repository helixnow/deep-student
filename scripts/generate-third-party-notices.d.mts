export interface NoticeRecord {
  ecosystem: string;
  id: string;
  license: string;
  repository: string;
  legalFiles: Array<{ source: string; text: string }>;
}

export function collectNpmRecords(): NoticeRecord[];
