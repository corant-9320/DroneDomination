/**
 * Authoritative match-session store (server-authority Phase 3).
 *
 * Persists `MatchState` between requests with optimistic-concurrency control.
 *
 * ── Backend decision ──────────────────────────────────────────────────────────
 * Production target is **DynamoDB** (one item per match, keyed by `matchId`,
 * versioned with a conditional write). For now we run **locally with the Dynamo
 * call mocked** by an in-memory map (`MockDynamoTableClient`) that emulates the
 * exact contract the real table client will have — including the conditional
 * (optimistic-lock) write. Swapping to real DynamoDB is then a single adapter:
 * implement `DynamoTableClient` with `@aws-sdk/lib-dynamodb` (region eu-west-1)
 * and hand it to `SessionStore`; no game-logic changes required.
 *
 * The real adapter would look like:
 *
 *   import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
 *   import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
 *   // getItem  → GetCommand({ TableName, Key:{ matchId } })
 *   // putItem  → PutCommand({ TableName, Item: state,
 *   //              ConditionExpression: 'attribute_not_exists(matchId) OR version = :v',
 *   //              ExpressionAttributeValues: { ':v': expectedVersion } })
 *   //            → on ConditionalCheckFailedException throw VersionConflictError
 */

import type { MatchState } from '../shared/matchTypes.js';

/** Thrown when a conditional (optimistic-lock) write loses a race. */
export class VersionConflictError extends Error {
  constructor(matchId: string) {
    super(`Version conflict writing match ${matchId}`);
    this.name = 'VersionConflictError';
  }
}

/**
 * The minimal DynamoDB-shaped contract the session store depends on. The real
 * implementation wraps the AWS SDK document client; the mock uses a Map.
 */
export interface DynamoTableClient {
  /** Read a match item, or null if absent. */
  getItem(matchId: string): Promise<MatchState | null>;
  /**
   * Conditional put. `expectedVersion` is null for a create (item must not
   * exist) or the version the caller read for an update (stored version must
   * still equal it). Throws `VersionConflictError` when the condition fails.
   */
  putItem(state: MatchState, expectedVersion: number | null): Promise<void>;
}

// ---------------------------------------------------------------------------
// Mock DynamoDB table client (local mode)
// ---------------------------------------------------------------------------

/**
 * In-memory stand-in for the DynamoDB table. Emulates the conditional write so
 * the optimistic-concurrency code path is exercised exactly as it will be in
 * production. Deep-clones on read/write so callers can't mutate stored state
 * by reference (mirrors the serialise/deserialise boundary of a real table).
 */
export class MockDynamoTableClient implements DynamoTableClient {
  private table = new Map<string, MatchState>();

  async getItem(matchId: string): Promise<MatchState | null> {
    const item = this.table.get(matchId);
    return item ? structuredClone(item) : null;
  }

  async putItem(state: MatchState, expectedVersion: number | null): Promise<void> {
    const existing = this.table.get(state.matchId);
    if (expectedVersion === null) {
      if (existing) throw new VersionConflictError(state.matchId); // create requires absence
    } else if (!existing || existing.version !== expectedVersion) {
      throw new VersionConflictError(state.matchId);
    }
    this.table.set(state.matchId, structuredClone(state));
  }
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

/**
 * Loads/saves `MatchState` with optimistic concurrency. Game logic depends only
 * on this class, never on the underlying table client.
 */
export class SessionStore {
  constructor(private readonly db: DynamoTableClient) {}

  /** Persist a brand-new match (version 1). */
  async create(state: MatchState): Promise<MatchState> {
    const created: MatchState = { ...state, version: 1 };
    await this.db.putItem(created, null);
    return created;
  }

  /** Load a match by id, or null if it doesn't exist. */
  async get(matchId: string): Promise<MatchState | null> {
    return this.db.getItem(matchId);
  }

  /**
   * Conditionally save an updated match. `state.version` must be the version
   * that was read; the stored version must still match it or the write is
   * rejected with `VersionConflictError`. Returns the state with its bumped
   * version.
   */
  async update(state: MatchState): Promise<MatchState> {
    const next: MatchState = { ...state, version: state.version + 1 };
    await this.db.putItem(next, state.version);
    return next;
  }
}

// ---------------------------------------------------------------------------
// Singleton (local mode)
// ---------------------------------------------------------------------------

let store: SessionStore | null = null;

/**
 * Process-wide session store. Local mode uses the mocked Dynamo table client.
 * To deploy, construct `new SessionStore(new DynamoDbTableClient(...))` here.
 */
export function getSessionStore(): SessionStore {
  if (!store) store = new SessionStore(new MockDynamoTableClient());
  return store;
}

/** Test/maintenance hook: reset the in-memory store. */
export function __resetSessionStore(): void {
  store = null;
}
