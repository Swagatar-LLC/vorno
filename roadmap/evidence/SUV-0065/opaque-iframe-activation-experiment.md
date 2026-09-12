# Opaque-iframe activation experiment — SUV-0065

ADR-0033 §3 records an unverified premise and forbids building on it until it is
measured:

> It is unverified whether a click in the opaque `srcDoc` iframe grants usable
> parent-window activation, and even if it does, it does not prove that the click
> landed in the frame. The bounded Electron experiment must be run and recorded
> before relying on that signal. If it fails or is ambiguous, use a trusted
> host-click path for the affected operation or reject it; do not weaken host
> enforcement or claim frame proof.

This is that record. The experiment was **run**, not skipped, and its result is
**negative for the premise**: no renderer-visible activation signal attributes a
click to the Page frame. SUV-0065 therefore takes the ADR's safe branch.

## How to re-run it

The probe ships in the repo so this record can be checked rather than believed:

```
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  scripts/pages-activation-probe.cjs --show
```

It reproduces the real Page sandbox — `sandbox="allow-scripts allow-forms"`, no
`allow-same-origin`, `srcDoc` content, opaque origin — and prints one JSON
report. A `bun install` alone does **not** materialize the Electron binary in
this repo; extracting the cached
`~/Library/Caches/electron/*/electron-v<version>-<platform>.zip` into
`node_modules/electron/dist/` does. The 2026-09-10 attempt at this experiment
stalled exactly there and recorded "inconclusive by environment"; that blocker is
the extraction step, and it is now written down instead of re-discovered.

## What was measured

Environment: Electron 39.2.7 / Chromium 142.0.7444.235, darwin arm64, 2026-09-11.
Three trials — a no-click control, a click over the sandboxed iframe, and a click
on the parent document far from it — each reading frame activation, parent
activation, and what the main process observed. Geometry is self-checked: the
report carries the iframe's measured rect and the parent's `elementFromPoint` at
the in-frame click point, which returned `IFRAME`, so the in-frame trial is
demonstrably aimed inside the frame rather than assumed to be.

| Trial | Parent `userActivation.isActive` | Main-process `input-event` gestures | Frame received the event |
| --- | --- | --- | --- |
| no-click (control) | `false` | 0 | no |
| in-frame | **`true`** | **0** | no |
| outside-frame | **`true`** | 1 | n/a |

Stable and identical across repeated runs, under both `webContents.sendInputEvent`
and CDP `Input.dispatchMouseEvent`, and with the window both shown and hidden.

## Findings

1. **Parent activation does not distinguish in-frame from out-of-frame clicks.**
   `navigator.userActivation.isActive` reads `true` after either click. The
   control proves the reading is meaningful (`false` with no gesture), so this is
   a real measurement and not a stuck value. **Verified.** This is precisely the
   ADR's stated suspicion, now observed: a positive parent activation is
   app-window freshness, never frame proof.

2. **Electron's main-process `input-event` carries no frame identity.** The
   observed payload keys are exactly `button, clickCount, globalX, globalY,
   movementX, movementY, type, x, y`. There is no frame, target, or routing
   field to attribute a gesture to the Page. **Verified.** The probe reports the
   key list verbatim rather than checking for expected names, so a future
   Electron that adds frame routing would show up here without editing the probe.

3. **Input dispatched over the sandboxed frame did not reach the main process's
   `input-event` at all, while input on the parent document did.** **Verified
   in-harness, with a caveat that matters:** the frame also received nothing in
   that trial, so what this measures is how *synthesized* input routes to a
   sandboxed child frame — it does not establish that a real hardware click over
   the Page frame is invisible to `input-event`. That remains **unknown**, and
   this record does not resolve it.

## What SUV-0065 does with this

Finding 1 kills the premise outright, so nothing in the implementation reads
`navigator.userActivation` as authority. Findings 2 and 3 mean the host cannot
attribute a gesture to the frame at any trust level, so the design does not try
to: it takes ADR-0033's trusted-host-click branch.

- The only issuer of an activation ticket is the Electron **main** process, from
  a gesture `input-event` gave it or from an answer to host-rendered chrome.
  Neither a renderer nor a transport client can assert activation.
- A gesture is **spent** when it mints a ticket, which is what makes "one
  privileged action per click" true rather than aspirational. Passive input
  (moves, wheel, hover, enter/leave) never counts as a gesture.
- Script and session grants additionally require host-rendered first-use
  confirmation per render, naming the exact descriptor. That dialog is host
  chrome, so the user's answer is a click the main process both renders and
  observes — the frame-independent trusted path the ADR asks for.

Finding 3's unknown is deliberately made safe by shape rather than by assumption:
if real in-frame clicks turn out to be invisible to `input-event`, a Page button
mints no ticket and the action is **refused**. The failure is a usability
complaint, not a bypass. The first-use confirmation keeps even that case working
for the dangerous kinds, because answering the dialog is itself an observed
gesture.

Re-running the probe on a new Electron is worthwhile when the version moves, and
a positive result does **not** by itself license reading activation as frame
proof — findings 1 and 2 would have to be overturned first, which is an ADR-level
change, not an implementation detail.
