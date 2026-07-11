# Docs As We Go

**Purpose:** Capture design intent the moment it's decided, so it survives across
agent sessions. The game's rules are invented incrementally — undocumented intent
is the root cause of guessing loops.
**Scope:** All changes.
**Audience:** Any agent editing this repo.

## Where decisions get recorded

`DECISIONS.md` is now a **frozen archive** — do not append to it. Record intent in
one of two places depending on its lifecycle:

### A. Per-diff rationale → the git commit body

For the *why behind a specific change* — a non-obvious design decision, a bug
fix worth a regression note, or a value that interacts with other constants in a
non-obvious way — put it in the **commit message body**, not a doc. Use these
prefixed lines so the log stays reconstructable:

```
<short summary line>

Decision: <what you chose>
Why: <rationale — X over Y because of Z>
Impact: <files/behaviour affected, what to watch for>
```

Then `git log --grep "^Decision:"` reconstructs the old decision-log view on
demand, and the rationale is tied to the exact diff it explains.

**Skip even the commit body** for self-contained tweaks and renames — no
interaction with other formulas, no downstream behaviour beyond the obvious one.
A one-line summary is enough. (Skip is about *interaction*, not line count: a
one-line change with a non-obvious downstream effect still deserves the
`Decision/Why/Impact` body; a big mechanical refactor with an obvious "why" does
not.)

### B. Living knowledge → `docs/architecture/known-issues.md`

For knowledge that **evolves over time** rather than describing one diff:

- **Open issues / limitations** you're leaving unresolved.
- **Enduring gotchas & sync requirements** between files that will trip up future
  agents across many changes.

A commit body is the wrong home for these (commits are immutable point-in-time
snapshots; an open issue needs to be edited and eventually closed). Add them to
[`known-issues.md`](/docs/architecture/known-issues.md), and move an issue to its
"Recently Fixed" list when you resolve it.

## Where each kind of doc lives

| Kind of knowledge | Goes in |
|---|---|
| Combat formulas, balance constants | `COMBAT_RULES.md` (read-only reference; may drift — cross-check code + `git log`; update only when explicitly asked) |
| Validation rules (enforced invariants) | `COMBAT_RULES.md` (kept in sync — update immediately when the invariant changes) |
| Module map, data flow, API contract | `docs/architecture/` wiki (hub: `docs/architecture/README.md`) |
| Per-diff decision rationale ("why this change") | **git commit body** (`Decision/Why/Impact`) |
| Open issues, enduring gotchas, sync requirements | `docs/architecture/known-issues.md` |
| Historical decisions (pre-2026-07-04) | `DECISIONS.md` (frozen archive — read only) |
| Scoped agent routing / conventions | `.kiro/steering/*.md` |

If a decision changes a formula or rule, update the **authoritative doc**
(`COMBAT_RULES.md` / architecture wiki). Only add the "why" to the commit body if
it wouldn't survive in the authoritative doc itself. Don't duplicate the same fact
in both places.

## COMBAT_RULES.md — Read Reference, Not Write Target

`COMBAT_RULES.md` is a **read-only reference** for agents. Do not update it as part of
a code change for formulas or constants. It may already be somewhat stale — treat it as
a starting orientation point, not ground truth, and cross-check against the actual
formula code (`src/world/combatFormula.ts`) and recent commit messages
(`git log --grep "^Decision:"`) when precision matters. (This already happened:
see the 2026-06-xx building-destruction decision that explicitly reversed a stale
§12 assumption.)

**Exception — validation rules stay in sync.** Rules that describe an enforced
constraint (not a balance number) — e.g. "damage is always clamped to [MIN_DAMAGE,
MAX_DAMAGE]" — must be updated immediately if the constraint changes. A stale validation
rule can make an agent believe a safety invariant holds when it doesn't; a stale balance
constant just means a number is slightly off.

**Sync policy:** The human will periodically trigger a dedicated sync pass (or it will be
regenerated from annotated source). If you notice it's stale while reading it, note the
discrepancy in your response but do not fix it inline unless it's a validation rule (see
exception above).

## Debugging without screenshots

Before asking the user for a screenshot, capture the running game yourself:

```
npm run dev            # in one terminal (leave running)
npm run debug:snapshot # writes artifacts/sessions/<timestamp>/
```

Then read `artifacts/sessions/<timestamp>/summary.md` (and `state.json`,
`errors.json`, `console.log`, `screenshot.png`). `window.__DD_STATE__.snapshot()`
is the same data, available in the browser console.

Pass `--turns N` to advance turns before capturing.

## Known-issues discipline

Before starting a feature, skim [`docs/architecture/known-issues.md`](/docs/architecture/known-issues.md).
If your change touches an open issue, either fix it (and move the line to
"Recently Fixed" with a date) or note why you're working around it.
