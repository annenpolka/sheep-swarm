import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { KernelState } from "./kernel.ts";
import { validateKernelState, KernelStateError } from "./kernel-state.ts";

export type JournalErrorCode = "generation-conflict" | "invalid-generation" | "invalid-state"
  | "corrupt-payload" | "unsupported-schema" | "journal-closed" | "sqlite-error" | "invalid-path";

export class JournalError extends Error {
  readonly code: JournalErrorCode;
  constructor(code: JournalErrorCode, message: string = code, options?: ErrorOptions) {
    super(message, options); this.name = "JournalError"; this.code = code;
  }
}

export interface JournalSnapshot { generation: number; state: KernelState }
const schemaVersion = 1;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const hash = (payload: string): string => createHash("sha256").update(payload).digest("hex");

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new JournalError("invalid-state", message);
}


function encode(state: KernelState): string {
  try {
    validateKernelState(state);
    // Check the original values before JSON.stringify can invoke toJSON or discard a field.
    const ancestors = new Set<object>();
    const jsonValue = (value: unknown): void => {
      if (value === null || typeof value === "string" || typeof value === "boolean" || finite(value)) return;
      check(typeof value === "object" && value !== null && (Array.isArray(value)
        || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
      "state must contain only JSON values");
      check(!ancestors.has(value), "state contains a circular reference");
      ancestors.add(value);
      for (const item of Array.isArray(value) ? value : Object.values(value)) jsonValue(item);
      ancestors.delete(value);
    };
    jsonValue(state);
    return JSON.stringify(state);
  } catch (error) {
    if (error instanceof JournalError) throw error;
    throw new JournalError("invalid-state", "state could not be serialized", { cause: error });
  }
}

function databaseError(error: unknown): JournalError {
  if (error instanceof KernelStateError) return new JournalError("invalid-state", error.message, { cause: error });
  return error instanceof JournalError ? error : new JournalError("sqlite-error", "SQLite operation failed", { cause: error });
}

/** One complete kernel snapshot, its outbox, and its evidence form one SQLite commit. */
export class SqliteJournal {
  #db: DatabaseSync;
  #closed = false;

  constructor(file: string) {
    if (!text(file) || file === ":memory:") throw new JournalError("invalid-path", "a persistent SQLite file is required");
    try { this.#db = new DatabaseSync(file, { timeout: 5_000, enableDoubleQuotedStringLiterals: false }); }
    catch (error) { throw databaseError(error); }
    try {
      const version = this.#db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== schemaVersion) throw new JournalError("unsupported-schema");
      this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      if (this.#db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal"
        || this.#db.prepare("PRAGMA synchronous").get()?.synchronous !== 2)
        throw new JournalError("sqlite-error", "WAL and FULL synchronization are required");
      this.#db.exec("BEGIN IMMEDIATE");
      const current = this.#db.prepare("PRAGMA user_version").get()?.user_version;
      if (current === 0) {
        const tables = this.#db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        if (tables.length) throw new JournalError("unsupported-schema", "unversioned database is not empty");
        this.#db.exec(`CREATE TABLE swarm_snapshot (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          generation INTEGER NOT NULL CHECK (generation > 0),
          state_format INTEGER NOT NULL CHECK (state_format = 1),
          payload TEXT NOT NULL,
          sha256 TEXT NOT NULL CHECK (length(sha256) = 64)
        ) STRICT; PRAGMA user_version=1;`);
      } else if (current !== schemaVersion) throw new JournalError("unsupported-schema");
      this.#db.prepare("SELECT generation, state_format, payload, sha256 FROM swarm_snapshot WHERE singleton=1").get();
      this.#db.exec("COMMIT");
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* Preserve the first error. */ }
      this.#db.close(); this.#closed = true;
      throw databaseError(error);
    }
  }

  #open(): void { if (this.#closed) throw new JournalError("journal-closed"); }

  #read(): JournalSnapshot | null {
    if (this.#db.prepare("PRAGMA user_version").get()?.user_version !== schemaVersion)
      throw new JournalError("unsupported-schema");
    const row = this.#db.prepare("SELECT generation, state_format, payload, sha256 FROM swarm_snapshot WHERE singleton=1").get();
    if (!row) return null;
    if (!integer(row.generation) || row.generation === 0 || row.state_format !== 1
      || typeof row.payload !== "string" || typeof row.sha256 !== "string" || hash(row.payload) !== row.sha256)
      throw new JournalError("corrupt-payload", "snapshot metadata or SHA256 does not match");
    let state: unknown;
    try { state = JSON.parse(row.payload); }
    catch (error) { throw new JournalError("corrupt-payload", "snapshot is not valid JSON", { cause: error }); }
    validateKernelState(state);
    return { generation: row.generation, state };
  }

  load(): JournalSnapshot | null {
    this.#open();
    try { return this.#read(); } catch (error) { throw databaseError(error); }
  }

  save(state: KernelState, expectedGeneration: number): number {
    this.#open();
    if (!integer(expectedGeneration) || expectedGeneration === Number.MAX_SAFE_INTEGER)
      throw new JournalError("invalid-generation");
    const payload = encode(state);
    const digest = hash(payload);
    let transaction = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE"); transaction = true;
      const current = this.#read();
      if ((current?.generation ?? 0) !== expectedGeneration) throw new JournalError("generation-conflict");
      const generation = expectedGeneration + 1;
      if (current === null) {
        this.#db.prepare("INSERT INTO swarm_snapshot(singleton,generation,state_format,payload,sha256) VALUES(1,?,1,?,?)")
          .run(generation, payload, digest);
      } else {
        const result = this.#db.prepare("UPDATE swarm_snapshot SET generation=?,payload=?,sha256=? WHERE singleton=1 AND generation=?")
          .run(generation, payload, digest, expectedGeneration);
        if (Number(result.changes) !== 1) throw new JournalError("generation-conflict");
      }
      this.#db.exec("COMMIT"); transaction = false;
      return generation;
    } catch (error) {
      if (transaction) try { this.#db.exec("ROLLBACK"); } catch { /* Preserve the original rejection. */ }
      throw databaseError(error);
    }
  }

  close(): void {
    if (this.#closed) return;
    try { this.#db.close(); this.#closed = true; } catch (error) { throw databaseError(error); }
  }
}
