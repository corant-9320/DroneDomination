# Source-of-Truth Hierarchy

**Purpose:** The one canonical statement of which artifact wins when docs, code, tests,
the memory graph, or the agent map disagree. **Scope:** all sessions. **Audience:** any
agent on this repo.

1. **Code and tests** define current implemented behaviour. If anything disagrees with
   what the code does, the code wins.
2. **Architecture docs** (`docs/architecture/**`, `ARCHITECTURE.md`) define intended
   boundaries, contracts, and maintained invariants. Accurate for structure and
   contracts; verify against code when precision matters for your change.
3. **`COMBAT_RULES.md`** is a reference for combat intent and the maintained validation
   invariants (e.g. clamped damage ranges). Balance *values* may lag the code —
   cross-check `src/world/combatFormula.ts` and `git log --grep "^Decision:"` before
   relying on a number. Edit policy: `docs-as-we-go.md`.
4. **Memory graph and `ai/agent-map.yaml`** are orientation tools, not authority. Find
   files and concepts fast, then verify against code/tests/architecture docs.

This is the only place the ordering is written out; restating it elsewhere guarantees
drift. Other documents link here rather than re-describing it. Do not reintroduce a
summary of it.

Practical effect:

- `COMBAT_RULES.md` vs `combatFormula.ts` disagree on a number → trust the code, note
  the drift, don't silently "fix" the code to match the doc.
- An architecture doc describes a module that no longer exists → trust the code, fix or
  flag the doc.
- The memory graph mentions a removed system → trust the code and update the graph.
