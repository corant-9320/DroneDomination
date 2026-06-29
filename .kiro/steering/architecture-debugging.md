---
inclusion: fileMatch
fileMatchPattern: "{client/debugState.ts,client/gameDebug.ts,client/debug.ts,e2e/**,scripts/**}"
---

# Architecture — Debug Instrumentation detail

Loaded because you're touching debug/e2e/script code. Covers the headless
snapshot (`window.__DD_STATE__`, `npm run debug:snapshot`) and the
`window.gameDebug` DOM instrumentation contract.

#[[file:../../docs/architecture/debugging.md]]
