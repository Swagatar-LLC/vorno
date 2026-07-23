# Working with Projects and Big Tasks in Vorno

Vorno isn't a chatbot. It's closer to a small office of capable assistants — and you're the director. This guide teaches you how to run that office: a simple mental model first, then how to break up big work and direct traffic, and finally a technical appendix for readers who want to see the machinery.

You don't need any technical background for parts 1 and 2. If you've ever delegated work to a person — a contractor, a colleague, an intern — you already have the instincts. This guide maps them onto Vorno.

---

## Part 1 — The Mental Model

### Your conversation is a desk, not the whole office

When you type in a Vorno session, you're talking to one assistant at one desk. For most work, that's all you need: ask a question, get an answer; ask for a change, watch it happen.

But some work is too big for one desk:

- "Go through **all** of my invoices and categorize them."
- "Build me a complete presentation from these notes — I'll check back after lunch."
- "Research these four vendors and tell me which one to pick."

For work like this, your assistant doesn't grind through it alone in the chat. It **delegates** — to helpers, to background workers, or to an organized crew. Your job isn't to manage the helpers. Your job is to describe the outcome clearly and decide how much rigor it deserves.

### The three questions

Every piece of work you hand to Vorno sorts itself with three questions:

**1. How big is it?**
Small work happens right in the conversation. Big work — dozens of files, hours of effort, many independent pieces — gets delegated so it doesn't clog your chat.

**2. Do I need to sit with it?**
Some work you want to watch and steer. Other work you want to hand off — "come back when it's done" — so you can keep talking to Vorno about other things while it runs.

**3. Does it have parts that need coordinating?**
"Summarize this document" is one job. "Find every problem, double-check each one, and give me only the confirmed ones" is an assembly line — several kinds of work, in stages, with quality control between them.

Your answers point to one of four working styles.

### The four working styles

**Right here in the chat** — the default. Questions, edits, quick lookups, anything your assistant can just do. No ceremony.

**A helper** — your assistant quietly sends a colleague off to dig through a big pile ("find every mention of the Henderson contract across my files") and brings you back just the answer, not the pile. This usually happens automatically; you'll see brief activity while helpers work. One thing worth knowing: **helpers report to your assistant, not to you.** If it matters, your assistant relays it — that's normal, not a helper "doing nothing."

**A background task** — work that takes a while and doesn't need you. Your assistant hands it to a worker at another desk and your conversation comes right back to you. You'll see a **Task chip** at the top of the session (for example, `Task · Build quarterly deck · 12m`) showing what's running and for how long. Ask "what's running?" any time for an honest status.

**A workflow** — an organized crew with a plan. Not one worker but many, following a script: split the work, do the pieces in parallel, check each other's results, merge everything into one deliverable. You'll see a **Workflow chip** (for example, `Workflow · Audit all invoices · 8 agents · 45m`). Workflows are the power tool for *thorough* work — and because they can involve dozens of workers, **Vorno never starts one on its own. You have to ask.** More on that below.

There's a fifth level above all of these: when work is big enough to deserve its **own session** — its own card on your board, its own status, its own lifecycle — you (or an automation) spin one up rather than burying a project inside another conversation. Sessions are how *projects* stay organized; the four styles above are how *work inside a session* gets done.

### The instinct to build

If you remember one rule: **small stays simple; big gets structure — and you only add as much structure as the work truly needs.** A quick question never needs a workflow. A full audit of a year's records shouldn't be done casually in a chat. Matching the size of the machinery to the size of the job is the whole skill, and Vorno's assistant is designed to help you find that match.

---

## Part 2 — Breaking Up Work and Directing Traffic

### Describe outcomes, not machinery

Here's the most useful thing in this guide: **you almost never need to tell Vorno *how* to organize the work.** Describe what you want, how thorough it should be, and when you need it. The assistant picks the right working style.

Compare:

| Instead of prescribing... | Say... |
|---|---|
| "Spawn four subagents to check each folder" | "Check all four folders — I want to be sure nothing's missed." |
| "Use a background task for the report" | "Build the report **in the background** — I want to keep working while it runs." |
| "Run a three-stage verification pipeline" | "Find the problems, then **double-check each one** before you show me. Only confirmed issues." |

Notice the middle row: "in the background" *is* worth saying, because only you know whether you want your conversation back. That's one of the few times naming the mechanism helps.

### The few times to be explicit

Being prescriptive helps in exactly these situations:

1. **You want a workflow.** Workflows are opt-in by design — they can put many agents to work at once, and that scale of effort (and cost) should be your call, never inferred. Say "use a workflow," or describe the assembly line you want: "find issues, verify each one, then summarize."
2. **You care about foreground vs. background.** "Do this in the background" or "stay with me on this one."
3. **You have a rigor bar.** "Quick check" and "be exhaustive — I'm making a decision with this" produce very different (and differently priced) efforts. Say which one you mean.
4. **You want a deadline behavior.** "Give me whatever you have by 3pm" beats an open-ended run.
5. **It went wrong last time.** Course-correct plainly: "Last time you missed the archived folders — include them." Vorno can remember corrections like this for the future if you ask.

Everything else — how many helpers, how the stages connect, which pieces run in parallel — is the assistant's job, and it genuinely does it better without micromanagement.

### Breaking up a big job: the director's checklist

When you're staring at something large ("get my whole bookkeeping mess sorted"), don't try to plan the agent choreography. Instead, answer these for your assistant:

- **What does done look like?** ("Every 2025 receipt categorized and totaled in one spreadsheet.")
- **What's in scope, what's out?** ("Just the business account. Ignore personal.")
- **How thorough?** ("I'd rather it take longer and be right — this goes to my accountant.")
- **What should it ask vs. decide?** ("If a receipt is ambiguous, flag it, don't guess.")
- **When do you want to hear back?** ("Check in with a plan first" / "just do it and show me the result.")

Give those five answers and Vorno can organize almost anything. Leave them out and even a perfectly organized crew builds the wrong thing quickly.

### Projects: giving big work its own home

For work that spans days — a product launch, a research project, a migration — use **sessions as project cards** rather than one endless conversation:

- **One session per work stream.** Each gets its own card on your board, with a status (`in progress`, `needs review`, ...) and labels you can filter by.
- **Statuses are the hand-off.** When Vorno finishes a chunk of work, it sets the session to **needs review**. Closing the card — deciding it's truly done — is always yours. Vorno will never mark its own work "done."
- **Automations create sessions on schedule.** A nightly sweep, a Monday-morning digest, a weekly report: an automation spawns a fresh session, an agent does the work, the card lands in your review column. You wake up to finished work waiting for a decision, not to a robot that decided for you.

This is the rhythm that makes Vorno feel like a team instead of a tool: **agents do the work, cards carry the status, and you make the calls.**

### Checking on things (and trusting what you see)

- The **chips at the top of a session** show what's running right now — each Task and Workflow, with elapsed time. Click a chip to expand details.
- Ask **"what's running?"** or **"status?"** at any time. Vorno checks its actual registry of running work and reports exactly what it finds — including work started in earlier turns.
- Background work **notifies your assistant when it finishes**, and the result flows back into your conversation.
- If a session was interrupted mid-workflow, workflows can **resume where they left off** rather than starting over.

### Recipes

Plain-language starting points you can adapt:

> **The thorough audit** — "Go through every invoice in this folder and flag anything unusual. Use a workflow: double-check each flag before showing me — I only want real issues, and I'd rather wait than see false alarms."

> **The while-I-work deliverable** — "Turn these meeting notes into a client-ready proposal in the background. I'll keep working with you on other things — let me know when it's ready to review."

> **The compare-and-decide** — "Research these four accounting platforms — pricing, integrations, and what small businesses complain about. Compare them and give me a recommendation with the reasoning."

> **The big cleanup** — "My files are a mess. First show me a plan for how you'd reorganize them. Once I approve, do it in the background and give me a report of everything you moved."

> **The recurring digest** — "Every weekday at 7am, create a session that summarizes yesterday's email and my calendar for today, and put it in my review column."

> **The project kickoff** — "This is the session for the website relaunch. Keep everything for that project here. First task: inventory what we have and draft a plan for my review."

---

## Part 3 — Technical Architecture

*This appendix is for technically-minded readers: power users, teams standardizing on Vorno, and contributors. Everything above stands on the machinery below.*

### The primitive ladder

Every request lands on one rung of an escalation ladder. Each rung adds coordination power and cost; the agent is designed to sit on the **lowest rung that does the job** — complexity must be earned by the problem, never adopted speculatively.

| Rung | Primitive | What it is | Lifetime | UI |
|------|-----------|-----------|----------|-----|
| 1 | **Inline tools** | The main agent reads, edits, executes directly | Within the turn | Normal tool calls |
| 2 | **LLM calls** (`call_llm`) | Single completions, no tools — batch processing, structured extraction, cheap parallel classification | Within the turn | Brief tool call |
| 3 | **Subagent** | A delegated agent with its own tools and context window | Within the turn; result returns to the orchestrator | Agent activity |
| 4 | **Fan-out** | Several independent subagents launched concurrently; model-driven split | Within the turn | Multiple agents |
| 5 | **Background Task** | An agent or command detached from the turn; survives across turns, notifies on completion | Cross-turn | **Task chip** |
| 6 | **Workflow** | A deterministic script orchestrating many subagents — phases, pipelines, loops, verification, budgets, resume | Cross-turn, phased | **Workflow chip** |
| 7 | **Spawned session** | A separate session with its own status, labels, and automation hooks | Independent lifecycle | New board card |

### Rung selection in depth

**`call_llm` vs. subagent** — `call_llm` is for *processing* content the agent already holds (summarize, classify, extract to a JSON schema); it's a single completion with no tools, so it's cheap and embarrassingly parallel. A subagent is for *finding* things — it can search, read, and run commands in its own context. Rule of thumb: content in hand → `call_llm`; discovery required → subagent.

**Subagent context isolation** — the core value is keeping the main context clean. A subagent can read forty files and return one paragraph; the main conversation pays for the paragraph, not the files. Corollary: subagent output goes to the orchestrating agent, **not** to the user. The orchestrator must relay anything that matters.

**Fan-out vs. Workflow** — fan-out is model-driven: the main agent decides the split ad hoc and launches parallel subagents in one shot. It's the right tool for roughly 3–8 independent pieces with *no inter-stage logic*. A Workflow is script-driven: actual JavaScript with control flow. The boundary question is: **does the orchestration itself have structure?** Loops-until-done, verification gates, barriers, budget-aware scaling → Workflow. "Do these five things at once" → fan-out.

### Workflow architecture

A workflow is a script executed deterministically over an agent pool:

- **`pipeline(items, ...stages)`** — each item flows through all stages independently, with no barrier between stages; item A can be in verification while item B is still in review. This is the default for multi-stage work because wall-clock time equals the slowest single-item chain, not the sum of the slowest per stage.
- **`parallel(thunks)`** — a true barrier: all results collected before continuing. Justified only when a stage genuinely needs *all* prior results together (dedup across findings, early-exit on zero results, cross-comparison).
- **Phases** — named stages that group agents in the progress UI, so a running workflow is legible from the chip.
- **Structured output** — agents can be forced to return schema-validated JSON, so stages compose without parsing fragility.
- **Quality patterns** — the shapes that make workflow output trustworthy:
  - *Adversarial verification*: independent skeptic agents try to **refute** each finding; only survivors are reported. This is what turns "the AI found 30 issues" into "here are 9 confirmed issues."
  - *Loop-until-dry*: for unknown-size discovery, keep spawning finders until consecutive rounds return nothing new — fixed counts miss the tail.
  - *Judge panel*: N independent attempts from different angles, scored, synthesized from the winner.
  - *Multi-modal sweep*: parallel searchers, each using a different angle (by name, by content, by time), because one angle never finds everything.
- **Budgets** — a user directive (e.g. "+500k tokens") becomes a hard ceiling the script can query, scaling depth to spend.
- **Resume** — completed agent calls are journaled; re-running an interrupted or edited workflow replays the unchanged prefix from cache and only executes what's new.
- **Worktree isolation** — agents that mutate files in parallel each get their own git worktree, preventing conflicting edits; unchanged worktrees are auto-cleaned.

**Why workflows are opt-in:** a workflow can spawn dozens of agents and consume tokens at a scale users must consciously choose. The agent will propose one and estimate cost, but never launch one from inference alone. This is a deliberate trust boundary, not a limitation.

### Background task truths

- The **task registry** (surfaced via the "what's running?" question and the chips) is the only reliable cross-turn source of truth for background work. Status answers come from the registry, never from the agent's guess.
- Tasks that outlive the turn that launched them keep running; a task shown as *orphaned* was terminated when its launching turn ended.
- Completion re-invokes the agent, so results flow back into the conversation without polling.

### Session-level orchestration

- Sessions carry **status** and **labels**; both fire automation events (`SessionStatusChange`, `LabelAdd`/`LabelRemove`), which is what enables hand-off pipelines (agent finishes → sets `needs-review` → downstream notification).
- Agents **cannot close work**: moving a card to a closed status (`done`/`cancelled`) is rejected at the tool layer. The review column is a hard human gate.
- **Cross-session messaging** is acknowledged as `delivered` (target idle, processing now) or `queued` (target mid-turn; not yet read). Queued ≠ received — orchestration logic should wait for replies, not assume.
- **Automations** spawn sessions on schedules or events, which is the idiomatic way to run recurring work — not a long-lived session that never ends.

### Anti-patterns

| Anti-pattern | Why it fails | Instead |
|---|---|---|
| Workflow for 3 parallel lookups | Ceremony without benefit | Fan-out |
| Subagent to read one known file | Pure overhead | Inline read |
| Prescribing agent counts / model tiers | The orchestrator scales better than a guess | State the rigor bar |
| Barrier (`parallel`) between every stage | Wastes wall-clock on idle waits | `pipeline` unless a stage needs all prior results |
| Trusting unverified findings from a big sweep | Plausible-but-wrong survives | Adversarial verification stage |
| One eternal session as "the project" | Status/board/automation machinery goes unused | Session per work stream; statuses as hand-offs |
| Assuming a queued cross-session message was read | It hasn't been | Wait for the reply |

---

*Feedback on this guide → [open an issue](https://github.com/Swagatar-LLC/craft-agents-oss/issues).*
