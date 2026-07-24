/**
 * Vitest launcher that normalises the Windows drive-letter case of the working
 * directory before handing off to vitest.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * On Windows, running the suite from `c:\Kiro\DroneDomination` (lowercase drive
 * letter) makes vite resolve the same modules under two different path spellings,
 * so `vitest` is instantiated twice. The `describe` a test file imports then comes
 * from a different instance than the one holding worker state, and every file
 * fails at its first `describe()` with:
 *
 *     TypeError: Cannot read properties of undefined (reading 'config')
 *
 * The same command from `C:\Kiro\DroneDomination` passes. This was reproduced
 * deterministically: only the drive-letter case differed. Kiro's `agentStop` hook
 * shell launches with a lowercase drive letter, which is why the suite failed
 * only when the hook ran it.
 *
 * Rather than depend on how a caller happened to spell the path, every `vitest`
 * npm script goes through here. All arguments are forwarded unchanged.
 *
 * See docs/architecture/known-issues.md.
 */

import { spawnSync } from 'node:child_process';
import { createRequire, } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** Upper-case a leading `x:` drive letter; leave non-Windows paths untouched. */
export function normaliseDriveLetter(dir) {
  return /^[a-z]:/.test(dir) ? dir[0].toUpperCase() + dir.slice(1) : dir;
}

function main() {
  const cwd = normaliseDriveLetter(process.cwd());

  // Resolve vitest's own CLI entry so we don't depend on PATH or npx. The CLI is
  // not an exported subpath, so go via the package's `bin` field.
  const pkgPath = require.resolve('vitest/package.json');
  const pkg = require(pkgPath);
  const binRelative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.vitest;
  // Normalise the bin path too: it is resolved relative to THIS module's own path,
  // which is lowercase when the launcher itself was invoked from a lowercase cwd.
  // Leaving it lowercase reintroduces the duplicate-module load we're fixing.
  const vitestBin = normaliseDriveLetter(path.join(path.dirname(pkgPath), binRelative));

  const result = spawnSync(process.execPath, [vitestBin, ...process.argv.slice(2)], {
    cwd,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`run-vitest: failed to start vitest — ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

// Only launch vitest when run as a CLI. Without this guard, a test importing
// `normaliseDriveLetter` would spawn vitest at import time, which would import
// this module again — an infinite recursion of vitest processes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
