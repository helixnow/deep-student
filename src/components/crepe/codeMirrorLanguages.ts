/**
 * Curated CodeMirror language descriptions aliased over `@codemirror/language-data`.
 *
 * `@milkdown/crepe` unconditionally imports all 143 languages from `@codemirror/language-data`
 * (~458 KiB gz across 114 lazy chunks, including 95 obscure legacy modes like cobol/brainfuck/z80).
 * Keeping ~30 common study & development languages cuts ~400 KiB gz and ~95 chunks while
 * preserving syntax highlighting for every language students and developers routinely write.
 */
import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from '@codemirror/language';

function legacy(parser: StreamParser<unknown>): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(parser));
}

export const languages: LanguageDescription[] = [
  // Native Lezer grammars already bundled by UnifiedCodeEditor / NoteSourceEditor (+ tiny lang-json)
  LanguageDescription.of({
    name: 'JavaScript',
    alias: ['ecmascript', 'js', 'node'],
    extensions: ['js', 'mjs', 'cjs'],
    load: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  }),
  LanguageDescription.of({
    name: 'TypeScript',
    alias: ['ts'],
    extensions: ['ts', 'mts', 'cts'],
    load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  }),
  LanguageDescription.of({
    name: 'JSX',
    extensions: ['jsx'],
    load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  }),
  LanguageDescription.of({
    name: 'TSX',
    extensions: ['tsx'],
    load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  }),
  LanguageDescription.of({
    name: 'HTML',
    alias: ['xhtml'],
    extensions: ['html', 'htm'],
    load: () => import('@codemirror/lang-html').then((m) => m.html()),
  }),
  LanguageDescription.of({
    name: 'CSS',
    alias: ['scss', 'less'],
    extensions: ['css', 'scss', 'less'],
    load: () => import('@codemirror/lang-css').then((m) => m.css()),
  }),
  LanguageDescription.of({
    name: 'JSON',
    alias: ['json5', 'jsonc'],
    extensions: ['json', 'map'],
    load: () => import('@codemirror/lang-json').then((m) => m.json()),
  }),
  LanguageDescription.of({
    name: 'Markdown',
    alias: ['md'],
    extensions: ['md', 'markdown', 'mkd'],
    load: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  }),

  // Lightweight StreamLanguage modes for study & mainstream development languages
  LanguageDescription.of({
    name: 'Python',
    alias: ['py', 'python3'],
    extensions: ['py', 'pyw'],
    load: () => import('@codemirror/legacy-modes/mode/python').then((m) => legacy(m.python)),
  }),
  LanguageDescription.of({
    name: 'C',
    extensions: ['c', 'h'],
    load: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.c)),
  }),
  LanguageDescription.of({
    name: 'C++',
    alias: ['cpp'],
    extensions: ['cpp', 'c++', 'cc', 'cxx', 'hpp', 'hxx'],
    load: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.cpp)),
  }),
  LanguageDescription.of({
    name: 'Java',
    extensions: ['java'],
    load: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.java)),
  }),
  LanguageDescription.of({
    name: 'C#',
    alias: ['csharp', 'cs'],
    extensions: ['cs'],
    load: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.csharp)),
  }),
  LanguageDescription.of({
    name: 'Kotlin',
    alias: ['kt'],
    extensions: ['kt', 'kts'],
    load: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.kotlin)),
  }),
  LanguageDescription.of({
    name: 'Objective-C',
    alias: ['objc'],
    extensions: ['mm'],
    load: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.objectiveC)),
  }),
  LanguageDescription.of({
    name: 'Scala',
    extensions: ['scala'],
    load: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.scala)),
  }),
  LanguageDescription.of({
    name: 'Dart',
    extensions: ['dart'],
    load: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.dart)),
  }),
  LanguageDescription.of({
    name: 'Go',
    alias: ['golang'],
    extensions: ['go'],
    load: () => import('@codemirror/legacy-modes/mode/go').then((m) => legacy(m.go)),
  }),
  LanguageDescription.of({
    name: 'Rust',
    alias: ['rs'],
    extensions: ['rs'],
    load: () => import('@codemirror/legacy-modes/mode/rust').then((m) => legacy(m.rust)),
  }),
  LanguageDescription.of({
    name: 'SQL',
    alias: ['mysql', 'postgresql', 'postgres', 'sqlite', 'plsql'],
    extensions: ['sql'],
    load: () => import('@codemirror/legacy-modes/mode/sql').then((m) => legacy(m.standardSQL)),
  }),
  LanguageDescription.of({
    name: 'Shell',
    alias: ['bash', 'sh', 'zsh'],
    extensions: ['sh', 'bash', 'zsh'],
    load: () => import('@codemirror/legacy-modes/mode/shell').then((m) => legacy(m.shell)),
  }),
  LanguageDescription.of({
    name: 'LaTeX',
    alias: ['tex', 'stex'],
    extensions: ['tex', 'ltx'],
    load: () => import('@codemirror/legacy-modes/mode/stex').then((m) => legacy(m.stex)),
  }),
  LanguageDescription.of({
    name: 'R',
    alias: ['rscript'],
    extensions: ['r', 'R'],
    load: () => import('@codemirror/legacy-modes/mode/r').then((m) => legacy(m.r)),
  }),
  LanguageDescription.of({
    name: 'MATLAB',
    alias: ['octave'],
    extensions: ['m'],
    load: () => import('@codemirror/legacy-modes/mode/octave').then((m) => legacy(m.octave)),
  }),
  LanguageDescription.of({
    name: 'YAML',
    alias: ['yml'],
    extensions: ['yaml', 'yml'],
    load: () => import('@codemirror/legacy-modes/mode/yaml').then((m) => legacy(m.yaml)),
  }),
  LanguageDescription.of({
    name: 'XML',
    alias: ['svg', 'rss', 'xsd'],
    extensions: ['xml', 'xsl', 'xsd', 'svg'],
    load: () => import('@codemirror/legacy-modes/mode/xml').then((m) => legacy(m.xml)),
  }),
  LanguageDescription.of({
    name: 'TOML',
    extensions: ['toml'],
    load: () => import('@codemirror/legacy-modes/mode/toml').then((m) => legacy(m.toml)),
  }),
  LanguageDescription.of({
    name: 'Ruby',
    alias: ['rb'],
    extensions: ['rb'],
    load: () => import('@codemirror/legacy-modes/mode/ruby').then((m) => legacy(m.ruby)),
  }),
  LanguageDescription.of({
    name: 'Swift',
    extensions: ['swift'],
    load: () => import('@codemirror/legacy-modes/mode/swift').then((m) => legacy(m.swift)),
  }),
  LanguageDescription.of({
    name: 'Diff',
    alias: ['patch'],
    extensions: ['diff', 'patch'],
    load: () => import('@codemirror/legacy-modes/mode/diff').then((m) => legacy(m.diff)),
  }),
  LanguageDescription.of({
    name: 'Dockerfile',
    alias: ['docker'],
    filename: /^Dockerfile$/,
    load: () => import('@codemirror/legacy-modes/mode/dockerfile').then((m) => legacy(m.dockerFile)),
  }),
];
