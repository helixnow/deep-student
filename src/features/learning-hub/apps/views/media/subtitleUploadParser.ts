function pad2(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

function pad3(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(3, '0');
}

export function formatSrtTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)},${pad3(millis)}`;
}

function parseClockMs(raw: string): number | null {
  const normalized = raw.trim().replace(',', '.');
  const match = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(normalized)
    ?? /^(?:0*:)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(normalized);
  if (!match) return null;

  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  let frac = '';
  if (match.length === 5) {
    hours = Number(match[1]);
    minutes = Number(match[2]);
    seconds = Number(match[3]);
    frac = match[4] ?? '';
  } else {
    minutes = Number(match[1]);
    seconds = Number(match[2]);
    frac = match[3] ?? '';
  }
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  const millis = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;
  return ((hours * 3600 + minutes * 60 + seconds) * 1000) + (Number.isFinite(millis) ? millis : 0);
}

function cleanAssText(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N|\\n/g, '\n')
    .replace(/\\h/g, ' ')
    .trim();
}

export function convertAssToSrt(raw: string): string {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  const cues: Array<{ startMs: number; endMs: number; text: string }> = [];
  let textFieldIndex = 9;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^Format:/i.test(trimmed)) {
      const fields = trimmed
        .slice(7)
        .split(',')
        .map((field) => field.trim().toLowerCase());
      const idx = fields.indexOf('text');
      if (idx >= 0) textFieldIndex = idx;
      continue;
    }
    if (!/^Dialogue:/i.test(trimmed)) continue;
    const payload = trimmed.slice(9).trim();
    const parts: string[] = [];
    let cursor = 0;
    for (let i = 0; i < textFieldIndex; i += 1) {
      const comma = payload.indexOf(',', cursor);
      if (comma < 0) break;
      parts.push(payload.slice(cursor, comma).trim());
      cursor = comma + 1;
    }
    const textRaw = cursor < payload.length ? payload.slice(cursor) : '';
    const startMs = parseClockMs(parts[1] ?? '');
    const endMs = parseClockMs(parts[2] ?? '');
    const text = cleanAssText(textRaw);
    if (startMs !== null && endMs !== null && endMs > startMs && text) {
      cues.push({ startMs, endMs, text });
    }
  }

  return cues
    .map((cue, idx) => `${idx + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${cue.text}`)
    .join('\n\n');
}

export function convertTxtToSrt(raw: string): string {
  const cleaned = raw.replace(/^\uFEFF/, '').trim();
  if (!cleaned) return '';
  // 已经是 SRT/VTT 箭头时间戳时保留原格式
  if (/^\d{0,2}:?\d{2}:\d{2}[,.]\d{2,3}\s+-->\s+/m.test(cleaned)) {
    return cleaned;
  }

  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';

  const timestamped: Array<{ startMs: number; endMs?: number; text: string }> = [];
  const linePattern = /^\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]?(?:\s*[-~–—>]+\s*\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]?)?\s*(.+)$/;
  let matchedTimestampCount = 0;
  for (const line of lines) {
    const m = linePattern.exec(line);
    if (m) {
      const startMs = parseClockMs(m[1]);
      const endMs = m[2] ? parseClockMs(m[2]) ?? undefined : undefined;
      const text = m[3].trim();
      if (startMs !== null && text) {
        matchedTimestampCount += 1;
        timestamped.push({ startMs, endMs, text });
        continue;
      }
    }
    if (timestamped.length > 0) {
      timestamped[timestamped.length - 1]!.text += `\n${line}`;
    }
  }

  if (matchedTimestampCount > 0 && timestamped.length > 0) {
    return timestamped
      .map((entry, index) => {
        const nextStart = timestamped[index + 1]?.startMs;
        const endMs =
          entry.endMs && entry.endMs > entry.startMs
            ? entry.endMs
            : nextStart && nextStart > entry.startMs
              ? nextStart
              : entry.startMs + 4000;
        return `${index + 1}\n${formatSrtTime(entry.startMs)} --> ${formatSrtTime(endMs)}\n${entry.text}`;
      })
      .join('\n\n');
  }

  // 纯文本按行切分为顺序字幕段（每段 4 秒）
  return lines
    .map((line, index) => {
      const startMs = index * 4000;
      const endMs = startMs + 4000;
      return `${index + 1}\n${formatSrtTime(startMs)} --> ${formatSrtTime(endMs)}\n${line}`;
    })
    .join('\n\n');
}

async function readBlobText(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read subtitle file'));
      reader.readAsText(blob);
    });
  }
  if (typeof (blob as { text?: unknown }).text === 'function') {
    return (blob as { text: () => Promise<string> }).text();
  }
  return new Response(blob).text();
}

export const UNSUPPORTED_SUBTITLE_FORMAT_ERROR =
  'This file type is not a recognized subtitle format. Supported formats: .srt, .vtt, .ass, .txt, .json';

const PASSTHROUGH_SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.json', '.bcc'] as const;
const CONVERTIBLE_SUBTITLE_EXTENSIONS = ['.ass', '.ssa', '.txt'] as const;

export function isSupportedSubtitleFileName(fileName: string): boolean {
  const lower = fileName.trim().toLowerCase();
  return (
    PASSTHROUGH_SUBTITLE_EXTENSIONS.some((ext) => lower.endsWith(ext)) ||
    CONVERTIBLE_SUBTITLE_EXTENSIONS.some((ext) => lower.endsWith(ext))
  );
}

export async function normalizeSubtitleFileForImport(file: File): Promise<File> {
  const lower = file.name.trim().toLowerCase();
  if (PASSTHROUGH_SUBTITLE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return file;
  }
  if (!CONVERTIBLE_SUBTITLE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    throw new Error(UNSUPPORTED_SUBTITLE_FORMAT_ERROR);
  }
  const raw = await readBlobText(file);
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Subtitle file is empty');
  }
  const baseName = file.name.replace(/\.[^.]+$/, '') || 'subtitles';
  if (lower.endsWith('.ass') || lower.endsWith('.ssa')) {
    const converted = convertAssToSrt(raw);
    if (!converted) {
      throw new Error('No subtitle dialogue entries found in ASS/SSA file');
    }
    return new File([converted], `${baseName}.srt`, { type: 'text/plain;charset=utf-8' });
  }
  if (/^WEBVTT/i.test(trimmed)) {
    return new File([raw], `${baseName}.vtt`, { type: 'text/vtt;charset=utf-8' });
  }
  const converted = convertTxtToSrt(raw);
  if (!converted) {
    throw new Error('Subtitle file is empty');
  }
  return new File([converted], `${baseName}.srt`, { type: 'text/plain;charset=utf-8' });
}
