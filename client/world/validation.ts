/**
 * Dependency-free runtime validation primitives for the world-data boundary.
 *
 * No third-party validation library (Zod etc.) is used — Phase 3 of the
 * client world-data contract work explicitly keeps this dependency-free.
 * Every primitive takes the value to check plus a `path` string describing
 * where in the input it was found, and either returns a narrowed value or
 * throws a `ValidationError` whose message includes that path, so a caller
 * failure always points at an actionable location (e.g.
 * `logistics.transports[0].cargo`).
 *
 * Consumed by `client/world/codec.ts` (compact-save + bootstrap decoding) and
 * `client/world/tilesClient.ts` (/api/world-tiles response decoding).
 */

/** Thrown by every primitive below on a validation failure. */
export class ValidationError extends Error {
  /** Dotted/bracketed property path where the failure occurred, e.g. `logistics.wells[0].tileIndex`. */
  readonly path: string;

  constructor(path: string, message: string) {
    super(`Invalid value at ${path || '<root>'}: ${message}`);
    this.path = path;
    this.name = 'ValidationError';
  }
}

/** Throw a `ValidationError` for the given path/message. Always throws (never returns). */
export function fail(path: string, message: string): never {
  throw new ValidationError(path, message);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Join a parent path and a child key/index into a dotted/bracketed path string. */
export function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return parent ? `${parent}.${key}` : key;
}

/** Validate `value` is a plain (non-array, non-null) object. */
export function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, `expected an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

/** Validate `value` is an array (elements not yet checked). */
export function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, `expected an array, got ${describe(value)}`);
  return value;
}

/** Validate `value` is an array and decode every element with `decode`. */
export function expectArrayOf<T>(
  value: unknown,
  path: string,
  decode: (v: unknown, path: string) => T,
): T[] {
  const arr = expectArray(value, path);
  return arr.map((v, i) => decode(v, childPath(path, i)));
}

/** Validate `value` is a string. */
export function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, `expected a string, got ${describe(value)}`);
  return value;
}

/** Validate `value` is a non-empty string. */
export function expectNonEmptyString(value: unknown, path: string): string {
  const s = expectString(value, path);
  if (s.length === 0) fail(path, 'expected a non-empty string');
  return s;
}

/** Validate `value` is a boolean. */
export function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, `expected a boolean, got ${describe(value)}`);
  return value;
}

/** Validate `value` is a finite number (rejects NaN/Infinity and non-numbers). */
export function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, `expected a finite number, got ${describe(value)}`);
  }
  return value;
}

/** Validate `value` is a finite integer. */
export function expectInteger(value: unknown, path: string): number {
  const n = expectFiniteNumber(value, path);
  if (!Number.isInteger(n)) fail(path, `expected an integer, got ${n}`);
  return n;
}

/** Validate `value` is a non-negative finite integer. */
export function expectNonNegativeInteger(value: unknown, path: string): number {
  const n = expectInteger(value, path);
  if (n < 0) fail(path, `expected a non-negative integer, got ${n}`);
  return n;
}

/** Validate `value` is an integer within `[min, max]` inclusive. */
export function expectIntegerInRange(value: unknown, path: string, min: number, max: number): number {
  const n = expectInteger(value, path);
  if (n < min || n > max) fail(path, `expected an integer in [${min}, ${max}], got ${n}`);
  return n;
}

/** Validate `value` is one of a fixed set of string literals (enum/discriminant check). */
export function expectEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  const s = expectString(value, path);
  if (!allowed.includes(s as T)) {
    fail(path, `expected one of ${allowed.map((a) => `"${a}"`).join(', ')}, got "${s}"`);
  }
  return s as T;
}

/** Validate `value` is one of a fixed set of number literals. */
export function expectNumberEnum<T extends number>(value: unknown, path: string, allowed: readonly T[]): T {
  const n = expectFiniteNumber(value, path);
  if (!allowed.includes(n as T)) {
    fail(path, `expected one of ${allowed.join(', ')}, got ${n}`);
  }
  return n as T;
}

/**
 * Decode an optional property: `undefined` passes through untouched, any
 * other value (including `null`, which callers should reject explicitly if
 * they don't accept it) is decoded with `decode`.
 */
export function optional<T>(
  value: unknown,
  path: string,
  decode: (v: unknown, path: string) => T,
): T | undefined {
  if (value === undefined) return undefined;
  return decode(value, path);
}
