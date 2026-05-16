/**
 * DEBUG — Centralized console debug logging for Drone Domination.
 *
 * Toggle off at runtime:  localStorage.setItem('dd-debug', 'off')
 * Toggle on (default):    localStorage.removeItem('dd-debug')
 *
 * To remove all debug logging from the project:
 *   1. Delete this file (client/debug.ts)
 *   2. Search for "from './debug.js'" and remove those imports + all dbg.* calls
 *   3. Search for "[DD]" in case any raw console.log slipped in
 */

const DEBUG_ENABLED =
  typeof window !== 'undefined' && localStorage.getItem('dd-debug') !== 'off';

const PREFIX = '[DD]';

interface Logger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  table: (data: unknown, columns?: string[]) => void;
  time: (label: string) => void;
  timeEnd: (label: string) => void;
  group: (label: string) => void;
  groupEnd: () => void;
  assert: (condition: boolean, ...args: unknown[]) => void;
}

function makeLogger(ns: string): Logger {
  const tag = `${PREFIX}[${ns}]`;
  /* eslint-disable no-console */
  return {
    log: (...args) => { if (DEBUG_ENABLED) console.log(tag, ...args); },
    warn: (...args) => { if (DEBUG_ENABLED) console.warn(tag, ...args); },
    error: (...args) => { console.error(tag, ...args); }, // errors always show
    table: (data, columns?) => { if (DEBUG_ENABLED) console.table(data, columns); },
    time: (label) => { if (DEBUG_ENABLED) console.time(`${tag} ${label}`); },
    timeEnd: (label) => { if (DEBUG_ENABLED) console.timeEnd(`${tag} ${label}`); },
    group: (label) => { if (DEBUG_ENABLED) console.groupCollapsed(`${tag} ${label}`); },
    groupEnd: () => { if (DEBUG_ENABLED) console.groupEnd(); },
    assert: (condition, ...args) => { if (DEBUG_ENABLED) console.assert(condition, tag, ...args); },
  };
  /* eslint-enable no-console */
}

/**
 * Namespaced debug loggers. Use the one matching the subsystem you're in.
 */
export const dbg = {
  world: makeLogger('world'),
  globe: makeLogger('globe'),
  localMap: makeLogger('localMap'),
  detail: makeLogger('detail'),
  modal: makeLogger('modal'),
  api: makeLogger('api'),
  input: makeLogger('input'),
  init: makeLogger('init'),
} as const;

/** Quick runtime check — call from the console to verify debug is wired up. */
(window as unknown as Record<string, unknown>).__DD_DEBUG__ = {
  enabled: DEBUG_ENABLED,
  toggle: (on: boolean) => {
    if (on) localStorage.removeItem('dd-debug');
    else localStorage.setItem('dd-debug', 'off');
    console.log(`${PREFIX} Debug ${on ? 'enabled' : 'disabled'}. Reload to apply.`);
  },
};
