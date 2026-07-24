// Regression guard for the Windows drive-letter-case test failure.
//
// Running the suite from `c:\...` (lowercase drive letter) instead of `C:\...`
// made vite resolve modules under two path spellings, instantiating vitest twice.
// Every test file then failed at its first `describe()` with
// `TypeError: Cannot read properties of undefined (reading 'config')`.
// Kiro's agentStop hook shell uses a lowercase drive letter, so the suite failed
// only when the hook ran it — see docs/architecture/known-issues.md.
//
// `scripts/run-vitest.mjs` normalises the drive letter for BOTH the working
// directory and the resolved vitest bin path (missing either one reintroduces the
// duplicate load). These tests cover the normalisation helper and assert the npm
// test scripts still route through the launcher.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { normaliseDriveLetter } from '../run-vitest.mjs';

describe('normaliseDriveLetter', () => {
  it('upper-cases a lowercase drive letter', () => {
    expect(normaliseDriveLetter('c:\\Kiro\\DroneDomination')).toBe('C:\\Kiro\\DroneDomination');
  });

  it('leaves an already-uppercase drive letter unchanged', () => {
    expect(normaliseDriveLetter('C:\\Kiro\\DroneDomination')).toBe('C:\\Kiro\\DroneDomination');
  });

  it('normalises regardless of the rest of the path', () => {
    expect(normaliseDriveLetter('d:\\a\\b\\c')).toBe('D:\\a\\b\\c');
    expect(normaliseDriveLetter('z:/forward/slashes')).toBe('Z:/forward/slashes');
  });

  it('leaves POSIX-style paths untouched', () => {
    expect(normaliseDriveLetter('/home/user/project')).toBe('/home/user/project');
    expect(normaliseDriveLetter('./relative/path')).toBe('./relative/path');
  });

  it('is idempotent', () => {
    const once = normaliseDriveLetter('c:\\x');
    expect(normaliseDriveLetter(once)).toBe(once);
  });
});

describe('package.json vitest scripts', () => {
  const scripts = (
    JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  const vitestScripts = ['test:fast', 'test:extended', 'test:all', 'test:cov', 'test:watch'];

  it.each(vitestScripts)(
    '%s routes through run-vitest.mjs rather than calling vitest directly',
    (name) => {
      const script = scripts[name];
      expect(script, `script "${name}" is missing`).toBeDefined();
      // Calling `vitest` directly reintroduces the drive-letter bug for any
      // caller whose cwd has a lowercase drive letter (e.g. the agentStop hook).
      expect(script).toContain('scripts/run-vitest.mjs');
      expect(script).not.toMatch(/(^|&&\s*|;\s*)vitest\b/);
    },
  );
});
