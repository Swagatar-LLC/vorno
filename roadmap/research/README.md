# Research

Standing research dossiers: multi-source investigations that inform decisions and plans
but are **not themselves either one**.

> **Status contract — read this before citing anything in here.**
>
> Nothing in `research/` is a decision, a commitment, or a plan. These documents record
> *what the field currently does and what our code currently is*, as of the date in the
> directory name. They are inputs.
>
> - A decision becomes an **ADR** in [`../decisions/`](../decisions/).
> - Work becomes a **PLAN** in [`../plans/`](../plans/).
> - Findings that bit us in practice become **LEARNINGs** in `vorno-internal:learnings/`.
>
> Recommendations phrased as "should" inside a research doc are the *author's reading of
> the evidence*, not an accepted position. Until an ADR says otherwise, they are opinions
> with citations attached.

## Relationship to `discussions/`

[`../discussions/`](../discussions/) holds captured conversations, dossiers, and one-off
research notes. `research/` is for investigations large enough to need their own directory
— multiple source documents, a synthesis, and a reading order. If it's a single file, it
probably belongs in `discussions/`.

## Layout

Each investigation gets a dated directory, `YYYY-MM-DD-topic/`, containing:

- `README.md` — scope, reading order, and what is / isn't established
- `00-synthesis.md` — the cross-cutting read, with findings against our own code
- `NN-*.md` — the underlying source reports, preserved as produced

## Index

| Directory | Topic | Status |
|---|---|---|
| [`2026-08-18-execution-sandboxing/`](2026-08-18-execution-sandboxing/) | How OSS agent harnesses and frameworks sandbox local code execution; OS primitives per platform; credential isolation; the adversarial literature | Research only — no decision taken |

## Freshness

Security research ages badly. Every document here is stamped with its research date and
carries an explicit "could not verify" section. Before acting on a specific version number,
CVE, or vendor behaviour, re-check it — several claims in the 2026-08-18 dossier were
already contested *between* its own source reports (see that directory's README).
