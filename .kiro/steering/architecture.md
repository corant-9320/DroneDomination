---
inclusion: fileMatch
fileMatchPattern: "{src/**,server/**,shared/**,index.html,package.json,.dependency-cruiser.cjs,eslint.config.js,playwright.config.ts,vite.config.ts,tsconfig*.json,scripts/**}"
---

# Architecture — Hub

Loaded for backend/shared code, the browser entry document, scripts, and root
build/tool configuration. Use the module map to locate the module that owns a
concern (and the two real compatibility facades, `client/worldData.ts` and
`src/world/combat.ts`), then open only the detail page relevant to the task.

#[[file:../../docs/architecture/README.md]]
#[[file:../../docs/architecture/modules.md]]
