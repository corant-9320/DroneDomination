# Debugging — Stop Guessing, Instrument Instead

**Purpose:** Stop expensive root-cause guessing loops. When static analysis
isn't converging, hand control back to the human with instrumentation in place.
**Scope:** All bug investigations.
**Audience:** Any agent debugging this repo.
**Load rule:** Always included (mandatory).

## The Rule

If you are struggling to find the root cause of a bug and have been reduced to
**guessing** — re-reading the same files, theorizing without confirmation, or
you've burned a lot of tokens on analysis (rough threshold: **>10k tokens** of
investigation with no confirmed cause) — then **STOP**:

1. **Add focused debug code** (console logs / temporary diagnostics) at the
   key points along the suspect code path. Log the actual values, branch taken,
   and call counts — whatever would distinguish your competing hypotheses.
2. **Hand it back to the human.** Tell them exactly what to do to recreate the
   bug manually, and what console output to copy back.
3. **Wait for the real data.** Do not keep theorizing in the meantime.

Then diagnose from the captured output, fix the root cause, and **remove the
debug code** before finishing.

## Why

Reading correct-looking code repeatedly rarely reveals runtime-only bugs (event
ordering, double-handling, stale state, race conditions). A few log lines plus
one manual repro from the human resolves in one round-trip what hours of static
guessing won't.

## Notes

- Prefer cheap repro first (unit tests, `npm run debug:snapshot`, existing
  `artifacts/sessions/**`). Manual human repro is for runtime behaviour those
  can't capture (e.g. 3D view interaction, input handling).
- Make the logs greppable with a clear prefix (e.g. `[FP-ROTATE]`) so the human
  can copy just the relevant lines.
- See `efficiency.md` for the related rule on not invoking expensive
  Chrome/Playwright tooling without approval.
