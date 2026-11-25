# 02 · AI Chat, Study Spaces & Memory v2

> DeepStudent's chat is built around your actual study materials — and with **Memory v2**, your AI remembers how you like to be taught, tracks your real weak spots across courses, shows you exactly which memories shaped every answer, and lets you roll back changes anytime.

![AI Chat with grounded citations and study artifacts](../images/chat-desktop-light.webp)

---

## 1. Grounded AI Chat & First-Time API Setup

**What you want to do**: Ask questions grounded in your PDFs, notes, and lectures without wrestling with prompts or setup errors.

1. **Connect a model if you haven't yet**: If no model is set up, the chat composer displays a clear inline banner: *"No AI model is configured yet. Connect a provider to start chatting."* Click **Configure AI Model** to pick one of the **15 built-in providers** (or local Ollama). If you hit `Enter` before adding a key, DeepStudent gently highlights the banner and keeps your typed draft intact.
2. **Attach your material or choose a search scope**:
   - Drag in PDFs, images, or notes directly, or click **Read alongside chat** from any open document to keep the source visible right beside the conversation.
   - Use the `+` menu's **Choose retrieval scope (course / folder)** to restrict knowledge-base search to a single course folder (**Only search: Folder**) or search all materials.
3. **Ask, compare, and turn answers into study artifacts**:
   - Switch models or reasoning effort right from the composer when a problem needs deeper step-by-step math or code derivations.
   - AI can reply with clean interactive study cards, tables, diagrams, or runnable previews alongside normal Markdown — and you can turn any explanation directly into a note, mind map, flashcard batch, or draft question set.

**What you get**: Answers anchored to your own textbook pages and notes with clickable citations, rather than generic internet summaries.

---

## 2. Organize by Course with Study Spaces

**What you want to do**: Keep Linear Algebra, Organic Chemistry, and IELTS Prep completely organized — each with its own materials, exam countdown, memory boundary, and window layout.

1. **Create a space**: Open the Study Space switcher and click **New Study Space**. Give it a course name and link its **Root Folder** (or add zero-copy **Cross-Space Mounts** from Library without duplicating large files).
2. **Configure goals and layout** (optional):
   - In **Goals & FSRS**, set a **Target Exam Date**, **Daily Budget (min)**, **Target Retention**, and **Default Flashcard Deck**.
   - In **Mounts & Workbench**, choose a **Workbench Layout Preset** (**Chat Focus**, **Split Reader & Chat**, **Split Notes & Chat**, **Practice & Flashcards**, or **Keep Freeform Layout**).
3. **Choose how memory behaves in this space**: Set **Memory Scope** to control whether chats in this space share global memories or stay completely separated (see the 3-layer scope guide below).

**What you get**: Switching Study Spaces restores your course's files, exam countdown badge (`D-14`), search scope, memory boundary, and preferred window layout in a single click.

---

## 3. Memory v2: Rules, Learner Profile & Dual-Zone Workbench

DeepStudent v0.20.9 upgrades AI memory into a transparent **Dual-Zone Memory Workbench** under **Settings → Memory** (and accessible via **AI Memory** in Files):

- **Top zone — Long-Term Memory Kernel**: Compact, structured memory that is **automatically applied on Turn 1 of every new session** and stays consistent throughout the conversation. It holds your **Interaction Hard Rules**, **Active Weak Points**, and **Learning Goals**.
- **Bottom zone — Searchable Memory Archive** *(optional)*: Longer background notes stored as regular Markdown notes in your chosen folder (**My Memories** by default). You can create subfolders right on the page and move archive memories between folders anytime.

### Add Interaction Hard Rules (100% Enforced from Turn 1)

**What you want to do**: Stop repeating the same instructions in every chat (for example, *"Always give a hint before revealing the solution"* or *"End each explanation with 1 self-check question"*).

1. Open **Settings → Memory** and locate **Interaction Hard Rules (100% enforced from Turn 1)**.
2. Type your instruction in the input box, pick a scope (**Global**, **Math**, **English**, or **Essay grading**), and optionally toggle **Pinned** so high-priority rules stay protected if your rule budget fills up.
3. Click **Add rule**.

**What you get**: Your rule takes effect on Turn 1 of every matching new session — no more reminding AI how to teach you. A live **Rules** budget meter (up to 1,500 characters) keeps your rule set crisp so AI never loses track of your preferences. Accidentally deleted a rule? Click **Undo** on the 5-second toast to bring it right back.

### Understand the 3 Layers of Scope (Without Confusion)

DeepStudent keeps scope control clean by separating three different questions:

| Layer | Where You Set It | What It Controls |
|---|---|---|
| **1. Hard Rule Scope** | **Long-Term Memory Kernel** → rule dropdown | Whether a teaching rule applies everywhere (**Global**) or only in a specific subject/mode (**Math**, **English**, **Essay grading**). |
| **2. Study Space Memory Scope** | **Edit Study Space** → **Memory Scope** | How a course space blends space-local memories with your global profile: **Space Priority + Global**, **Space Isolated Only**, or **Global Memory Only**. |
| **3. Task Workspace Folder** | Chat task settings → **Default project folder** | Optional local read-write folder for file-editing tasks (strictly bounded to that folder with approval prompts). |

### Automatic Weak Points & Learning Goals

As you review flashcards, practice Question Sets, or grade essays, DeepStudent automatically logs recurring weak spots (when accuracy drops below 65%) under **Active Weak Points** alongside occurrence counts — and lets you add explicit **Learning Goals** (such as *"Reach IELTS Writing 7.0 by December"*).

- Click **Preview prompt** at any time to inspect the exact long-term memory block AI will see on Turn 1 of your next session.
- Remember that memory stays **stable within an active session**: if you edit a rule mid-conversation, existing turns keep their original snapshot and your update smoothly applies starting on the **next turn**.

---

## 4. See & Edit What AI Remembered on Every Answer (Attribution Pill)

**What you want to do**: Check *why* AI answered in a particular style or focused on a specific weak topic — and immediately remove an outdated rule without leaving chat.

1. Look underneath an AI response for the compact badge: **`Memory Kernel · N rules / M weak points`**.
2. Click the pill to open **Active Memory Snapshot (This Turn)** — an immutable record of the exact rules, weak points, and goals injected for that specific turn (and for each alternate reply if you regenerated).
3. Adjust inline in one click:
   - Click **Forget this rule** next to any rule you no longer want (with an instant **Undo** banner if you change your mind).
   - Click **Mark mastered / forget** next to a weak point you have conquered.
   - Click **Memory settings** to open the full Memory Kernel panel.

**What you get**: Total transparency over AI personalization. If you changed rules mid-chat, the panel also displays a clear drift notice (*"Memory rules updated mid-session; changes take effect starting from the next turn"*) so you always know what is active right now versus next turn.

---

## 5. History, 10-Version Rollback & Dialectic Reflection

**What you want to do**: Undo an unwanted memory update or let DeepStudent tidy up conflicting rules and recurring mistakes automatically.

### Roll Back Your Learner Profile (Latest 10 Snapshots)

1. In **Long-Term Memory Kernel**, click the always-visible **History (N)** button.
2. Browse **Memory Change History** (every `ADD`, `UPDATE`, and `DELETE`) and **Learner Profile Snapshots (latest 10 versions, click to rollback)**.
3. Click **Rollback** next to any earlier snapshot (`vN · X weak points · Y goals`).

**What you get**: Instant peace of mind — you can experiment freely with auto-extraction (**Off** / **Balanced** / **Aggressive**) or reflection cleanup knowing you can always step back up to 10 versions.

### Clean Up with Dialectic Reflection (**Suggestions**)

1. Click **Suggestions** in the **Long-Term Memory Kernel** header.
2. DeepStudent analyzes your recurring weak points, overlapping instructions, and rule budget to generate actionable **Curation suggestions**.
3. Act on each card with one click:
   - **Promote to rule** — turn a recurring study habit or struggle into a Turn-1 Hard Rule.
   - **Remove second rule** — resolve two rules that contradict each other.
   - **Mark mastered** — clear an old weak point that no longer needs extra attention.

**What you get**: A self-maintaining memory kernel that stays lean, conflict-free, and focused on what actually improves your grades right now.

<details>
<summary>Optional technical note: How Memory v2 keeps sessions fast and predictable</summary>

On Turn 1 of a new session, DeepStudent compiles your active L1 Hard Rules and L2 Learner Profile into a compact session-frozen `<memory_kernel>` block so prompt caching stays hot and answers stay consistent. If you add, forget, or roll back a rule mid-session, DeepStudent appends a lightweight `<memory_delta>` starting on the next turn without rewriting earlier history.

</details>

---

## Next Steps

- Connect PDF highlights, split-pane notes, lectures, and translation → [03 · PDF Reading, Notes, Lectures & Translation](./03-pdf-notes-media-study-loop.md)
- Turn weak points and chat explanations into FSRS-6 flashcards and daily exam sprints → [04 · Flashcards, FSRS-6, Exam Sprint & Question Sets](./04-flashcards-exams-fsrs.md)

<!-- Baseline: DeepStudent v0.20.9 -->
