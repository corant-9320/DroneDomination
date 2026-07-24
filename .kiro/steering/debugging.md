# Debugging — Stop Guessing, Instrument Instead

**Purpose:** Stop expensive root-cause guessing loops; hand back to the human with
instrumentation in place. **Scope:** all bug investigations. **Audience:** any agent
debugging this repo. **Related:** `conventions.md` (expensive-tooling approval) ·
`docs/architecture/debugging.md` (snapshot + `gameDebug` reference).

## Rule 0 — "It isn't showing up" means read the error FIRST

When the symptom is that something is **missing, invisible, or didn't happen** (an entity
doesn't render, an action does nothing, a panel stays empty):

1. **Ask for the browser console output**, or add a log and have the user repro. One
   round-trip.
2. **Check for a rejected request.** Actions go through `matchClient.submit()`; the
   server returns `{ success: false, error }` and `logisticsController.ts` /
   `playerActions.ts` log it via `dbg.input.log`. A rejected intent looks exactly like a
   rendering bug from outside.

Do this **before** reading more than one or two files, and never start by tracing the
render path — a thing that was never created renders correctly as nothing. (This already
cost ~25 tool calls on a "transport missing from the map" report whose answer was a
console line the user already had: no road connected the structures, so no transport
existed.)

## The Rule

If you're reduced to **guessing** — re-reading the same files, theorizing without
confirmation, or roughly **>10k tokens** of investigation with no confirmed cause — STOP:

1. **Add focused debug code** at the key points on the suspect path. Log actual values,
   branch taken, call counts — whatever separates your competing hypotheses. Use a
   greppable prefix (e.g. `[FP-ROTATE]`) so the human can copy just those lines.
2. **Hand it back.** Say exactly how to reproduce and what output to copy back.
3. **Wait for real data.** Don't keep theorizing meanwhile.

Then diagnose from the output, fix the root cause, and **remove the debug code** before
finishing. Re-reading correct-looking code rarely reveals runtime-only bugs (event
ordering, double-handling, stale state, races); a few log lines plus one repro resolves
in one round-trip what static guessing won't.

## Picking a repro tool

- **Cheap first:** unit tests, `npm run debug:snapshot`, existing `artifacts/sessions/**`.
  Manual human repro is for runtime behaviour those can't capture (3D interaction, input).
- **Check what a tool captures before spending a run.** `snapshot()` covers
  turn/counts/selection/units only — **not** logistics, buildings, or cities — so it
  cannot answer questions about those. Read `console.log` from the session directory
  instead, or extend the snapshot (`docs/architecture/debugging.md`).
- **`npm run debug:snapshot` needs `--wait 45000`.** The 30 s default is shorter than this
  project's cold load, so a default run fails waiting on `#loading`.
- Chrome DevTools and Playwright need approval — see `conventions.md`.
