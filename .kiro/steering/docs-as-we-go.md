# Docs As We Go

**Purpose:** Capture design intent when it's decided — undocumented intent is the root
cause of guessing loops across sessions. **Scope:** all changes. **Audience:** any agent
editing this repo. **Related:** `core.md` (which artifact wins).

## Where knowledge goes

| Kind | Home |
|---|---|
| Per-diff rationale ("why this change") | git commit body (`Decision/Why/Impact`) |
| Open issues, limitations, enduring gotchas, cross-file sync requirements | `docs/architecture/known-issues.md` |
| Module map, data flow, API contract | `docs/architecture/` wiki (hub: its `README.md`) |
| Combat formulas, balance constants | `COMBAT_RULES.md` (read-only — see below) |
| Validation rules (enforced invariants) | `COMBAT_RULES.md` (**kept in sync** — see below) |
| Scoped agent routing / conventions | `.kiro/steering/*.md` |
| Historical decisions (pre-2026-07-04) | `DECISIONS.md` — frozen archive, never append |

If a change alters a formula or rule, update the authoritative doc. Add the "why" to the
commit body only if it wouldn't survive in that doc. Never duplicate the fact in both.

## Commit-body format

```
<short summary line>

Decision: <what you chose>
Why: <rationale — X over Y because of Z>
Impact: <files/behaviour affected, what to watch for>
```

`git log --grep "^Decision:"` then reconstructs the decision log on demand.
**Skip the body** for self-contained tweaks and renames. Skip is about *interaction*,
not size: a one-line change with a non-obvious downstream effect still needs it; a large
mechanical refactor with an obvious "why" does not.

## Living knowledge → known-issues.md

A commit is an immutable snapshot, so it's the wrong home for anything needing edits and
eventual closure. Open issues, limitations, and enduring gotchas/sync requirements go in
[`known-issues.md`](/docs/architecture/known-issues.md). On resolving one, remove it from
the live list and preserve any useful note in
[`archive/known-issues-fixed.md`](/docs/architecture/archive/known-issues-fixed.md).

**Skim `known-issues.md` before starting a feature.** If your change touches an open
issue, either fix it (removing/archiving it) or say why you're working around it.

## COMBAT_RULES.md edit policy

Read-only reference for agents. Do **not** update it as part of a code change to a
formula or balance constant. If you notice it's stale, report the discrepancy in your
response rather than fixing it inline — a human triggers periodic sync passes.

**Exception — validation rules stay in sync.** A rule describing an *enforced constraint*
rather than a balance number (e.g. "damage is always clamped to [MIN_DAMAGE, MAX_DAMAGE]")
**must be updated immediately** when the constraint changes. A stale validation rule makes
an agent believe a safety invariant holds when it doesn't; a stale balance constant just
means a number is slightly off.

## Runtime state instead of screenshots

Before asking the user for a screenshot, capture the running game yourself. The snapshot
workflow and flags are documented once in
[`docs/architecture/debugging.md`](/docs/architecture/debugging.md); read the operational
caveats in `debugging.md` first.
