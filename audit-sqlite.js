// Opt-in persistent store for x402-spotcheck/audit (ported from Gatecheck src/db.js).
// Needs node:sqlite (Node >= 22.13). Nothing imports this file unless you do, so the base package keeps Node >= 18.
//
//   import { openAuditStore } from "x402-spotcheck/audit/sqlite";
//   const store = await openAuditStore("./audit.db");
//   const audit = createAudit({ store, payloadKey, policy });   // same API as before
//
// What persists: the hash-chained ledger entries, the budget reservations, and the AES-GCM sealed payloads
// (each still bound to its reservation id as additionalData). Plaintext payloads are never written: without
// payloadKey a stored payload lives in memory only, as in 1.5.x.
// Write policy: after every locked audit step, all changes go to disk in ONE BEGIN IMMEDIATE transaction
// (WAL, synchronous=FULL). A crash mid-write leaves the previous state.
// Fail closed: a corrupt file, a chain that no longer verifies, or a file another process already holds refuses
// to open (StoreUnavailableError). If a write fails later, beforePayment aborts the payment.
// Single writer: the connection takes an exclusive lock for its lifetime, so a second process cannot open the
// same file. One audit instance per file; not for network filesystems.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export { StoreUnavailableError } from "./audit.js";
import { StoreUnavailableError } from "./audit.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger (seq INTEGER PRIMARY KEY, hash TEXT NOT NULL, entry TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, rec TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payloads (id TEXT PRIMARY KEY, blob TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

async function sqlite() {
  try { return await import("node:sqlite"); }
  catch (e) { throw new StoreUnavailableError("x402-spotcheck/audit/sqlite needs node:sqlite (Node >= 22.13)", e); }
}

/** Open (or create) the store. Rejects with StoreUnavailableError when it can't be used safely. */
export async function openAuditStore(path, { busyTimeoutMs = 2000 } = {}) {
  if (!path) throw new TypeError("openAuditStore needs a file path (or ':memory:')");
  const { DatabaseSync } = await sqlite();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Number(busyTimeoutMs) | 0)};`);
    const qc = db.prepare("PRAGMA quick_check").get();
    const verdict = qc && Object.values(qc)[0];
    if (verdict !== "ok") throw new Error("quick_check: " + verdict);
    db.exec("PRAGMA locking_mode = EXCLUSIVE;");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
    db.exec("BEGIN IMMEDIATE"); // takes the write lock now and, in EXCLUSIVE mode, keeps it
    db.exec(SCHEMA);
    db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('schema', '1')").run();
    db.exec("COMMIT");
  } catch (e) {
    try { db?.close(); } catch { /* ignore */ }
    throw new StoreUnavailableError(`audit store unavailable (${path}): ${e?.message || e}`, e);
  }

  const q = {
    entries: db.prepare("SELECT entry FROM ledger ORDER BY seq"),
    reservations: db.prepare("SELECT rec FROM reservations"),
    payloads: db.prepare("SELECT id, blob FROM payloads"),
    putEntry: db.prepare("INSERT INTO ledger (seq, hash, entry) VALUES (?, ?, ?)"),
    putRes: db.prepare("INSERT INTO reservations (id, rec) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET rec = excluded.rec"),
    putBlob: db.prepare("INSERT INTO payloads (id, blob) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET blob = excluded.blob"),
    delBlob: db.prepare("DELETE FROM payloads WHERE id = ?"),
    maxSeq: db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM ledger"),
  };
  let closed = false;
  const lastRes = new Map(); // id -> JSON last written, so only changed rows are rewritten
  const lastBlob = new Map();

  return {
    kind: "sqlite",
    path,
    /** Everything on disk, for createAudit to load at start. */
    load() {
      const entries = q.entries.all().map((r) => JSON.parse(r.entry));
      const reservations = q.reservations.all().map((r) => { lastRes.set(JSON.parse(r.rec).id, r.rec); return JSON.parse(r.rec); });
      const payloads = new Map(q.payloads.all().map((r) => { lastBlob.set(r.id, r.blob); return [r.id, JSON.parse(r.blob)]; }));
      return { entries, reservations, payloads };
    },
    /** Write new entries and changed reservations/payloads in one transaction. Throws StoreUnavailableError. */
    flush({ entries, reservations, payloads }) {
      if (closed) throw new StoreUnavailableError("audit store is closed");
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const have = Number(q.maxSeq.get().n);
          for (const e of entries) if (e.seq > have) q.putEntry.run(e.seq, e.hash, JSON.stringify(e));
          const wroteRes = [], wroteBlob = [], dropped = [];
          for (const r of reservations) {
            const j = JSON.stringify(r);
            if (lastRes.get(r.id) !== j) { q.putRes.run(r.id, j); wroteRes.push([r.id, j]); }
          }
          for (const [id, blob] of payloads) {
            const j = JSON.stringify(blob);
            if (lastBlob.get(id) !== j) { q.putBlob.run(id, j); wroteBlob.push([id, j]); }
          }
          for (const id of lastBlob.keys()) if (!payloads.has(id)) { q.delBlob.run(id); dropped.push(id); }
          db.exec("COMMIT");
          for (const [id, j] of wroteRes) lastRes.set(id, j);
          for (const [id, j] of wroteBlob) lastBlob.set(id, j);
          for (const id of dropped) lastBlob.delete(id);
        } catch (e) {
          try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
          throw e;
        }
      } catch (e) {
        if (e instanceof StoreUnavailableError) throw e;
        throw new StoreUnavailableError("audit store write failed: " + (e?.message || e), e);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
