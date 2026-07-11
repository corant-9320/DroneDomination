# Efficiency Rules

**Purpose:** Minimize wasted turns and tool calls.  
**Scope:** All edits.  
**Audience:** Any agent working on this repo.

## Rules

1. **Batch related edits in one turn.** When changing a constant, function signature, or type — update all references (code + tests) in a single batch of parallel tool calls.

2. **One verification pass at the end.** Run `tsc --noEmit` and `npm test` once after all edits are complete. Do not verify after each individual file change.

3. **Don't re-read files you just wrote.** If you made the edit, you know the state. Skip confirmatory reads.

4. **Fix test failures in one shot.** When a test run shows multiple failures with obvious causes (wrong expected values, renamed imports), fix them all in one turn.

5. **Skip sub-agents for simple changes.** Context-gathering is for unfamiliar code. For straightforward changes (rename, constant update, signature change), grep for references, edit them all, and verify. No exploration phase.

6. **Don't explain the obvious.** If the user asks to change a number, change it. Don't narrate the plan or summarize what a constant does.

7. **Batch doc updates with code edits.** When a change requires documentation updates (`docs/architecture/known-issues.md`, memory graph, architecture docs), include them as parallel tool calls in the same turn as the code edit. Never do a separate "documentation pass" after the code is complete. Per-diff rationale goes in the git commit body (`Decision/Why/Impact`) — not a doc — so it costs no extra tool call.

## Expensive Tools — Ask First

8. **Chrome DevTools and Playwright (e2e) tests cost a lot of tokens.** Do not invoke Chrome DevTools browser tools or run Playwright/e2e tests on your own. Consult with the user and get explicit approval before using them. Prefer cheaper alternatives first (unit tests, `npm run debug:snapshot`, reading existing `artifacts/sessions/**` output).
