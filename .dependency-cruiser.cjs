/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "client-must-not-import-src",
      comment:
        "Client bundle must not import from src/ or server/ (enforced by tsconfig.client.json)",
      severity: "error",
      from: { path: "^client/" },
      to: { path: "^(src|server)/" },
    },
    {
      name: "server-must-not-import-client",
      comment: "Server code should not depend on client UI code",
      severity: "error",
      from: { path: "^server/" },
      to: { path: "^client/" },
    },
    {
      name: "src-must-not-import-client-or-server",
      comment: "Core world logic (src/) should not depend on client or server",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^(client|server)/" },
    },
    {
      name: "shared-must-not-import-higher-layers",
      comment:
        "shared/ is imported by client, server, AND src — it must stay a leaf with no dependency on any of them, or all three would transitively couple through it",
      severity: "error",
      from: { path: "^shared/" },
      to: { path: "^(client|server|src)/" },
    },
    {
      name: "no-circular",
      comment:
        "Circular dependencies between production modules make it hard to reason about load order and initialization; break the cycle via import type, a shared lower-level module, or a narrow facade. Cycles formed purely through `import type` edges are excluded (they vanish at compile time, so there is no runtime cycle) via viaOnly.",
      severity: "error",
      from: {},
      to: {
        circular: true,
        viaOnly: {
          dependencyTypesNot: ["type-only"],
        },
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".ts", ".js", ".mjs"],
    },
    reporterOptions: {},
    exclude: {
      path: ["__tests__", "\\.test\\.ts$", "\\.spec\\.ts$", "coverage/"],
    },
  },
};
