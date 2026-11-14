import type { QuestionType } from '../api.ts';
import { jsonValueAsF64 } from './raw-json-number.ts';

// question_bank_service.rs:1036-1559. Tuple = (is_correct, needs_manual_grading).
type Grade = [boolean, boolean];
const trim = (value: string) => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
const whitespace = (char: string) => /\p{White_Space}/u.test(char);
const fullwidth = (value: string) => value.replace(/[\u3000\uFF01-\uFF5E]/gu, char =>
  char === '\u3000' ? ' ' : String.fromCodePoint(char.codePointAt(0)! - 0xFEE0));
const sequenceKey = (key: string) => trim(fullwidth(key)).toUpperCase();
const alphanumeric = (value: string) => [...fullwidth(value).toUpperCase()]
  .filter(char => /[\p{Alphabetic}\p{Number}]/u.test(char));
const equal = (a: string[], b: string[]) => a.length === b.length && a.every((value, i) => value === b[i]);
const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

function json(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function extractChoiceKeys(answer: string): string[] | null {
  const chars = [...trim(fullwidth(answer))];
  if (!chars.length) return null;
  if (chars.every(char => /^[A-Za-z]$/u.test(char) || whitespace(char) || ',，、;；/和与'.includes(char))) {
    const letters = chars.filter(char => /^[A-Za-z]$/u.test(char)).map(char => char.toUpperCase());
    const keys = [...new Set(letters)].sort();
    return keys.length > 0 && keys.length <= 8 && keys.length === letters.length ? keys : null;
  }
  const keys = new Set<string>();
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    if (!/^[A-Za-z]$/u.test(char)) continue;
    const left = i === 0 || whitespace(chars[i - 1]!) || '（(，,、;；:：选'.includes(chars[i - 1]!);
    const right = i + 1 === chars.length || '．.、:：)）。'.includes(chars[i + 1]!);
    if (left && right) keys.add(char.toUpperCase());
  }
  return keys.size > 0 && keys.size <= 8 ? [...keys].sort() : null;
}

function boolAnswer(raw: string): boolean | null {
  const normalized = trim(fullwidth(raw)).toLowerCase();
  if (['true', 't', '1', 'yes', 'y', '对', '正确', '是', '真', '√', '✓', '✔'].includes(normalized)) return true;
  if (['false', 'f', '0', 'no', 'n', '错', '错误', '否', '假', '不对', '×', '✗', '✘', 'x'].includes(normalized)) return false;
  return null;
}

export function parseNumericInput(raw: string): number | null {
  const chars = [...fullwidth(raw).replaceAll(',', '')];
  const digit = (char: string | undefined) => char !== undefined && /^[0-9]$/u.test(char);
  function parseAt(start: number): [number, number] | null {
    let i = start;
    let token = '';
    if (chars[i] === '+' || chars[i] === '-') token += chars[i++];
    let seenDigit = false;
    let seenDot = false;
    let seenExp = false;
    while (i < chars.length) {
      const char = chars[i]!;
      if (digit(char)) {
        seenDigit = true;
        token += char;
        i++;
      } else if (char === '.' && !seenDot && !seenExp) {
        seenDot = true;
        token += char;
        i++;
      } else if ((char === 'e' || char === 'E') && seenDigit && !seenExp) {
        let j = i + 1;
        if (chars[j] === '+' || chars[j] === '-') j++;
        if (!digit(chars[j])) break;
        seenExp = true;
        token += 'e';
        if (chars[i + 1] === '+' || chars[i + 1] === '-') token += chars[i + 1];
        i = j;
      } else break;
    }
    return seenDigit ? [Number(token), i] : null;
  }
  const start = chars.findIndex((char, i) => digit(char)
    || (['+', '-', '.'].includes(char) && digit(chars[i + 1]))
    || ((char === '+' || char === '-') && chars[i + 1] === '.' && digit(chars[i + 2])));
  if (start < 0) return null;
  const parsed = parseAt(start);
  if (!parsed) return null;
  const [value, end] = parsed;
  let j = end;
  while (j < chars.length && whitespace(chars[j]!)) j++;
  if (chars[j] === '/') {
    j++;
    while (j < chars.length && whitespace(chars[j]!)) j++;
    const denominator = parseAt(j);
    if (denominator) return denominator[0] !== 0 ? value / denominator[0] : null;
  }
  return value;
}

function gradeNumeric(user: string, correct: string | null, sd: Record<string, unknown>): Grade {
  const answerValue = jsonValueAsF64(sd.answer_value);
  if (answerValue !== null) {
    const value = parseNumericInput(user);
    if (value === null) return [false, false];
    const tolerance = Math.abs(jsonValueAsF64(sd.tolerance) ?? 0);
    const mode = typeof sd.tolerance_mode === 'string' ? sd.tolerance_mode : 'absolute';
    const limit = mode.replace(/[A-Z]/gu, char => char.toLowerCase()) === 'relative' ? tolerance * Math.abs(answerValue) : tolerance;
    const epsilon = Number.EPSILON * Math.max(Math.abs(answerValue), 1) * 4;
    return [Math.abs(value - answerValue) <= limit + epsilon, false];
  }
  if (correct === null) return [false, true];
  const value = parseNumericInput(user);
  const answer = parseNumericInput(correct);
  if (answer === null) return [false, true];
  return [value !== null && Math.abs(value - answer) <= 1e-9 * Math.max(Math.abs(answer), 1), false];
}

function parseSequence(raw: string): string[] | null {
  const text = trim(raw);
  if (!text) return null;
  const items = json(text);
  if (Array.isArray(items)) {
    if (!items.length || items.some(item => typeof item !== 'string' && typeof item !== 'number')) return null;
    return items.map(String);
  }
  const parts = fullwidth(text).replaceAll('->', ',').replaceAll('→', ',').replaceAll('⇒', ',')
    .split(/[,;、，；| ]/u).map(trim).filter(Boolean);
  return parts.length ? parts : null;
}

function pairs(value: unknown): [string, string][] | null {
  const array = Array.isArray(value) ? value : object(value).pairs;
  if (!Array.isArray(array)) return null;
  const result: [string, string][] = [];
  for (const item of array) {
    const { left, right } = object(item);
    if (typeof left !== 'string' || typeof right !== 'string') return null;
    result.push([left, right]);
  }
  return result;
}

function gradeMatching(user: string, sd: unknown): Grade {
  const correct = pairs(sd);
  if (!correct?.length) return [false, true];
  const input = pairs(json(trim(user)));
  if (!input) return [false, false];
  const normalize = (values: [string, string][]) => values.map(([l, r]) => [sequenceKey(l), sequenceKey(r)] as [string, string]);
  const correctSet = normalize(correct).filter((pair, i, all) => all.findIndex(([l, r]) => l === pair[0] && r === pair[1]) === i);
  const userSet = normalize(input).filter((pair, i, all) => all.findIndex(([l, r]) => l === pair[0] && r === pair[1]) === i);
  return [input.length === userSet.length && userSet.length === correctSet.length
    && userSet.every(([l, r]) => correctSet.some(([cl, cr]) => l === cl && r === cr)), false];
}

export function checkAnswerCorrectness(userAnswer: string, correctAnswer: string | null, questionType: QuestionType, structuredData: unknown = null): Grade {
  const user = trim(userAnswer);
  const correct = correctAnswer === null ? null : trim(correctAnswer) || null;
  const sd = object(structuredData);
  switch (questionType) {
    case 'single_choice':
    case 'multiple_choice':
    case 'indefinite_choice': {
      if (correct === null) return [false, true];
      const a = alphanumeric(user);
      const b = alphanumeric(correct);
      if (questionType !== 'single_choice') { a.sort(); b.sort(); }
      let isCorrect = equal(a, b);
      if (!isCorrect) {
        const userKeys = extractChoiceKeys(user);
        const correctKeys = extractChoiceKeys(correct);
        if (userKeys && correctKeys) isCorrect = equal(userKeys, correctKeys);
      }
      return [isCorrect, false];
    }
    case 'true_false': {
      if (correct === null) return [false, true];
      const a = boolAnswer(user);
      const b = boolAnswer(correct);
      return b === null ? [false, true] : [a !== null && a === b, false];
    }
    case 'numeric': return gradeNumeric(user, correct, sd);
    case 'ordering': {
      let answer = Array.isArray(sd.correct_order) ? sd.correct_order.filter((item): item is string => typeof item === 'string') : null;
      if (!answer?.length) answer = correct === null ? null : parseSequence(correct);
      if (!answer) return [false, true];
      const input = parseSequence(user);
      return [input !== null && equal(input.map(sequenceKey), answer.map(sequenceKey)), false];
    }
    case 'matching': return gradeMatching(user, structuredData);
    case 'fill_blank':
    case 'short_answer':
    case 'essay':
    case 'calculation':
    case 'proof': return [false, true];
    case 'other': {
      if (correct === null) return [false, true];
      return user.toLowerCase() === correct.toLowerCase() ? [true, false] : [false, true];
    }
  }
}
