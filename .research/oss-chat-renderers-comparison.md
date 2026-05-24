# LLM output renderer — OSS chat app comparison

Cross-checked against our app's `src/chat-v2/components/renderers/MarkdownRenderer.tsx` and friends. All citations are GitHub raw URLs.

## Our baseline (deep-student)

Source files inspected:
- `src/chat-v2/components/renderers/MarkdownRenderer.tsx:1-771`
- `src/chat-v2/components/renderers/CodeBlock.tsx:1-759`
- `src/chat-v2/components/renderers/StreamingMarkdownRenderer.tsx:1-381` (parses `<thinking>`/`<think>` from content)
- `src/chat-v2/components/MessageList.tsx:170-339` (virtualizer + rAF scroll loop)
- `src/chat-v2/components/message/MessageActions.tsx:1-192`

Stack today:
- **Markdown:** `react-markdown` 10.1 + `remark-gfm` + `remark-math` + `rehype-raw` + `rehype-sanitize`
- **Syntax highlighter:** `prismjs` 1.30 (in `CodeBlock.tsx`)
- **Math:** `katex` 0.16 — manually rendered via `katex.renderToString` + `renderToStaticMarkup` (`MarkdownRenderer.tsx:504-545`)
- **Mermaid:** `mermaid` 11.10 — lazy `import('mermaid')` per block, no run during streaming (`CodeBlock.tsx:284-324`)
- **Thinking:** regex parse `<thinking>…</thinking>`/`<think>…</think>` in `StreamingMarkdownRenderer.tsx:264-272`. V2 also has independent `thinking` block type in `core/types/common.ts:34`.
- **Citations:** custom `citationRemarkPlugin` + `CitationBadge` + `MindmapCitationCard` + `QbankCitationBadge` (inline span placeholders)
- **Action toolbar:** hand-rolled, always-visible 7 buttons (copy / save-as-note / branch / debug / retry|resend / edit / delete) — not hover-revealed
- **Scroll:** custom rAF auto-scroll loop with wheel/touchmove user-intent detection; floating button not yet implemented
- **Virtualization:** `@tanstack/react-virtual` 3.13 with delayed init (`MessageList.tsx:171-204`)
- **Branches:** linear sibling list; no picker primitive

---

## 1. Vercel `vercel/chatbot` (formerly `vercel/ai-chatbot`)

Repo: <https://github.com/vercel/chatbot> — uses `streamdown` + `ai-elements` from the `@vercel/ai` ecosystem.

**Package.json signals** (<https://raw.githubusercontent.com/vercel/chatbot/main/package.json>):
```
"streamdown": "^2.3.0",
"@streamdown/cjk": "^1.0.2",
"@streamdown/code": "^1.0.3",
"@streamdown/math": "^1.0.2",
"@streamdown/mermaid": "^1.0.2",
"shiki": "^3.21.0",
"katex": "^0.16.28",
"use-stick-to-bottom": "^1.1.1"
```
Notably: **no `react-markdown`, no `prismjs`, no `highlight.js`**.

### Markdown engine — Streamdown
`components/ai-elements/message.tsx:283-307` (<https://raw.githubusercontent.com/vercel/chatbot/main/components/ai-elements/message.tsx>):
```tsx
const streamdownPlugins = { cjk, code, math, mermaid };

export const MessageResponse = memo(
  ({ className, ...props }) => (
    <Streamdown
      className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
      plugins={streamdownPlugins}
      {...props}
    />
  ),
  (prev, next) => prev.children === next.children   // strict === on string content
);
```
Streamdown is purpose-built for incomplete/streaming markdown — auto-completes unclosed code fences, defers tables/lists until full row, hardens URLs, etc. Shiki is loaded by `@streamdown/code`.

### Code block — Shiki async tokenization
`components/ai-elements/code-block.tsx:120-220`:
- Singleton `highlighterCache` (`Map<lang, Promise<Highlighter>>`) created via `createHighlighter({ langs: [language], themes: ["github-light", "github-dark"] })`.
- `tokensCache` keyed by `${lang}:${len}:${first100}:${last100}` to avoid re-tokenizing identical code.
- Synchronous `highlightCode()` returns cached tokens immediately or fires async with subscriber callback. Until tokens arrive, raw uncolored tokens render (`createRawTokens`).
- Shiki bitflag font-style decode: `fontStyle & 1` italic, `& 2` bold, `& 4` underline.
- CSS `content-visibility: auto; contain-intrinsic-size: auto 200px;` for skip-rendering offscreen blocks.
- Copy button: `CodeBlockCopyButton` with 2s "copied" state via `setTimeout` ref.

### Reasoning block
`components/ai-elements/reasoning.tsx:38-150`:
- Wraps Radix `Collapsible`. Streams via Streamdown.
- **Auto-open on stream start, auto-close 1000ms after stream end** (single-shot, tracked via `hasAutoClosed`).
- Tracks duration: `startTimeRef` set on stream start, computed `(now - start)/1000` on stream end via `useControllableState`.
- Trigger label: `<Shimmer>Thinking...</Shimmer>` while streaming, else `Thought for {N} seconds`.
- `max-h-[200px] overflow-y-auto` panel with `[overflow-anchor:none]` and auto-scroll to bottom while streaming.
- Re-export wrapper at `components/chat/message-reasoning.tsx`: `<Reasoning defaultOpen={hasBeenStreaming} isStreaming={isLoading}>` so it stays open if the user opened it during streaming.

### Action toolbar
`components/chat/message-actions.tsx`:
```tsx
<Actions className="opacity-0 transition-opacity duration-150 group-hover/message:opacity-100">
  <Action tooltip="Copy" onClick={handleCopy}>...</Action>
  <Action tooltip="Upvote Response" disabled={vote?.isUpvoted}>...</Action>
  <Action tooltip="Downvote Response" disabled={vote && !vote.isUpvoted}>...</Action>
</Actions>
```
- **Hover-revealed**, group-hover pattern. SWR optimistic updates for vote.
- User messages get `Edit` + `Copy` only.
- Toast feedback via `sonner`.

### Empty state
`components/chat/greeting.tsx`: framer-motion fade-up ("What can I help with?" + tagline).
`components/chat/suggested-actions.tsx`: 4 cards, `min-w-[200px] shrink-0` horizontal scroll on mobile, `sm:grid-cols-2` on desktop, staggered fade-up `delay: 0.06 * index`.

### Scroll-to-bottom
Two patterns coexist:
- `components/ai-elements/conversation.tsx`: wraps `StickToBottom` (from `use-stick-to-bottom`) with `initial="smooth" resize="smooth"`. `ConversationScrollButton` reads `useStickToBottomContext()` and renders only when `!isAtBottom`.
- `components/chat/messages.tsx`: custom `useMessages` hook → `useScrollToBottom` with manual containerRef/endRef + IntersectionObserver. Floating pill button bottom-center: `rounded-full border bg-card/90 ... backdrop-blur-lg` with ArrowDown icon. Animates in via `scale-90 opacity-0` ↔ `scale-100 opacity-100`.

### Virtualization
**None.** Just `messages.map(...)`. Vercel template assumes short-to-medium threads.

### Branch UI
`components/ai-elements/message.tsx:106-300`: `MessageBranch` + `MessageBranchSelector` + `MessageBranchPrevious`/`Next` + `MessageBranchPage` ("1 of 3"). Linear prev/next with `ButtonGroup`. Hidden when `totalBranches <= 1`.

### Citations
Not implemented in template. Inline-text only (no chips).

---

## 2. `assistant-ui/assistant-ui`

Headless primitives library. Two markdown packages exist: `@assistant-ui/react-markdown` (react-markdown based) and `@assistant-ui/react-streamdown` (Streamdown wrapper). Code highlighter is a separate `@assistant-ui/react-syntax-highlighter` package.

### Markdown engine
`packages/react-markdown/src/primitives/MarkdownText.tsx` (<https://raw.githubusercontent.com/assistant-ui/assistant-ui/main/packages/react-markdown/src/primitives/MarkdownText.tsx>):
```tsx
const { useSmooth, useSmoothStatus, withSmoothContextProvider } = INTERNAL;

const MarkdownTextInner: FC<MarkdownTextPrimitiveProps> = ({ components, componentsByLanguage, smooth = true, preprocess, ...rest }) => {
  const messagePartText = useMessagePartText();
  const processed = useMemo(() => preprocess
    ? { ...messagePartText, text: preprocess(messagePartText.text) }
    : messagePartText, [messagePartText, preprocess]);
  const { text } = useSmooth(processed, smooth);   // token-by-token smoothing for stream

  // CodeOverride wraps user's pre/code/SyntaxHighlighter/CodeHeader and dispatches by language
  return <ReactMarkdown components={components} {...rest}>{text}</ReactMarkdown>;
};
```
Two key innovations:
1. **`useSmooth`** — internal smoothing layer that buffers stream tokens for character-level fade-in (eliminates jitter when LLM bursts tokens).
2. **`componentsByLanguage`** — per-language component overrides:
   ```ts
   componentsByLanguage={{ mermaid: { SyntaxHighlighter: MermaidDiagram } }}
   ```
   Lets you swap renderer per fenced language without writing a custom `code` component.

### Chain of Thought
`packages/react/src/primitives/chainOfThought/` (3 files):
- `ChainOfThoughtRoot.tsx` — `Primitive.div` wrapper.
- `ChainOfThoughtAccordionTrigger.ts` — radix accordion trigger.
- `ChainOfThoughtParts.tsx` — re-exports `ChainOfThoughtPrimitiveParts` from `@assistant-ui/core/react`.

Pattern (from JSDoc):
```tsx
<ChainOfThoughtPrimitive.Root>
  <ChainOfThoughtPrimitive.AccordionTrigger>Toggle reasoning</ChainOfThoughtPrimitive.AccordionTrigger>
  <ChainOfThoughtPrimitive.Parts />   // renders reasoning + tool-call parts
</ChainOfThoughtPrimitive.Root>
```
Notable: ChainOfThought is **separate** from `Reasoning` (they have a `reasoning/` primitive too) — chain-of-thought groups reasoning **and** tool-calls into one collapsible.

### ActionBar / BranchPicker / Composer
- `actionBar/` + `actionBarMore/` — split into root + overflow menu (3-dot expansion when too many actions).
- `branchPicker/` — composable: `Root`, `Previous`, `Next`, `Number`, `Count` (e.g. `<BranchPicker.Number /> / <BranchPicker.Count />`).
- `composer/` — input primitive with `Composer.Send`/`Cancel`/`Attachments`.

### Empty state / suggestions
`thread/` primitive provides `Thread.Empty` (render-prop). `suggestion/` primitive renders prompt cards.

### Reasoning primitive
Exists as `reasoning/` directory (separate from chainOfThought) — the lower-level building block.

### Smooth streaming
`useSmooth` is the core differentiator vs every other lib here. It buffers chunks and emits a smoother stream — produces the polished "ChatGPT typewriter" feel even when the upstream burstiness is uneven.

---

## 3. `lobehub/lobe-chat`

Massive (77k★) feature-heavy chat app. Wraps everything behind `@lobehub/ui`'s `Markdown` + `Highlight` components.

**Package.json signals** (<https://raw.githubusercontent.com/lobehub/lobe-chat/main/package.json>):
```
"@lobehub/ui": "5.10.5",
"react-markdown": "^10.1.0",
"shiki": "^3.21.0",
"marked": "^17.0.1",          // also present (used elsewhere)
"react-virtuoso": "^4.18.1",
"virtua": "^0.48.3"
"katex": (peer of @lobehub/ui)
```

### Markdown
`src/features/Conversation/Markdown/index.tsx` (<https://raw.githubusercontent.com/lobehub/lobe-chat/main/src/features/Conversation/Markdown/index.tsx>):
```tsx
const MarkdownMessage = memo<MarkdownProps>(({ children, componentProps, ...rest }) => {
  const { highlighterTheme, mermaidTheme, fontSize } = useUserStore(userGeneralSettingsSelectors.config);
  return (
    <Markdown fontSize={fontSize} variant={'chat'}
      componentProps={{
        ...componentProps,
        highlight: { fullFeatured: true, theme: highlighterTheme, ...componentProps?.highlight },
        mermaid:   { fullFeatured: false, theme: mermaidTheme,    ...componentProps?.mermaid },
      }}
      {...rest}>{children}</Markdown>
  );
});
```
The `@lobehub/ui` `Markdown` component itself uses `react-markdown` 10 + `shiki` under the hood. `fullFeatured` toggles header (filename/lang/copy) + line numbers.

### Code / Math / Mermaid
- Shiki, theme is user-configurable.
- Math via `@lobehub/ui` Markdown (KaTeX through remark-math).
- Mermaid theme also user-selectable; `fullFeatured: false` for mermaid disables wrapper chrome.

### Reasoning / Thinking
Per-role component in `src/features/Conversation/Messages/Assistant/` — uses `AssistantMessageExtra` for tool/reasoning extras and `normalizeThinkTags` + `processWithArtifact` to clean stream content (`Assistant/index.tsx:67`).

### Action bar — Portal pattern
`Assistant/index.tsx:30,80-95`:
```tsx
const actionBarHolder = (
  <div {...{ [MESSAGE_ACTION_BAR_PORTAL_ATTRIBUTES.assistant]: '' }} style={{ height: '28px' }} />
);
// ...
const onMouseEnter = useCallback((e) => {
  setMessageItemActionElementPortialContext(e.currentTarget);
  setMessageItemActionTypeContext({ id, index, type: 'assistant' });
}, [...]);
```
A single shared action bar is **portaled** into whichever message is hovered. Saves DOM nodes for long threads. The placeholder div reserves height to prevent layout shift.

### Citations
Not via inline plugin — handled in `MessageExtra` as a side panel of sources.

### Scroll / virtualization
`react-virtuoso` 4.18 (and `virtua` for some views). Virtualized list from the start.

### Branches
`MessageBranch` component with `activeBranchIndex` + `count` — renders only in dev mode for assistant role.

### Tool / plugin output
Dedicated `Tool/` message role with its own MessageItem dispatch (`Messages/index.tsx:147`).

---

## 4. `danny-avila/LibreChat`

Mature (37k★) multi-provider production app. Predates the streaming-aware libs — uses classic `react-markdown` 9 + `rehype-highlight`.

**Package signals** (<https://raw.githubusercontent.com/danny-avila/LibreChat/main/client/package.json>):
```
"react-markdown": "^9.0.1",
"remark-gfm": "^4.0.0",
"remark-math": "^6.0.0",
"remark-supersub": "^1.0.0",
"remark-directive": "^3.0.0",
"rehype-katex": "^6.0.3",
"rehype-highlight": "^6.0.0",
"micromark-extension-llm-math": "^3.1.0",
"mermaid": "^11.15.0",
"react-virtualized": "^9.22.6",   // present, NOT used in MessagesView
"react-vtree": "^3.0.0"
```

### Markdown
`client/src/components/Chat/Messages/Content/Markdown.tsx`:
```tsx
const remarkPlugins = [supersub, remarkGfm, remarkDirective, artifactPlugin,
                       [remarkMath, { singleDollarTextMath: false }],
                       unicodeCitation, mcpUIResourcePlugin];
const rehypePlugins = [[rehypeKatex],
                       [rehypeHighlight, { detect: true, ignoreMissing: true, subset: langSubset }]];
```
Custom inline preprocessing toggleable via Recoil `LaTeXParsing`. `langSubset` keeps highlight.js bundle tiny by filtering languages.

### Code block
`MarkdownComponents.tsx:30-75`:
```tsx
const isMath = lang === 'math';
const isMermaid = lang === 'mermaid';
const isSingleLine = isSingleLineCode(children);

if (isMath) return <>{children}</>;
if (isMermaid) return <MermaidErrorBoundary code={content}><Mermaid id={`mermaid-${blockIndex}`}>{content}</Mermaid></MermaidErrorBoundary>;
if (isSingleLine) return <code onDoubleClick={handleDoubleClick} className={className}>{children}</code>;
return <CodeBlock lang={lang} codeChildren={children} blockIndex={blockIndex} allowExecution={canRunCode} />;
```
- `useCodeBlockContext` numbers code blocks per message (for execution wiring).
- `allowExecution` permission-gated via RBAC.
- `MermaidErrorBoundary` catches malformed diagrams during streaming.

### Action toolbar — hover-only on non-last messages
`HoverButtons.tsx`:
```tsx
const buttonStyle = cn('hover-button rounded-lg p-1.5 ...',
  'md:group-hover:visible md:group-focus-within:visible md:group-[.final-completion]:visible',
  !isLast && 'md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100',
  ...);
```
Set: **TTS** → **Copy** → **Edit** → **Fork** → **Feedback** (👍 + 👎 with optional rating comment) → **Regenerate** → **Continue**. On error: only Regenerate. `final-completion` class always shows the bar on the last assistant message.

### Fork / Branch UI
`Fork.tsx` — Ariakit `Popover` + `Hovercard`. Three options:
- `DIRECT_PATH` (visible chain only)
- `INCLUDE_BRANCHES` (siblings included)
- `TARGET_LEVEL` (tree subset)
Plus checkboxes: `Split at target` and `Remember default`. Each option has a hover description card. Documented at <https://www.librechat.ai/docs/features/fork>.

Sibling navigation is separate from fork — `SiblingSwitch.tsx` cycles between regenerated variants.

### Empty state
Standard greeting (separate component, not in `Messages/`).

### Citations
Inline via remark plugins: `Citation`, `CompositeCitation`, `HighlightedText`, `unicodeCitation` (in `~/components/Web/Citation`). Plus MCP UI resources via `mcpUIResourcePlugin`.

### Scroll
`useMessageScrolling` hook + `<ScrollToBottom>`:
```tsx
<CSSTransition in={showScrollButton && scrollButtonPreference}
               timeout={{ enter: 300, exit: 250 }} classNames="scroll-animation"
               unmountOnExit appear nodeRef={scrollToBottomRef}>
  <ScrollToBottom ref={scrollToBottomRef} scrollHandler={handleSmoothToRef} />
</CSSTransition>
```
Button: `pointer-events-none absolute bottom-5 ... flex justify-end` with chevron-down. `premium-scroll-button` class. Distinct: button is **right-aligned**, not bottom-center.

### Virtualization
`react-virtualized` and `react-vtree` are dependencies but `MessagesView` renders linearly with `MultiMessage` recursion. They're used elsewhere (file lists).

---

## 5. `open-webui/open-webui`

Svelte (137k★). Different stack — uses `marked` + `highlight.js`.

### Markdown
`Markdown.svelte` (<https://raw.githubusercontent.com/open-webui/open-webui/main/src/lib/components/chat/Messages/Markdown.svelte>):
```ts
marked.use(markedKatexExtension(options));
marked.use(markedExtension(options));
marked.use(citationExtension(options));
marked.use(footnoteExtension(options));
marked.use(colonFenceExtension(options));
marked.use(disableSingleTilde);
marked.use({ extensions: [
  mentionExtension({ triggerChar: '@' }),
  mentionExtension({ triggerChar: '#' }),
  mentionExtension({ triggerChar: '$' })
]});

const updateHandler = (content) => {
  if (done) { /* parseTokens immediately */ }
  else if (!pendingUpdate) {
    pendingUpdate = requestAnimationFrame(() => { pendingUpdate = null; parseTokens(); });
  }
};
```
**Key streaming optimization:** `marked.lexer()` is throttled to **once per animation frame** during streaming and runs synchronously when done. `MarkdownTokens` then renders the AST. Dedup: `if (content === lastContent) return;`.

### Code block
`CodeBlock.svelte` — uses `highlight.js` 'github-dark.min.css' theme:
```ts
{@html hljs.highlightAuto(code, hljs.getLanguage(lang)?.aliases).value || code}
```
- **Mermaid + Vega + Vega-Lite** all rendered inline (`renderMermaidDiagram`, `renderVegaVisualization`). Render only when fence closed: `(token?.raw ?? '').slice(-4).includes('```')`.
- **Pyodide worker** for Python execution (browser-side). Jupyter backend optional. `executePython` checks for matplotlib/numpy/pandas imports to lazy-load packages.
- **CodeMirror** for editable code blocks (`edit` flag).
- Buttons: Copy / Save / Run / Preview / Collapse.
- `SvgPanZoom` wrapper for diagram pan+zoom.

### Reasoning / thinking
Uses `<details>...</details>` HTML blocks (no special primitive). `removeAllDetails` utility strips them when copying or doing TTS.

### Action toolbar — `ResponseMessage.svelte`
Always-visible on last message + on hover for others:
```svelte
class="{isLastMessage ? 'visible' : 'invisible group-hover:visible'} ..."
```
Set: **prev/next siblings** (with editable index counter — dblclick to type) → **Edit** → **Copy** → **Read Aloud** (Kokoro browser TTS or OpenAI TTS) → **Info** (token usage tooltip with `<pre>`-formatted JSON) → **👍 / 👎** (with comment via `RateComment`) → **Continue Response** → **Regenerate** (with `RegenerateMenu` dropdown for prompt-rewrite variants) → **Delete**.

Buttons container has `wheel → horizontal scroll` handler (vertical wheel becomes horizontal scroll on the toolbar) — useful when many model-defined custom actions overflow.

### Empty state
Separate `Placeholder.svelte` component (not in Messages/).

### Citations
`Citations.svelte` with `showSourceModal(id)` — **modal-based**, not inline chips. Triggered from `ContentRenderer.svelte` via `onSourceClick` callback.

### Scroll
Custom logic in `Chat.svelte` + per-message `scroll-margin-top: 3rem;` for jump-to-message anchoring. Linear render — no virtualization.

### Branches / Forks
**Linear sibling switching** with editable index ("3/5"). No tree-fork like LibreChat. Works as: previous variant ⇄ this variant ⇄ next variant.

### Code execution / artifacts
Pyodide worker, Jupyter, HTML/SVG preview via iframe with sandbox toggles (`iframeSandboxAllowSameOrigin`).

---

# Decision matrix

For each component: **Ours** | **Vercel** | **Assistant-UI** | **Lobe** | **LibreChat** | **OpenWebUI** | **3-of-5 consensus**

| Component | Ours | Vercel | Assistant-UI | Lobe | LibreChat | OpenWebUI | Consensus |
|---|---|---|---|---|---|---|---|
| **Markdown engine** | react-markdown 10 | **Streamdown** | react-markdown w/ `useSmooth` (or Streamdown variant) | react-markdown 10 (via @lobehub/ui) | react-markdown 9 | marked 17 (Svelte) | react-markdown majority, but **Streamdown is the streaming-native upgrade path** |
| **Syntax highlighter** | **prismjs** | **Shiki 3** | pluggable (`react-syntax-highlighter` package) | **Shiki 3** | rehype-highlight (highlight.js) | highlight.js | Shiki for new code; mixed for legacy |
| **Math** | KaTeX (manual injection) | KaTeX via `@streamdown/math` | KaTeX via remark-math | KaTeX | KaTeX (`rehype-katex`) | marked-katex | **KaTeX everywhere** ✓ |
| **Mermaid** | manual lazy + run gate | `@streamdown/mermaid` | `componentsByLanguage` slot | @lobehub/ui mermaid | inline w/ ErrorBoundary | inline + Vega + SvgPanZoom | All gate render until fence closed; pan/zoom only OpenWebUI |
| **Reasoning block** | regex parse `<think>` + V2 block | Auto-open/close Collapsible w/ duration | ChainOfThoughtPrimitive (groups thinking + tools) | per-role component + `normalizeThinkTags` | `think` part extraction | `<details>` blocks | **Collapsible w/ duration + auto-close** |
| **Action toolbar visibility** | always visible | hover only (`group-hover:opacity-100`) | composable, app decides | hover via portal (single shared bar) | hover except last + final-completion | hover except last | **Hover-revealed except last/streaming** |
| **Action set (assistant)** | copy, save-note, branch, debug, retry, edit, delete | copy, 👍, 👎 | composable | hover-portal (varies) | TTS, copy, edit, fork, 👍/👎, regenerate, continue | siblings, edit, copy, TTS, info, 👍/👎, continue, regenerate, delete | **copy + 👍/👎 + regenerate + edit** is the floor |
| **Empty state** | minimal | greeting + 4 starter prompts | `Thread.Empty` slot + `Suggestion` | greeting + plugin gallery | greeting | greeting | **Greeting + 2-4 starter prompts** |
| **Citations** | inline chips (custom remark plugin) | none in template | none built-in | side panel | inline chips via remark + MCP UI | modal-based | **Inline chips** is the trend |
| **Scroll-to-bottom** | rAF auto-scroll, no button | `use-stick-to-bottom` + floating pill | composable | virtuoso handles | `CSSTransition` + chevron | manual + scroll-margin | **`use-stick-to-bottom` + pill button** |
| **Virtualization** | tanstack-virtual (delayed init) | **none** | none built-in | **react-virtuoso** | none in MessagesView | none | mixed; virtualize only at ≥100 msgs |
| **Branch UI** | linear list | prev/next + "X of Y" | BranchPicker primitive | dev-only branch indicator | **Fork popover** (3 modes) + sibling switch | sibling switch w/ editable index | **prev/next "X of Y"** consensus |

---

# Concrete recommendations for our app

Ranked by ROI. Each has the file we'd touch and citations.

## A. High-value migrations

### A1. Adopt Streamdown for streaming-aware markdown — `MarkdownRenderer.tsx`
React-markdown re-parses the entire AST on every chunk and breaks on partial fences/tables. Streamdown handles unclosed fences, harden-URLs, and partial markdown gracefully — matches what we already paper over with `StreamingMarkdownRenderer.tsx`.

- Drop `rehype-raw`/`rehype-sanitize` for chat output (Streamdown sanitizes by default; raw HTML is rarely useful from LLMs and is a XSS risk).
- Keep our `citationRemarkPlugin` — Streamdown accepts remark plugins.
- Migration: split `MarkdownRenderer` into `ChatMarkdown` (Streamdown) and `StaticMarkdown` (react-markdown for non-stream contexts like Anki preview).

### A2. Replace Prism with Shiki — `CodeBlock.tsx`
Three of five consensus. Better diff/dim support, dual-theme out of box (`github-light`/`github-dark`), more accurate tokenization. Vercel's caching pattern (`tokensCache` keyed by `${lang}:${len}:${first100}:${last100}`) is the right one — copy it.

Performance note: Shiki's `createHighlighter` is async. Use the singleton-promise pattern from Vercel `code-block.tsx:120-137` so you don't load every language eagerly.

### A3. Auto-open / auto-close reasoning block — `ActivityTimeline/`
Ours stays expanded forever. Vercel's pattern (open while streaming, close 1s after end, with "Thought for N seconds" label) is much better UX. Implementation is ~50 lines, mirror `components/ai-elements/reasoning.tsx`. Show duration in label.

### A4. Hover-revealed action toolbar — `MessageActions.tsx`
Today we show 7 buttons always. Three of five consensus is hover-on-desktop, always-on for the last assistant message during streaming. Move our debug/save-note/branch into an overflow `…` menu (assistant-ui's `actionBarMore` pattern) so primary actions stay 3-4: **Copy, Regenerate, 👍/👎**.

### A5. `use-stick-to-bottom` + floating pill button — `MessageList.tsx`
Replace our hand-rolled rAF/wheel/touchmove logic with the `use-stick-to-bottom` library. It already handles user-intent detection, content-resize, and smooth/instant modes. Add the floating pill (`rounded-full backdrop-blur` bottom-center) when `!isAtBottom` — currently we have no scroll button at all.

## B. Medium-value adds

### B1. Branch / variant prev-next picker
Vercel + assistant-ui + LibreChat all expose "X of Y" prev/next. We have variants in `Variant/` but no compact picker. Add inline next to the action bar when `variants.length > 1`. Don't replicate LibreChat's full Fork popover yet — we don't have the conversation tree model for it.

### B2. Streaming token smoothing à la `useSmooth`
Assistant-UI's killer feature. Buffers chunks and emits at a constant cadence so bursty token streams don't visually jitter. Mid-effort (200-300 LOC). Big perceived-quality win.

### B3. Empty state with starter prompts
We have a minimal empty state. 3-of-5 show 2-4 starter prompt cards. Hook into our existing skill/prompt registry to surface 4 contextual starters instead of generic ones — that's a natural advantage we have over generic chats.

### B4. Citations: keep inline chips, add hover preview
Our inline chip pattern is correct (matches LibreChat). Add hover-card preview (Lobe/LibreChat both use Ariakit Hovercard) showing source title + snippet before clicking — saves modal opens.

## C. Low priority / consider later

### C1. Mermaid pan/zoom (OpenWebUI's `SvgPanZoom`)
Nice but only matters for huge diagrams. Defer.

### C2. Code execution (Pyodide / Jupyter)
Cool but huge surface area. Doesn't fit our learning-app focus.

### C3. Virtualization rework
Keep `@tanstack/react-virtual`. Consensus is split — Vercel/LibreChat skip it, Lobe uses virtuoso, we have tanstack-virtual. Our delayed-init + measure-on-stream approach in `MessageList.tsx:206-222` is sound. Don't migrate to virtuoso unless we hit specific perf issues.

### C4. Streaming Markdown via marked + AST throttling (OpenWebUI)
Would require switching markdown engines anyway. If we go A1 (Streamdown), this is moot.

---

# Summary

The strongest pattern across these apps is: **purpose-built streaming markdown renderer + Shiki + collapsible reasoning with duration + hover-revealed copy/feedback/regenerate + stick-to-bottom**.

We are closest to LibreChat in stack (react-markdown + remark + custom CodeBlock) but missing its hover toolbar discipline and scroll button. The lowest-effort, highest-impact moves are A3 (auto-close reasoning), A4 (hover toolbar with overflow), A5 (stick-to-bottom button). The biggest architectural upgrade is A1 (Streamdown) + A2 (Shiki), which together would close most of the gap with Vercel's reference implementation.
