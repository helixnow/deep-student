// Tokenize SQL, dropping comments and string values; quoted identifiers remain tokens.
export function sqlTokens(text) {
  const out = [];
  const re = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][\w$]*|[.;()]/g;
  for (const m of text.matchAll(re)) {
    if (/^(--|\/\*|')/.test(m[0])) continue;
    out.push({ value: m[0].replace(/^["`\[]|["`\]]$/g, '').toLowerCase(), offset: m.index });
  }
  return out;
}
export function sqlTables(text, schema = false) {
  const t = sqlTokens(text), out = [];
  for (let i = 0; i < t.length; i++) {
    let j = i + 1;
    const op = t[i].value;
    if (schema) {
      if (op !== 'create') continue;
      if (t[j]?.value === 'virtual' || t[j]?.value === 'temp' || t[j]?.value === 'temporary') j++;
      if (t[j++]?.value !== 'table') continue;
      if (t[j]?.value === 'if') j += 3;
    } else if (op === 'insert' || op === 'replace' || op === 'upsert') {
      if (t[j]?.value === 'or') j += 2;
      if (t[j++]?.value !== 'into') continue;
    } else if (op === 'delete') {
      if (t[j++]?.value !== 'from') continue;
    } else if (op === 'update') {
      if (t[j]?.value === 'or') j += 2;
      if (t[j]?.value === 'set') continue; // ON CONFLICT DO UPDATE SET
    } else continue;
    if (t[j + 1]?.value === '.') j += 2;
    const table = t[j]?.value;
    if (!schema && op === 'update' && t[j + 1]?.value !== 'set' && t[j + 2]?.value !== 'set' && t[j + 3]?.value !== 'set') continue;
    if (table && /^[a-z_]\w*$/.test(table)) out.push({ table, operation: op.toUpperCase(), offset: t[i].offset });
  }
  return out;
}
