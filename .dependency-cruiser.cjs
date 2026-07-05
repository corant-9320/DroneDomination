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
