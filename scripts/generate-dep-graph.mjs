/**
 * generate-dep-graph.mjs
 *
 * Runs dependency-cruiser and writes agent-friendly outputs to ai/generated/:
 *   - dep-graph.json   Full dependency graph (machine-readable)
 *   - dep-summary.md   Module-level summary (quick orientation for agents)
 *   - violations.md    Any rule violations found
 *
 * All three outputs are deterministic — no timestamps or other
 * non-reproducible content — so `--check` can byte-compare them against a
 * freshly computed copy without false positives.
 *
 * Usage:  node scripts/generate-dep-graph.mjs          (write mode)
 *         node scripts/generate-dep-graph.mjs --check   (check mode, no writes)
 * Or:     npm run deps:graph
 *         npm run deps:check
 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = resolve(root, "ai", "generated");
const checkMode = process.argv.includes("--check");

if (!checkMode) mkdirSync(outDir, { recursive: true });

// --- 1. Run depcruise, output JSON ---
if (!checkMode) console.log("Running dependency-cruiser...");
const jsonOutput = execSync(
  `npx depcruise src server shared client --config .dependency-cruiser.cjs --output-type json`,
  { cwd: root, encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 }
);

const graph = JSON.parse(jsonOutput);
if (!checkMode) {
  writeFileSync(resolve(outDir, "dep-graph.json"), jsonOutput, "utf-8");
  console.log(`  → ai/generated/dep-graph.json (${graph.modules.length} modules)`);
}

// --- 2. Build module-level summary ---
const buckets = { src: [], server: [], shared: [], client: [] };

for (const mod of graph.modules) {
  const src = mod.source;
  const bucket = Object.keys(buckets).find((b) => src.startsWith(b + "/"));
  if (!bucket) continue;
  buckets[bucket].push({
    file: src,
    dependsOn: mod.dependencies.map((d) => d.resolved),
    dependents: [],
  });
}

// Compute dependents (reverse edges)
const byFile = new Map();
for (const bucket of Object.values(buckets)) {
  for (const entry of bucket) {
    byFile.set(entry.file, entry);
  }
}
for (const entry of byFile.values()) {
  for (const dep of entry.dependsOn) {
    const target = byFile.get(dep);
    if (target) target.dependents.push(entry.file);
  }
}

// Build markdown
let md = `# Dependency Graph Summary\n\n`;
md += `Modules: ${graph.modules.length}\n\n`;
md += `Use \`ai/generated/dep-graph.json\` for full machine-readable graph.\n\n`;

for (const [area, entries] of Object.entries(buckets)) {
  if (entries.length === 0) continue;
  md += `## ${area}/\n\n`;
  md += `| Module | Depends on (count) | Depended on by (count) |\n`;
  md += `|--------|-------------------|------------------------|\n`;

  // Sort by most depended-upon first (high fan-in = important)
  entries.sort((a, b) => b.dependents.length - a.dependents.length);

  for (const entry of entries) {
    const shortName = entry.file.replace(area + "/", "");
    md += `| ${shortName} | ${entry.dependsOn.length} | ${entry.dependents.length} |\n`;
  }
  md += `\n`;

  // Show the top 5 most-depended-on files in this area (high fan-in hubs)
  const hubs = entries.filter((e) => e.dependents.length > 0).slice(0, 5);
  if (hubs.length > 0) {
    md += `### Key hubs in ${area}/\n\n`;
    for (const hub of hubs) {
      md += `- **${hub.file}** — depended on by ${hub.dependents.length} modules\n`;
      if (hub.dependents.length <= 8) {
        for (const dep of hub.dependents) {
          md += `  - ${dep}\n`;
        }
      }
    }
    md += `\n`;
  }
}

// --- 3. Cross-area dependency edges ---
md += `## Cross-area dependencies\n\n`;
md += `Shows imports that cross area boundaries (client→shared, server→src, etc.)\n\n`;

const crossEdges = new Map();
for (const entry of byFile.values()) {
  const srcArea = Object.keys(buckets).find((b) =>
    entry.file.startsWith(b + "/")
  );
  for (const dep of entry.dependsOn) {
    const depArea = Object.keys(buckets).find((b) => dep.startsWith(b + "/"));
    if (depArea && srcArea && depArea !== srcArea) {
      const key = `${srcArea} → ${depArea}`;
      if (!crossEdges.has(key)) crossEdges.set(key, []);
      crossEdges.get(key).push({ from: entry.file, to: dep });
    }
  }
}

if (crossEdges.size === 0) {
  md += `No cross-area dependencies found.\n\n`;
} else {
  for (const [direction, edges] of [...crossEdges.entries()].sort()) {
    md += `### ${direction} (${edges.length} edges)\n\n`;
    // Group by target
    const byTarget = new Map();
    for (const e of edges) {
      if (!byTarget.has(e.to)) byTarget.set(e.to, []);
      byTarget.get(e.to).push(e.from);
    }
    for (const [target, sources] of [...byTarget.entries()].sort()) {
      md += `- **${target}** ← ${sources.length > 3 ? sources.length + " modules" : sources.join(", ")}\n`;
    }
    md += `\n`;
  }
}

// --- 4. Violations report ---
const violations = graph.summary?.violations || [];
let violationsMd = `# Dependency Rule Violations\n\n`;

if (violations.length === 0) {
  violationsMd += `✅ No violations found.\n`;
} else {
  violationsMd += `⚠️ ${violations.length} violation(s) found:\n\n`;
  for (const v of violations) {
    violationsMd += `- **${v.rule.name}** (${v.rule.severity}): \`${v.from}\` → \`${v.to}\`\n`;
  }
}

// --- 5. Write or compare ---
const outputs = {
  "dep-summary.md": md,
  "violations.md": violationsMd,
};

if (checkMode) {
  let stale = false;
  const staleFiles = [];
  for (const [name, expected] of Object.entries(outputs)) {
    const filePath = resolve(outDir, name);
    const actual = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
    if (actual !== expected) {
      stale = true;
      staleFiles.push(name);
    }
  }
  // dep-graph.json was never written in check mode; compare it too.
  const graphPath = resolve(outDir, "dep-graph.json");
  const actualGraph = existsSync(graphPath) ? readFileSync(graphPath, "utf-8") : null;
  if (actualGraph !== jsonOutput) {
    stale = true;
    staleFiles.push("dep-graph.json");
  }

  if (stale) {
    console.error(
      `✗ ai/generated/ is stale relative to the current source tree.\n` +
        `  Stale file(s): ${staleFiles.join(", ")}\n` +
        `  Run \`npm run deps:graph\` to regenerate, then commit the result.`
    );
    process.exit(1);
  }
  console.log("✓ ai/generated/ is up to date with the current source tree.");
  process.exit(0);
}

writeFileSync(resolve(outDir, "dep-summary.md"), md, "utf-8");
console.log(`  → ai/generated/dep-summary.md`);
writeFileSync(resolve(outDir, "violations.md"), violationsMd, "utf-8");
console.log(`  → ai/generated/violations.md`);
console.log("Done.");
