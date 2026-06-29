# Docs As We Go

**Purpose:** Capture design intent the moment it's decided, so it survives across
agent sessions. The game's rules are invented incrementally — undocumented intent
is the root cause of guessing loops.
**Scope:** All changes.
**Audience:** Any agent editing this repo.

## When you MUST record a decision

Append an entry to [`DECISIONS.md`](/DECISIONS.md) (newest at top) whenever you:

1. Make a **design or balance decision** (a formula, a constant, a rule about how
   something is *supposed* to work).
2. Discover a **non-obvious gotcha** (a coordinate-system quirk, a sync requirement
   between two files, an "it looks wrong but is actually correct").
3. **Find or fix a bug** worth a regression note.

Keep it to a few lines: **Decision / Why / Impact**. This is cheap insurance —
one entry now saves the next agent a long investigation.

## Where each kind of doc lives

| Kind of knowledge | Goes in |
|---|---|
| Combat formulas, constants, validation rules | `COMBAT_RULES.md` (authoritative) |
| Module map, data flow, API contract | `docs/architecture/` wiki (hub: `docs/architecture/README.md`) |
| One-off decisions, gotchas, known issues | `DECISIONS.md` |
| Scoped agent routing / conventions | `.kiro/steering/*.md` |

If a decision changes a formula or a rule, update the **authoritative doc**
(`COMBAT_RULES.md` / `ARCHITECTURE.md`) AND drop a short pointer entry in
`DECISIONS.md`. Don't let the two diverge.

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

Before starting a feature, skim the **Known Issues** section of `DECISIONS.md`.
If your change touches one, either fix it (and move it to a dated entry) or note
why you're working around it.
