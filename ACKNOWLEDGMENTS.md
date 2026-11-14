# Open-Source Acknowledgments

DeepStudent is licensed under the **GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`)** — see [`LICENSE`](./LICENSE).

All shipped and runtime third-party dependencies in DeepStudent are verified for full `AGPL-3.0-or-later` compatibility (via `npm run licenses:check`). Complete machine-generated copyright, license, and attribution texts for every distributed component are maintained in [`legal/THIRD_PARTY_NOTICES.txt`](./legal/THIRD_PARTY_NOTICES.txt).

---

## Runtimes & Frameworks

| Project | Version | License | Role |
|---|---|---|---|
| [Electron](https://www.electronjs.org/) | `45.2.1` | MIT | Cross-platform desktop shell |
| [Chromium](https://www.chromium.org/) | bundled via Electron | BSD-3-Clause & Multiple-OSS | Desktop renderer engine (`LICENSES.chromium.html` ships in Electron distributions) |
| [Node.js](https://nodejs.org/) | bundled via Electron | MIT | Host backend runtime |
| [Capacitor](https://capacitorjs.com/) (`@capacitor/core`, `@capacitor/android`, `@capacitor/ios`) | `8.6.0` | MIT | Mobile native bridge (Android / iPadOS) |
| [Cordis](https://github.com/deepseek-ai/cordis) (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`) | `4.0.5` / `3.18.5` | MIT | Host plugin kernel & schema system |
| [React](https://react.dev/) | `18.3.1` | MIT | Declarative UI framework |
| [TypeScript](https://www.typescriptlang.org/) | `5.6.3` | Apache-2.0 | Static type system |
| [Vite](https://vite.dev/) | `6.4.3` | MIT | Frontend & worker bundler |

## Backend, Vector & Crypto

| Project | Version | License | Role |
|---|---|---|---|
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | `13.0.3` | MIT | Desktop synchronous SQLite engine |
| [SQLite WASM](https://sqlite.org/wasm) (`@sqlite.org/sqlite-wasm`) | `3.53.4-build2` | Apache-2.0 | Mobile / Web OPFS SQLite storage |
| [LanceDB](https://lancedb.com/) (`@lancedb/lancedb`) | `0.22.1` | Apache-2.0 | Embedded vector database & RAG retrieval |
| [Apache Arrow](https://arrow.apache.org/) (`apache-arrow`) | `18.1.0` | Apache-2.0 | Columnar data transport for LanceDB |
| [Koffi](https://koffi.dev/) | `3.3.3` | MIT | Native C FFI bindings |
| [esbuild](https://esbuild.github.io/) | `0.25.12` | MIT | In-app plugin workshop compiler |
| [undici](https://undici.nodejs.org/) | `7.30.1` | MIT | High-performance HTTP/1.1 & HTTP/2 client |
| [AWS SDK S3](https://github.com/aws/aws-sdk-js-v3) (`@aws-sdk/client-s3`) | `3.1153.0` | Apache-2.0 | S3-compatible cloud sync adapter |
| [Argon2](https://github.com/napi-rs/node-rs) (`@node-rs/argon2`) | `2.2.2` | MIT | Key derivation & sync encryption |
| [Keyring](https://github.com/napi-rs/keyring-node) (`@napi-rs/keyring`) | `2.1.2` | MIT | OS keychain credential storage |
| [Noble](https://paulmillr.com/noble/) (`@noble/ciphers`, `@noble/hashes`) | `1.3.0` / `1.8.0` | MIT | Portable audited cryptography |
| [tiktoken](https://github.com/dqbd/tiktoken) | `1.0.22` | MIT | BPE tokenization |
| [Sentry](https://sentry.io/) (`@sentry/node`, `@sentry/browser`) | `8.55.2` | MIT | Opt-in error & crash telemetry |
| [Ajv](https://ajv.js.org/) | `8.20.0` | MIT | JSON Schema validation for contracts & plugins |

## F7 WASI Engines

The prebuilt WebAssembly module [`host/platform/native/wasm/f7-native-wasm.wasm`](./host/platform/native/wasm/f7-native-wasm.wasm) (built with `rustc 1.98.1`, SHA-256 recorded in [`f7-native-wasm.wasm.sha256`](./host/platform/native/wasm/f7-native-wasm.wasm.sha256)) executes deterministic sandboxed engines via WASI (`wasm32-wasip1`):

| Crate | Version | License | Purpose |
|---|---|---|---|
| [Starlark](https://github.com/facebook/starlark-rust) (`starlark`) | `0.14.2` | Apache-2.0 | Deterministic script evaluation |
| [Symphonia](https://github.com/pdeljanov/Symphonia) (`symphonia*`) | `0.5.5` | MPL-2.0 | Audio decoding & resampling |
| [fsrs-rs](https://github.com/open-spaced-repetition/fsrs-rs) (`fsrs`) | `6.6.2` | BSD-3-Clause | FSRS parameter optimization & evaluation |
| [image-rs](https://github.com/image-rs/image) (`image`) | `0.24.9` / `0.25.9` | MIT OR Apache-2.0 | Image decoding & RGBA conversion |
| [regex](https://github.com/rust-lang/regex) | `1.12.3` | MIT OR Apache-2.0 | Linear-time regular expressions |
| [roxmltree](https://github.com/RazrFalcon/roxmltree) | `0.20.0` | MIT OR Apache-2.0 | Read-only XML DOM parsing |
| [docx-rs](https://github.com/bokuweb/docx-rs) | `0.4.19` | MIT | DOCX parsing & text extraction |
| [calamine](https://github.com/tafia/calamine) | `0.26.1` | MIT | Excel / ODS spreadsheet parsing |
| [pptx-to-md](https://github.com/pptx-to-md/pptx-to-md) | `0.2.0` | MIT OR Apache-2.0 | PPTX slide text extraction |
| [rtf-parser](https://github.com/paoloose/rtf-parser) | `0.3.0` | MIT | Rich Text Format extraction |
| [html2text](https://github.com/jiska/html2text) | `0.16.7` | MIT | HTML to plain text rendering |
| [priority-queue](https://github.com/garro95/priority-queue) | `2.7.0` | LGPL-3.0-or-later OR MPL-2.0 (elected under MPL-2.0) | Priority queue used by `fsrs` |

> **MPL-2.0 Section 3.2(b) Source Availability Notice:** Source Code Form for the MPL-2.0 Covered Software (`symphonia` `0.5.5` and `priority-queue` `2.7.0`) and DeepStudent's WASI wrapper provenance are available via the DeepStudent repository and its git history at <https://github.com/helixnow/deep-student> (provenance commits `f2754050c`, `6088949b99d44f46f5328fd7289d209b9a842b68`, and `7ca56553791db6742627f0a0fbb9a56f55015b18`) as well as the upstream repositories listed above.

## Documents & Archives

| Project | Version | License | Role |
|---|---|---|---|
| [PDF.js](https://mozilla.github.io/pdf.js/) (`pdfjs-dist`) | `5.4.296` | Apache-2.0 | PDF rendering & text layer |
| OpenJPEG & qcms (bundled in `pdfjs-dist/wasm`) | bundled | BSD-2-Clause / BSD-3-Clause / MIT | JPEG 2000 & ICC color management WASM decoders |
| [PDFium](https://pdfium.googlesource.com/pdfium/) (`@embedpdf/pdfium`) | `2.15.1` | MIT (bindings) / Apache-2.0 & BSD-3-Clause (PDFium) | Native-grade PDF rendering & extraction |
| [pdf-lib](https://pdf-lib.js.org/) | `1.17.1` | MIT | PDF creation & manipulation |
| [pdfmake](http://pdfmake.org/) | `0.3.13` | MIT | Document PDF export |
| [docx](https://docx.js.org/) | `9.15.2` | MIT | DOCX document generation |
| [docx-preview](https://github.com/VolodymyrBaydalka/docxjs) | `0.3.7` | Apache-2.0 | DOCX client-side preview |
| [ExcelJS](https://github.com/exceljs/exceljs) | `4.4.0` | MIT | Spreadsheet import/export & preview |
| [pptxgenjs](https://gitbrent.github.io/PptxGenJS/) | `4.0.1` | MIT | PPTX slide generation |
| [pptx-preview](https://github.com/nicky-xie/pptx-preview) | `1.0.7` | ISC | PPTX slide preview |
| [JSZip](https://stuk.github.io/jszip/) | `3.10.1` | MIT OR GPL-3.0-or-later | Zip archive reading & generation |
| [pako](https://github.com/nodeca/pako) | `1.0.11` | MIT AND Zlib | Zlib/deflate compression |
| [tar](https://github.com/isaacs/node-tar) | `7.5.22` | BlueOak-1.0.0 | Tarball packaging & extraction |
| [DOMPurify](https://github.com/cure53/DOMPurify) | `3.4.11` | MPL-2.0 OR Apache-2.0 | HTML & SVG sanitization |

## Editors, Science & DataViz

| Project | Version | License | Role |
|---|---|---|---|
| [Milkdown](https://milkdown.dev/) (`@milkdown/*`) | `7.22.1` | MIT | Plugin-driven WYSIWYG Markdown editor |
| [ProseMirror](https://prosemirror.net/) (`prosemirror-*`) | `1.x` | MIT | Rich-text editor foundation |
| [CodeMirror](https://codemirror.net/) (`codemirror`, `@codemirror/*`) | `6.0.2` | MIT | Code & source editing |
| [KaTeX](https://katex.org/) | `0.16.47` | MIT | Fast math typesetting |
| [FlowToken](https://github.com/nvq/flowtoken) (`@nvq/flowtoken`) | `2.0.6` | ISC | Streaming Markdown token animations |
| [Mermaid](https://mermaid.js.org/) | `11.15.0` | MIT | Diagrams & flowcharts |
| [Apache ECharts](https://echarts.apache.org/) (`echarts`) | `6.1.0` | Apache-2.0 | Interactive charts |
| [Vega](https://vega.github.io/vega/) / [Vega-Lite](https://vega.github.io/vega-lite/) | `6.4.0` / `6.4.3` | BSD-3-Clause | Declarative visualization grammar |
| [Recharts](https://recharts.org/) | `3.8.1` | MIT | React chart components |
| [React Flow](https://reactflow.dev/) (`@xyflow/react`) | `12.11.2` | MIT | Node-based mindmaps & graphs |
| [Cytoscape.js](https://js.cytoscape.org/) (`cytoscape`) | `3.33.4` | MIT | Graph theory & network visualization |
| [Graphviz](https://github.com/mdaines/viz-js) (`@viz-js/viz`) | `3.30.0` | MIT | Graphviz WebAssembly layout |
| [D3](https://d3js.org/) (`d3`) | `7.9.0` | ISC | Data-driven visualizations |
| [3Dmol.js](https://3dmol.csb.pitt.edu/) (`3dmol`) | `2.5.5` | BSD-3-Clause | 3D molecular visualization |
| [abcjs](https://www.abcjs.net/) | `6.7.0` | MIT | ABC music notation rendering |
| [OpenChemLib](https://github.com/cheminfo/openchemlib-js) (`openchemlib`) | `9.25.0` | BSD-3-Clause | Cheminformatics & structure rendering |
| [SmilesDrawer](https://github.com/reymond-group/smilesDrawer) (`smiles-drawer`) | `2.4.1` | MIT | Chemical SMILES diagram rendering |
| [WaveDrom](https://wavedrom.com/) (`wavedrom`) | `3.7.0` | MIT | Digital timing diagram rendering |

## UI, FSRS & i18n

| Project | Version | License | Role |
|---|---|---|---|
| [Tailwind CSS](https://tailwindcss.com/) | `3.4.19` | MIT | Utility-first styling |
| [Radix UI](https://www.radix-ui.com/) (`@radix-ui/*`) | `1.x` | MIT | Accessible unstyled UI primitives |
| [Framer Motion](https://www.framer.com/motion/) (`framer-motion`) | `12.40.0` | MIT | Motion & layout transitions |
| [Phosphor Icons](https://phosphoricons.com/) (`@phosphor-icons/react`) | `2.1.10` | MIT | Application iconography |
| [LobeHub Icons](https://icons.lobehub.com/) (`@lobehub/icons`) | `5.6.0` | MIT | AI model & ecosystem icons |
| [dnd-kit](https://dndkit.com/) (`@dnd-kit/*`) | `6.3.1` | MIT | Accessible drag-and-drop |
| [OverlayScrollbars](https://kingsora.github.io/OverlayScrollbars/) | `2.16.0` | MIT | Cross-platform custom scrollbars |
| [TanStack Virtual](https://tanstack.com/virtual) (`@tanstack/react-virtual`) | `3.13.25` | MIT | Virtualized list & message rendering |
| [React Resizable Panels](https://github.com/bvaughn/react-resizable-panels) | `3.0.6` | MIT | Split pane workbench layouts |
| [Zustand](https://zustand-demo.pmnd.rs/) | `5.0.13` | MIT | Lightweight state management |
| [Immer](https://immerjs.github.io/immer/) | `10.2.0` | MIT | Immutable state updates |
| [Zod](https://zod.dev/) | `4.4.3` | MIT | TypeScript-first schema validation |
| [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) | `6.0.0` | MIT | Spaced repetition scheduling |
| [i18next](https://www.i18next.com/) (`i18next`, `react-i18next`) | `25.10.10` | MIT | Internationalization framework |

## Fonts & Assets

- **Noto Sans SC** (`public/fonts/paper-export/`): Licensed under the **SIL Open Font License 1.1 (`OFL-1.1`)** for paper PDF exports.
- **Liberation Sans** (`pdfjs-dist/standard_fonts/LICENSE_LIBERATION`): Bundled via PDF.js standard fonts under **SIL Open Font License 1.1 (`OFL-1.1`)**.
- **Foxit Standard Fonts** (`pdfjs-dist/standard_fonts/LICENSE_FOXIT`): Bundled via PDF.js standard fonts under **BSD-3-Clause**.
- **Study OS Wallpapers** (`public/wallpapers/study-os/`): Derived from Wikimedia Commons / Unsplash originals published under **CC0 1.0 Universal (`CC0-1.0`)**. See [`public/wallpapers/study-os/ATTRIBUTION.md`](./public/wallpapers/study-os/ATTRIBUTION.md).
- **AI Provider Brand Icons** (`public/icons/providers/`): Provider trademarks and brand logos belong to their respective owners and are included solely to identify configured AI model providers. See [`public/icons/providers/README.md`](./public/icons/providers/README.md).

---

For the complete, generated inventory and verbatim license/notice texts of all 1,028 shipped components, see [`legal/THIRD_PARTY_NOTICES.txt`](./legal/THIRD_PARTY_NOTICES.txt) and [`LICENSE`](./LICENSE).
