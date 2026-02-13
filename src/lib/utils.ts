// 轻量 cn 实现，避免依赖外部包
export type ClassValue = string | number | null | false | undefined | ClassDictionary | ClassArray;
export interface ClassDictionary { [id: string]: any }
export interface ClassArray extends Array<ClassValue> {}

function toVal(mix: ClassValue): string {
  let k: any, y: any, str='';
  if (typeof mix === 'string' || typeof mix === 'number') return '' + mix;
  if (Array.isArray(mix)) {
    for (k = 0; k < mix.length; k++) {
      if (mix[k]) {
        y = toVal(mix[k]);
        if (y) str && (str += ' '), str += y;
      }
    }
    return str;
  }
  if (mix && typeof mix === 'object') {
    for (k in mix) {
      if (mix[k]) str && (str += ' '), str += k;
    }
  }
  return str;
}

export function cn(...inputs: ClassValue[]) {
  return inputs.map(toVal).filter(Boolean).join(' ');
}
