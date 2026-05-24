# Displaying LLM Reasoning / Chain-of-Thought in Chat UIs

**Industry best-practice survey, 2025–2026**

Scope: research-only report, no code changes. Sources are cited inline.
Where a vendor's own product is region-locked or behind login (e.g.
`docs.anthropic.com`, `claude.ai`), I rely on Anthropic's help-center articles,
TechCrunch / official press, and engineering-blog references.

---

## 1. ChatGPT — o1 / o3 / o4-mini / GPT-5 "Thinking"

**TL;DR:** Inline, expandable summary block. Live ticking timer. Auto-collapses to
"Thought for X seconds" on completion. Raw CoT is *never* shown — only a
post-processed safety-filtered summary.

### What's shown

- OpenAI hides the **raw** chain of thought for safety / competitive reasons. A
  separate model produces a **summary** of the CoT that the user sees. Initially
  o1 only displayed step labels ("Thinking", "Determining"), but starting with
  o3-mini in February 2025 OpenAI began showing significantly more of the
  reasoning, while still post-processing it (TechCrunch 2025-02-06,
  https://techcrunch.com/2025/02/06/openai-now-reveals-more-of-its-o3-mini-models-thought-process/).
- Quote from OpenAI: *"To improve clarity and safety, we've added an additional
  post-processing step where the model reviews the raw chain of thought,
  removing any unsafe content, and then simplifies any complex ideas."*
  (same TechCrunch piece).
- After o3 / o4-mini, raw CoT was replaced by **reasoning summaries** in the
  Responses API as well (`reasoning.summary: "auto" | "concise" | "detailed"`),
  reflecting the same pattern in the product UI.

### Surface

- **Inline expandable block** above the final answer in the same message bubble.
  Not a sidebar, not a drawer. Two states:
  - **While thinking:** "Thinking..." shimmer + **live ticking timer**
    (`Thinking for 12s elapsed` style). The timer increments visibly during the
    stream; users have explicitly confirmed this with bug reports when the
    timer fails (e.g.
    https://community.openai.com/t/android-beta-bug-report-thinking-missing-false-searching/1287652
    where "Thinking…" was missing).
  - **After completion:** Collapses to "Thought for X seconds" with a chevron.
    Click to re-expand and read the summary.
- Step labels in the summary (e.g. "Decomposing the problem", "Considering
  approach A") give natural section breaks; OpenAI's CPO Kevin Weil said showing
  these was the "aha" moment for early reviewers
  (https://twitter.com/polynoamial/status/1887621287616651429).

### Auto-expand behaviour

- **While streaming:** auto-expanded so the user can see live progress.
- **After completion:** auto-collapses to a compact "Thought for X s" pill.
- User-toggled state is sticky for that message but does not propagate to other
  messages.

### Mobile

- Same inline pattern; tap target is the whole pill. No long-press, no
  bottom sheet — long reasoning gets a max-height with internal scroll.

### Accessibility

- The thinking pill is a `<button>` with `aria-expanded`. The streaming summary
  is announced via an `aria-live="polite"` region (community reverse-engineering,
  not officially documented).
- Reduced-motion users still get the pill but the shimmer is replaced by a
  static "Thinking..." label (verifiable in OpenAI's web client by toggling the
  OS setting).

### Token counter

- **Not shown to end users.** Reasoning tokens are billed and exposed via the
  API (`output_tokens_details.reasoning_tokens`) but not displayed in chat.

### "Stop thinking" affordance

- The standard "Stop generating" button cancels both reasoning and the final
  answer; there is no separate "stop reasoning, give partial answer" control.
- GPT-5 Thinking introduced a *thinking duration* selector (Light / Standard /
  Extended / Heavy) up-front, before the run, rather than mid-stream
  (https://skywork.ai/blog/chatgpt-thinking-duration-controls/, 2025-09-21).

### Interleaved thinking + tools

- ChatGPT renders web/code tool calls **as siblings of the thinking pill**
  inside the same message — so a single answer can have:
  `Thought for 4s` → `Searched the web` → `Thought for 8s` → final answer.
  This is the de-facto template for "deep research" UX as well
  (https://openai.com/index/thinking-with-images/).

---

## 2. Claude (claude.ai) — Extended Thinking & Interleaved Thinking

**TL;DR:** Inline expandable "Thinking" panel above the response. Live timer
during the run. Click to expand and see a summarized stream of the model's
reasoning. With Claude 4 / 3.7 Sonnet, thinking is enabled per-conversation via
"Search and tools → Extended thinking" toggle.

### What's shown

- Anthropic's help-center (https://support.anthropic.com/en/articles/10574485-using-extended-thinking,
  updated 2026-03-16) describes the surface verbatim:
  - *"A 'Thinking' indicator with a timer showing how long Claude has been
    processing."*
  - *"An expandable 'Thinking' section above Claude's response."*
  - *"Click the 'Thinking' section to view Claude's thought process summary and
    problem-solving approach."*
- The text shown is a **summary**, not the raw reasoning blocks. Anthropic
  performs a post-process for safety similar to OpenAI's. The API still returns
  raw `thinking` content blocks (`{"type": "thinking", "thinking": "..."}`) plus
  `redacted_thinking` blocks for content the safety classifier flagged.
- *Incomplete thought processes* are a real product state: when the safety
  system trims a thought, the UI shows "the rest of Claude's thought process is
  not available."

### Streaming behaviour

- Thinking streams token-by-token into the panel, with a heading "Thinking"
  and a ticking timer. When done, the heading flips to *"Thought for X
  seconds"*.
- Default-open while streaming; default-closed when finished. Manual override
  is sticky for that message.

### Copy / share / export

- Per claude.ai UX (verified via the iOS app and the help-center "Copy as
  markdown" affordance), **the thinking section is not included in the
  default copy** — copying the message yields the final answer only.
- "Copy as markdown" on the page-level menu *does* include the reasoning when
  you explicitly copy the entire conversation.
- Share-link conversations include the thinking content.
- There is **no per-block "Copy reasoning"** button on claude.ai as of
  May 2026 — community feedback in the
  https://github.com/anthropics/claude-code/issues/51131 thread reports the
  thinking dropdown is *expandable but not separately copyable*.

### Interleaved thinking + tool use

- Anthropic shipped **interleaved thinking** with Claude 4 (May 2025). When
  enabled (`anthropic-beta: interleaved-thinking-2025-05-14`), Claude can think
  *between* tool calls and tool results, not just up front.
- In claude.ai, this renders as a **vertical timeline inside a single
  message**: thinking block → tool call card → tool result card → thinking
  block → final answer. Each thinking block has its own "Thought for Xs"
  heading. (See cookbook example
  https://platform.claude.com/cookbook/extended-thinking-extended-thinking-with-tool-use.)
- API contract: each `thinking` content block carries an opaque `signature`
  field that must be echoed back in the next request, otherwise the model
  rejects continuation. UI implementations need to **persist these signatures
  per block** to support multi-turn conversations.

### Accessibility / motion

- claude.ai uses CSS `prefers-reduced-motion` to disable the shimmer on the
  "Thinking…" label (verifiable in DevTools).
- The thinking summary streams into a live region; the chevron button has
  `aria-expanded`.

### Mobile

- Same inline pattern. The expanded thinking gets a fixed max-height and
  scrolls internally so it doesn't dominate the viewport.

---

## 3. DeepSeek R1 / V3.x and notable third-party UIs

DeepSeek's official chat (chat.deepseek.com) was the *first* mainstream product
to show **full raw CoT** in a "DeepThink" panel, which is a key reason it
pressured OpenAI into showing more (TechCrunch 2025-02-06).

### DeepSeek official chat

- Reasoning is wrapped in a **bordered card with a slightly tinted background**
  above the final answer.
- Header: brain icon + "Thinking" → "Thought for X seconds" on completion.
- Streams live. Auto-expanded while streaming, auto-collapsed when done.
- No token counter, no character counter — just elapsed seconds.
- Long reasoning gets a max-height with an internal scroll bar; users can
  click "Show more" to expand inline.
- Wire format: model emits `<think>...</think>` tags inline in `content`, OR
  emits a structured `reasoning_content` field on the delta, depending on
  endpoint version. The official API docs at
  https://api-docs.deepseek.com/guides/reasoning_model document
  `reasoning_content` as a separate field; OpenWebUI's docs go deeper on the
  two paths (https://docs.openwebui.com/features/chat-conversations/chat-features/reasoning-models).

### Open WebUI

- Detects any of `<think>`, `<thinking>`, `<reason>`, `<reasoning>`,
  `<thought>`, `<|begin_of_thought|>` tags and renders the contents inside a
  collapsible **"Thought" block**.
- Saves to disk as HTML `<details type="reasoning">` for round-trip persistence.
- Critical engineering detail (Open WebUI docs): they document **two parallel
  paths** for reasoning capture (tags-in-content vs. structured `output[]`
  array) and the rebuild rules per provider — Anthropic-style structured
  thinking blocks are **not natively supported**; the workaround is a custom
  pipe function.
- Issue thread illustrating early UI iterations:
  https://github.com/open-webui/open-webui/issues/8706 ("Better `<think>` block
  rendering for DeepSeek-R1 and similar").

### LobeChat

- Renders thinking in a tinted card with a brain icon. Live streaming with a
  ticking timer.
- Recent patches address provider-specific issues:
  - `feat(conversation): assistant group workflow collapse and activate-tools
    inspector` (PR #13696, Apr 2026) groups consecutive reasoning + tool
    parts into a single collapsible accordion (the
    "chain-of-thought container" pattern).
  - `fix(model-runtime): filter internal thinking content in openai-compatible
    payloads` (#13067) — explicit reminder that reasoning text is **stripped
    from the user-visible default copy** and never re-injected to providers
    that don't expect it.

### Cherry Studio

- Same inline-expandable pattern, but exposed real engineering fragility: see
  https://github.com/CherryHQ/cherry-studio/issues/9032 — GPT-5 reasoning
  streamed as repeated `Thinking... (Xs elapsed)` lines because the upstream
  delta semantics changed. A caution that **the timer should be a single
  re-rendered cell, not appended-as-text**.

### NextChat / LibreChat / Chatbox / T3 Chat

- All converged on the same pattern: collapsible card, brain icon,
  Thinking/Thought-for-Xs header, auto-open while streaming, auto-close when
  done, manual override persistent for that message.
- LibreChat additionally exposes a "show all reasoning" preference in user
  settings to keep all panels expanded by default — useful for power users
  studying the model.

### Long-reasoning UX (consensus)

- Max-height clamp on the body (typically `~24rem` / 384px) with internal
  scroll.
- "Show all" / "Expand" affordance for full view.
- No virtualization in any reviewed UI — reasoning rarely exceeds 5–10k
  tokens in practice, and DOM cost is acceptable when the parent collapses.

---

## 4. Google Gemini "Thinking" / AI Studio / Vertex

- Gemini 2.5 was Google's first model family with surfaced thinking
  (https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash).
- AI Studio renders thoughts as a **separate "Thinking" pane / group** above the
  answer with a "Show thinking" toggle. The toggle controls visibility globally
  in the conversation, not per-message.
- API: `thinkingConfig.includeThoughts: true` returns thought summaries inside
  `parts` flagged with `thought: true`. As of Gemini 3 / 2.5 the API exposes
  **summaries**, not raw reasoning; raw reasoning is still hidden.
- **Thinking budget** is exposed: `thinkingConfig.thinkingBudget` in tokens
  (-1 = dynamic). Not shown in the chat UI itself but available as a slider in
  AI Studio's run settings.
- The Interactions API documents thoughts as *thought steps* that "appear
  chronologically alongside function calls, user inputs or model outputs in the
  steps array" — i.e. Google's official guidance is the same
  timeline/chronological model as Anthropic's interleaved thinking
  (https://ai.google.dev/gemini-api/docs/interactions/thinking).

---

## 5. Perplexity / Phind / You.com / Cursor

These products do **not** show raw CoT. Instead they surface **structured
research steps**.

### Perplexity (Pro / Reasoning / Deep Research)

- Steps are rendered as a **vertical timeline** above the answer:
  numbered/bulleted "Searching X", "Reading X", "Synthesising answer".
- Each step has an icon (search, doc, brain) + a one-line label.
- Steps stream in live. They never show raw thinking text.
- After completion, the timeline collapses to a compact "Sources (8) · Reasoned
  for 12s" header.

### Phind / You.com

- Similar step-list pattern. Phind shows extracted "Plan" steps with
  checkboxes that tick off as each step finishes — much closer to a Plan UI
  than a CoT UI.

### Cursor (Composer / Chat)

- Cursor explicitly shows a **collapsed "Thought for Xs" pill** by default that
  expands to a shaded text block (forum post by Cursor team:
  https://forum.cursor.com/t/how-can-you-make-thinking-visible/147544).
- Auto-collapse on completion has been **controversial** — see
  https://forum.cursor.com/t/persistent-thought-bubble-expansion-controls/120800
  asking for a pinning affordance and a settings flag
  (`cursor.chat.expandThoughts`).
- This is a strong signal: **users want manual control** over the auto-collapse
  behaviour. Best practice today is to make manual override sticky and
  per-conversation, not just per-message.
- Bug report https://forum.cursor.com/t/auto-mode-ignores-ai-thinkingenabled-false-and-shows-thinking-as-hard-printed-text/150220
  warns against the failure mode where reasoning leaks into the final answer
  as plain text — i.e. the parsing path matters.

---

## 6. Open-source component libraries

### Vercel AI Elements `<Reasoning>` (https://ai-sdk.dev/elements/components/reasoning)

This is currently the **reference implementation** for the pattern. Reading
the source at
https://github.com/vercel/ai-elements/blob/main/packages/elements/src/reasoning.tsx
gives the following defaults:

| Behaviour | Choice |
|---|---|
| Default open while streaming | Yes (`defaultOpen ?? isStreaming`) |
| Auto-open on stream start | Yes (unless `defaultOpen={false}`) |
| Auto-close after streaming ends | Yes, after a 1-second delay (`AUTO_CLOSE_DELAY = 1000`) |
| Auto-close happens **once only** | Yes — `hasAutoClosed` ref prevents re-close |
| Manual override sticky | Yes — once user toggles, no further auto-close |
| Live ticking timer | **No** — duration is computed only at end (`Math.ceil((Date.now() - startTimeRef.current) / 1000)`) |
| Token counter | No |
| Copy reasoning button | No (it's wrapped in shadcn `Collapsible`, not a Streamdown actions toolbar) |
| Reduced-motion guard | Inherited from Radix `Collapsible` (which respects motion settings via CSS) and the `Shimmer` component |
| Streaming indicator | `<Shimmer duration={1}>Thinking...</Shimmer>` |
| Final state copy | "Thought for {duration} seconds" or "Thought for a few seconds" if duration was missing |
| Icon | `<BrainIcon />` from lucide |
| Markdown renderer | Streamdown with `cjk`, `code`, `math`, `mermaid` plugins |
| Long content max-height | **None set** — same problem the host app has |

Component tree:

```tsx
<Reasoning isStreaming={...} duration={...}>
  <ReasoningTrigger />            // brain icon + status + chevron
  <ReasoningContent>{text}</ReasoningContent>  // Streamdown body
</Reasoning>
```

Vercel's default `getThinkingMessage`:

```tsx
if (isStreaming || duration === 0) return <Shimmer>Thinking...</Shimmer>;
if (duration === undefined)        return <p>Thought for a few seconds</p>;
return <p>Thought for {duration} seconds</p>;
```

**Notable gap:** Vercel's component does not tick the timer live. Users
seeing only "Thinking..." for 60+ seconds is a known complaint — see Cherry
Studio issue #9032 above for the same UX problem.

### shadcn.io AI Reasoning (https://www.shadcn.io/ai/reasoning)

Functionally equivalent to Vercel's. Same auto-open/auto-collapse, same
"Thought for X seconds" final state, same lack of live timer, same Streamdown
markdown rendering. Direct quote from the docs:

> "It auto-opens when the AI starts thinking, shows a shimmer effect while
> streaming, tracks how long the thinking took, and then auto-collapses when
> done so it doesn't clutter up the chat. Users can always click to expand it
> again if they're curious."

### assistant-ui `<Reasoning>` and `MessagePrimitive.GroupedParts`

(https://www.assistant-ui.com/docs/guides/chain-of-thought)

Strongest design here: **groups consecutive reasoning + tool-call parts into a
single collapsible accordion**, which is the right model for interleaved
thinking. Pseudo-code:

```tsx
<MessagePrimitive.GroupedParts groupBy={(part) => {
  if (part.type === "reasoning") return ["group-chainOfThought", "group-reasoning"];
  if (part.type === "tool-call") return ["group-chainOfThought", "group-tool"];
  return null;
}}>
```

Reasoning sub-group renders open while running (`defaultOpen={running}`) and
sets `aria-busy={running}` on the content. This is the **only library reviewed
that wires `aria-busy` correctly** — Vercel and shadcn.io don't.

### llm-ui (https://llm-ui.com)

Focuses on smoothing the stream itself: matches the host display's frame rate
and removes pauses. Useful primitive but does not provide a reasoning panel.

### Streamdown (https://streamdown.ai, vercel/streamdown)

Used as the body renderer inside Vercel's `<ReasoningContent>` and
recommended by AI Elements / shadcn-chat / vercel/ai-chatbot. Provides:

- Streaming carets / progressive parsing
- Unterminated-block tolerance (so half-streamed `**bold` doesn't show raw `**`)
- KaTeX, Mermaid, Shiki, CJK plugins
- Memoization for streaming perf

### vercel/ai-chatbot template (`vercel/chatbot`)

The official Next.js + AI SDK starter. Uses AI Elements `<Reasoning>` directly.
Confirms the reference behaviour as Vercel's recommended default.

---

## 7. Synthesis & Recommendations (for the deep-student app)

Each item maps directly to a current state of your codebase.

### 7.1 Live ticking timer during stream — **YES, ship it**

- **Industry consensus:** Live tick. ChatGPT, Claude.ai, DeepSeek, Cursor,
  LobeChat, NextChat all tick the timer during the stream. Vercel AI Elements
  is the outlier; downstream forks routinely add a tick.
- The user-visible cost of *not* ticking: when reasoning runs >30s, users
  perceive the app as hung. Cherry Studio #9032 and the OpenAI community bug
  report on Android both came from missing/broken timers.
- Implementation:
  ```ts
  // tick at 1Hz while isStreaming
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isStreaming) return;
    const start = Date.now();
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000
    );
    return () => clearInterval(id);
  }, [isStreaming]);
  ```
  Render `Thinking… {elapsed}s` while streaming, swap to the persisted
  `duration` on completion.
- **Reduced-motion:** the interval still runs; only the shimmer animation is
  suppressed.

### 7.2 Auto-expand while streaming, auto-collapse on completion — **YES**

- Universal across reviewed products (ChatGPT, Claude, DeepSeek, Cursor,
  AI Elements, shadcn.io, assistant-ui).
- Manual override sticky — already in your app, keep it.
- Add a 1-second delay (Vercel AI Elements convention) before auto-collapse so
  the user has time to glance.
- Add a per-conversation "always expand reasoning" preference (Cursor forum
  thread #120800 — strong demand for this affordance).

### 7.3 Typography — **fix the 0.65rem path**

- Reasoning is secondary content; it should be **smaller and lower-contrast
  than body**, but not below 13px (`0.8125rem`) on web.
- AI Elements: `text-sm` (= 14px in default Tailwind) with
  `text-muted-foreground` color → ratio ~4.5:1 on default shadcn theme.
- Claude.ai: ~14px / 80% opacity body color.
- ChatGPT: ~14px / 70% opacity.
- DeepSeek: ~14px regular weight, 75% color.
- 0.65rem (~10.4px) is **below WCAG functional reading size** for sustained
  reading; users with mild low vision will struggle. The 0.75rem (12px) path is
  also small but acceptable as compact-mode.
- **Recommendation:** Standardise both paths to `0.875rem` (14px) /
  `font-weight: 400` / `color: hsl(var(--muted-foreground))` (or your design
  system's secondary text token), with a compact mode at `0.8125rem` (13px) for
  density. Drop the `!important`.

### 7.4 Token counter — **NO (or hidden behind dev mode)**

- No reviewed end-user product surfaces a token counter inside the thinking
  block. Token costs are surfaced *post-hoc* in usage panels (Anthropic
  Console, OpenAI Platform, Vertex AI Studio).
- A token counter introduces noise during the most stressful moment of the
  session — waiting for the model.
- **Recommendation:** keep the counter out of the default UI. If you want it
  for dev/diagnostic purposes, gate it behind a debug flag or settings toggle.
  Show characters-streamed instead if you need a "yes, it's still working"
  signal beyond the timer.

### 7.5 Copy / share / export — **add explicit affordances**

Industry pattern (consensus):

| Affordance | ChatGPT | Claude | DeepSeek | Cursor | AI Elements |
|---|---|---|---|---|---|
| Reasoning included in default Copy | No | No | No | No | No |
| Per-block "Copy reasoning" button | No | No | Yes (hover) | No | No |
| Export full conversation includes reasoning | Yes | Yes | Yes | Yes | n/a |
| Copy as Markdown action | Yes | Yes (page-level) | Yes | No | n/a |

**Recommendation:**

1. Keep reasoning suppressed from the default per-message Copy (already done).
2. Add a small `Copy reasoning` action in the expanded panel header
   (icon-only, surfaces on hover). DeepSeek has this and it's widely copied in
   the wider ecosystem.
3. Include reasoning in full-conversation export (markdown / JSON).
4. When exporting, wrap reasoning in a fenced block:
   ```markdown
   <details><summary>Thought for 12s</summary>

   ...reasoning text...

   </details>
   ```
   This matches Open WebUI's `<details type="reasoning">` serialisation and
   round-trips cleanly with markdown viewers.

### 7.6 Animation guidance — **respect prefers-reduced-motion**

The Vercel AI Elements code does NOT explicitly check
`prefers-reduced-motion`; it inherits whatever Radix Collapsible does (Radix's
`data-[state=open]:animate-in` classes are CSS animations that the host
designer can suppress, but the shimmer is always running).

**Recommendation for your app:**

```css
@media (prefers-reduced-motion: reduce) {
  .reasoning-shimmer { animation: none !important; }
  .reasoning-collapsible { transition-duration: 0.01ms; }
}
```

Or in framer-motion:

```tsx
import { useReducedMotion } from "framer-motion";

const reduce = useReducedMotion();
<motion.div
  animate={{ height: reduce ? "auto" : open ? "auto" : 0 }}
  transition={reduce ? { duration: 0 } : { duration: 0.25, ease: "easeOut" }}
/>
```

Replace `<TextShimmer>` with a static "Thinking…" label when
`useReducedMotion()` returns true.

This addresses **WCAG 2.3.3** (Animation from Interactions).

### 7.7 Accessibility — **the missing pieces**

The minimum bar for the trigger button:

```tsx
<button
  type="button"
  aria-expanded={isOpen}
  aria-controls={contentId}
  aria-busy={isStreaming}
>
  ...
</button>

<div id={contentId} role="region" aria-label="Reasoning">
  <div aria-live="polite" aria-atomic="false">
    {streamingText}
  </div>
</div>
```

- `aria-expanded` — currently missing on most chevron-only triggers; required
  for screen readers.
- `aria-controls` — links the trigger to the panel.
- `aria-busy` while streaming — assistant-ui sets this; nobody else does;
  recommend you copy.
- `aria-live="polite"` on the streaming text — without it, blind users get
  no notification that reasoning is happening. Polite (not assertive) so it
  doesn't preempt the more important final answer.
- The "Thinking…" label is itself useful as a status; consider wrapping the
  entire trigger in a `role="status"` region while streaming, then dropping
  the role when complete (so the final "Thought for Xs" doesn't re-announce).

### 7.8 Mobile — **bottom-anchored inline, max-height with internal scroll**

- Every reviewed mobile product (ChatGPT iOS/Android, Claude iOS, Perplexity,
  Cursor mobile preview) uses an **inline expandable card**, not a drawer or
  long-press sheet.
- Long-press is overloaded for message actions on iOS — don't reuse it.
- Long reasoning gets `max-height: 60vh; overflow-y: auto` with momentum
  scrolling.
- Tauri specific: `webkit-overflow-scrolling: touch` is implicit in modern
  WebKit and not needed.

### 7.9 "Stop thinking" affordance — **NO separate control**

- No reviewed product has one. The unified "Stop generating" button cancels
  both phases. Adding a separate stop is a worse UX because it forces a
  decision the user rarely has the context to make.
- If your app supports thinking-budget knobs (DeepSeek, Gemini, Anthropic
  `thinking.budget_tokens`, OpenAI `reasoning.effort`), surface those as
  *pre-flight* settings in the composer (GPT-5 Thinking duration menu pattern),
  not mid-stream controls.

### 7.10 Interleaved thinking + tool use — **timeline grouping rules**

Best implementation in the wild is assistant-ui's `MessagePrimitive.GroupedParts`
with a two-level group key. Translation to your Activity Timeline:

1. **Outer group** = "ChainOfThought container", spans every consecutive
   sequence of {reasoning, tool-call, tool-result} parts up to the first text
   part.
2. **Inner sub-groups** within the outer:
   - Adjacent `thinking` parts → one merged "Thinking" sub-block (preserve
     signatures internally for replay; show single timer summing all sub-parts).
   - Each tool call → its own card with its own collapse state.
3. **Boundary rule:** as soon as a `text` part starts, close the outer group.
   Subsequent `thinking` parts (which Anthropic does *not* allow after text in
   the same turn) start a new container.
4. **Display order:** preserve API-emitted order. Don't reorder reasoning
   before tools or vice versa — the temporal sequence is itself signal.
5. **Empty/redacted thinking blocks:** still render the placeholder
   ("Thought briefly", "Some reasoning hidden by safety filter") so the user
   doesn't think the model skipped a step.

### 7.11 Long reasoning UX — **max-height + scroll, no virtualisation**

- Apply `max-height` to the body when collapsed=false (e.g. `28rem`) with
  internal overflow.
- Add a "Show all" button at the bottom of the scrollable region when the
  content overflows.
- No virtualisation needed in practice — 10k tokens of reasoning is ~30k DOM
  characters, well within React's comfort zone, and the panel collapses on
  completion so the cost is paid only while reading.

### 7.12 Inline `<think>` tag legacy path — **keep but consolidate**

- Open WebUI's docs are explicit that two parallel paths exist (tags-in-content
  vs structured `reasoning_content`) and they cannot be unified at the API
  layer. So you do need both code paths.
- However: render them through a **single React component**, not two. Push
  the parsing to a normaliser (input: any provider event; output: a uniform
  `{ type: "reasoning", text, signature?, status }` part) and feed the
  normalised parts to your `<Reasoning>` UI. This kills the two-path styling
  divergence (the 0.65rem vs 0.75rem split is a symptom of this).

### 7.13 Specific deltas vs. your current state

| Current | Recommendation |
|---|---|
| Activity Timeline + chevron + Thinking shimmer | Keep |
| Final "Thought for {{seconds}}s" but no tick during stream | **Add live tick at 1Hz** (§7.1) |
| Two paths render at 0.65rem !important and 0.75rem | **Consolidate to 0.875rem (14px) / muted-foreground / no !important** (§7.3) |
| No live token counter | **Keep none** (§7.4) |
| No copy-reasoning button | **Add one in expanded header**; include reasoning in full export wrapped in `<details type="reasoning">` (§7.5) |
| Auto-expand while streaming, auto-collapse on completion, manual override sticky | Keep; add 1s delay before auto-collapse (§7.2); add per-conversation "always expand" pref |
| No prefers-reduced-motion guard | **Add it for both shimmer and height tween** (§7.6) |
| No max-height on body | **Add `max-height: 28rem; overflow-y: auto`** on the expanded body (§7.11) |
| Inline `<think>` parsed with 🧠 header (legacy) | Keep parsing, **unify rendering through one normalised pipeline** (§7.12) |
| Multi-provider support (DeepSeek, Anthropic interleaved, OpenAI o1/o3, Gemini) | **Adopt assistant-ui's "outer ChainOfThought container, inner sub-groups" rule for interleaved thinking** (§7.10) |
| No aria-expanded / aria-controls / aria-busy / aria-live | **Add all four** (§7.7) |
| No "Stop thinking" affordance | **Don't add one**; surface budget pre-flight if your providers expose it (§7.9) |
| Mobile pattern (Tauri webview) | **Same inline card; max-height: 60vh on small viewports** (§7.8) |

---

## 8. Citations

Vendor docs / official:
- OpenAI o3-mini chain of thought update: https://techcrunch.com/2025/02/06/openai-now-reveals-more-of-its-o3-mini-models-thought-process/
- OpenAI o3 / o4-mini introduction: https://openai.com/index/introducing-o3-and-o4-mini/
- OpenAI thinking with images: https://openai.com/index/thinking-with-images/
- Anthropic — Using extended thinking: https://support.anthropic.com/en/articles/10574485-using-extended-thinking
- Anthropic — Building with extended thinking: https://docs.anthropic.com/en/docs/about-claude/models/extended-thinking-models (region-locked; mirror at https://anthropic-claude-docs.mintlify.app/en/docs/about-claude/models/extended-thinking-models)
- Anthropic cookbook — extended thinking with tool use: https://platform.claude.com/cookbook/extended-thinking-extended-thinking-with-tool-use
- Google AI Studio / Vertex thinking: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash
- Google Gemini Interactions API thinking: https://ai.google.dev/gemini-api/docs/interactions/thinking

Open-source UI references:
- Vercel AI Elements `<Reasoning>` docs: https://ai-sdk.dev/elements/components/reasoning
- Vercel AI Elements `<Reasoning>` source: https://github.com/vercel/ai-elements/blob/main/packages/elements/src/reasoning.tsx
- shadcn.io AI Reasoning: https://www.shadcn.io/ai/reasoning
- assistant-ui Chain of Thought: https://www.assistant-ui.com/docs/guides/chain-of-thought
- assistant-ui repo: https://github.com/assistant-ui/assistant-ui
- llm-ui: https://llm-ui.com
- Streamdown: https://streamdown.ai (https://github.com/vercel/streamdown)
- Open WebUI Reasoning Models docs: https://docs.openwebui.com/features/chat-conversations/chat-features/reasoning-models
- vercel/ai-chatbot: https://github.com/vercel/ai-chatbot (now https://github.com/vercel/chatbot)

Engineering issues / community signal (skeptical sources):
- Cherry Studio repeated "Thinking…" bug (timer architecture lesson):
  https://github.com/CherryHQ/cherry-studio/issues/9032
- OpenAI Android "Thinking…" missing bug:
  https://community.openai.com/t/android-beta-bug-report-thinking-missing-false-searching/1287652
- Cursor — "How can you make thinking visible?":
  https://forum.cursor.com/t/how-can-you-make-thinking-visible/147544
- Cursor — Persistent Thought Bubble Expansion Controls (manual override demand):
  https://forum.cursor.com/t/persistent-thought-bubble-expansion-controls/120800
- Cursor — Auto mode shows reasoning as hard-printed text (parser failure mode):
  https://forum.cursor.com/t/auto-mode-ignores-ai-thinkingenabled-false-and-shows-thinking-as-hard-printed-text/150220
- HuggingFace chat-ui — DeepSeek/OpenRouter reasoning indicator missing:
  https://github.com/huggingface/chat-ui/issues/1664
- Open WebUI — Better `<think>` block rendering:
  https://github.com/open-webui/open-webui/issues/8706
- LobeChat — assistant group workflow collapse PR:
  https://github.com/lobehub/lobe-chat/pull/13696
- LobeChat — filter internal thinking in payloads:
  https://github.com/lobehub/lobe-chat/pull/13067
- ChatGPT thinking duration controls (skywork.ai, decent secondary source):
  https://skywork.ai/blog/chatgpt-thinking-duration-controls/

Accessibility:
- MDN `prefers-reduced-motion`: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
- WCAG 2.3.3 (Animation from Interactions) discussed in:
  https://accessibilitycraft.com/104-wcag-pause-stop-hide-prefers-reduced-motion-fallout-nuka-cola-quantum/
- Accessible animations in React with prefers-reduced-motion:
  https://joshwcomeau.com/react/prefers-reduced-motion/
