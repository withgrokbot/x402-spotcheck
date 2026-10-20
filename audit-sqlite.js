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
// Shared mode (P2, opt-in: openAuditStore(path, { shared: true })): no exclusive lock. Several processes on ONE
// machine may use the file. Each audit step is a BEGIN IMMEDIATE transaction that first pulls the other
// processes' rows (by revision), so budgets and the chain are always decided on current data. A UNIQUE index
// enforces one live reservation per idempotency key. Local disk only (WAL needs shared memory).
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

// Shared mode: connections to the same file inside ONE process queue on an async mutex first, so a second
// connection never blocks the thread in busy_timeout while the first one awaits mid-transaction.
const fileLocks = new Map();
function fileMutex(key) {
  let m = fileLocks.get(key);
  if (!m) { m = { tail: Promise.resolve() }; fileLocks.set(key, m); }
  return () => { let release; const ready = m.tail; m.tail = new Promise((r) => (release = r)); return ready.then(() => release); };
}

async function sqlite() {
  try { return await import("node:sqlite"); }
  catch (e) { throw new StoreUnavailableError("x402-spotcheck/audit/sqlite needs node:sqlite (Node >= 22.13)", e); }
}

/** Open (or create) the store. Rejects with StoreUnavailableError when it can't be used safely. */
export async function openAuditStore(path, { busyTimeoutMs, shared = false } = {}) {
  busyTimeoutMs ??= shared ? 30000 : 2000;
  if (shared && path === ":memory:") throw new TypeError("shared mode needs a file path");
  if (!path) throw new TypeError("openAuditStore needs a file path (or ':memory:')");
  const { DatabaseSync } = await sqlite();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  let db;
  // Shared mode: several processes may open (and create) the file at once; WAL setup and the schema step can see
  // SQLITE_BUSY outside busy_timeout. Retry those until busyTimeoutMs; anything else fails closed at once.
  const deadline = Date.now() + Math.max(0, Number(busyTimeoutMs) | 0);
  for (let attempt = 0; ; attempt++) {
  try {
    db = new DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Number(busyTimeoutMs) | 0)};`);
    const qc = db.prepare("PRAGMA quick_check").get();
    const verdict = qc && Object.values(qc)[0];
    if (verdict !== "ok") throw new Error("quick_check: " + verdict);
    if (!shared) db.exec("PRAGMA locking_mode = EXCLUSIVE;");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
    db.exec("BEGIN IMMEDIATE"); // takes the write lock now and, in EXCLUSIVE mode, keeps it
    db.exec(SCHEMA);
    db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('schema', '1')").run();
    // schema 2 (additive): row revisions for shared mode + one live reservation per idempotency key
    for (const t of ["reservations", "payloads"]) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      if (!cols.includes("rev")) db.exec(`ALTER TABLE ${t} ADD COLUMN rev INTEGER NOT NULL DEFAULT 0`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idem_live ON reservations (json_extract(rec, '$.idem'))
      WHERE json_extract(rec, '$.idem') IS NOT NULL AND json_extract(rec, '$.status') IN ('open', 'settled')`);
    db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('rev', '0')").run();
    db.prepare("UPDATE meta SET v = '2' WHERE k = 'schema'").run();
    db.exec("COMMIT");
    break;
  } catch (e) {
    try { db?.close(); } catch { /* ignore */ }
    db = null;
    if (shared && /busy|locked/i.test(String(e?.message || e)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(200, 5 * 2 ** Math.min(attempt, 5)) + Math.random() * 10));
      continue;
    }
    throw new StoreUnavailableError(`audit store unavailable (${path}): ${e?.message || e}`, e);
  }
  }

  const q = {
    entries: db.prepare("SELECT entry FROM ledger ORDER BY seq"),
    reservations: db.prepare("SELECT rec FROM reservations"),
    payloads: db.prepare("SELECT id, blob FROM payloads"),
    putEntry: db.prepare("INSERT INTO ledger (seq, hash, entry) VALUES (?, ?, ?)"),
    putRes: db.prepare("INSERT INTO reservations (id, rec, rev) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET rec = excluded.rec, rev = excluded.rev"),
    putBlob: db.prepare("INSERT INTO payloads (id, blob, rev) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET blob = excluded.blob, rev = excluded.rev"),
    delBlob: shared ? db.prepare("UPDATE payloads SET blob = 'null', rev = ? WHERE id = ?") : db.prepare("DELETE FROM payloads WHERE id = ?"),
    getRev: db.prepare("SELECT v FROM meta WHERE k = 'rev'"),
    setRev: db.prepare("UPDATE meta SET v = ? WHERE k = 'rev'"),
    entriesSince: db.prepare("SELECT entry FROM ledger WHERE seq > ? ORDER BY seq"),
    resSince: db.prepare("SELECT rec, rev FROM reservations WHERE rev > ?"),
    blobsSince: db.prepare("SELECT id, blob, rev FROM payloads WHERE rev > ?"),
    maxSeq: db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM ledger"),
  };
  let closed = false;
  let inTx = false;
  let releaseFile = null;
  const acquire = shared ? fileMutex((await import("node:path")).resolve(path)) : null;
  let seenSeq = 0, seenRev = 0; // shared mode: what this connection has already pulled
  const lastRes = new Map(); // id -> JSON last written, so only changed rows are rewritten
  const lastBlob = new Map();

  return {
    kind: "sqlite",
    path,
    shared,
    /** Everything on disk, for createAudit to load at start. */
    load() {
      lastRes.clear(); lastBlob.clear();
      seenRev = Number(q.getRev.get().v) || 0;
      const entries = q.entries.all().map((r) => JSON.parse(r.entry));
      const reservations = q.reservations.all().map((r) => { lastRes.set(JSON.parse(r.rec).id, r.rec); return JSON.parse(r.rec); });
      const payloads = new Map(q.payloads.all().filter((r) => r.blob !== "null").map((r) => { lastBlob.set(r.id, r.blob); return [r.id, JSON.parse(r.blob)]; }));
      seenSeq = entries.length;
      return { entries, reservations, payloads };
    },
    /** Shared mode: open the step's write transaction (waits up to busyTimeoutMs for other processes). */
    async begin() {
      if (closed) throw new StoreUnavailableError("audit store is closed");
      releaseFile = await acquire();
      try { db.exec("BEGIN IMMEDIATE"); inTx = true; }
      catch (e) { releaseFile(); releaseFile = null; throw new StoreUnavailableError("audit store busy/locked: " + (e?.message || e), e); }
    },
    /** Shared mode, inside begin(): rows other processes wrote since this connection last looked. */
    changes() {
      const entries = q.entriesSince.all(seenSeq).map((r) => JSON.parse(r.entry));
      const reservations = [];
      for (const r of q.resSince.all(seenRev)) { if (lastRes.get(JSON.parse(r.rec).id) !== r.rec) reservations.push(JSON.parse(r.rec)); lastRes.set(JSON.parse(r.rec).id, r.rec); }
      const payloads = [];
      for (const r of q.blobsSince.all(seenRev)) {
        if (r.blob === "null") { lastBlob.delete(r.id); payloads.push([r.id, null]); }
        else { if (lastBlob.get(r.id) !== r.blob) payloads.push([r.id, JSON.parse(r.blob)]); lastBlob.set(r.id, r.blob); }
      }
      seenSeq += entries.length;
      seenRev = Number(q.getRev.get().v) || 0;
      return { entries, reservations, payloads };
    },
    commit() { try { if (inTx) { db.exec("COMMIT"); inTx = false; } } finally { releaseFile?.(); releaseFile = null; } },
    rollback() { if (inTx) { inTx = false; try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } } releaseFile?.(); releaseFile = null; },
    /** Write new entries and changed reservations/payloads in one transaction. Throws StoreUnavailableError. */
    flush({ entries, reservations, payloads }) {
      if (closed) throw new StoreUnavailableError("audit store is closed");
      try {
        const own = !inTx;
        if (own) db.exec("BEGIN IMMEDIATE");
        try {
          let rev = Number(q.getRev.get().v) || 0;
          const rev0 = rev;
          const have = Number(q.maxSeq.get().n);
          for (const e of entries) if (e.seq > have) q.putEntry.run(e.seq, e.hash, JSON.stringify(e));
          const wroteRes = [], wroteBlob = [], dropped = [];
          for (const r of reservations) {
            const j = JSON.stringify(r);
            if (lastRes.get(r.id) !== j) { q.putRes.run(r.id, j, ++rev); wroteRes.push([r.id, j]); }
          }
          for (const [id, blob] of payloads) {
            const j = JSON.stringify(blob);
            if (lastBlob.get(id) !== j) { q.putBlob.run(id, j, ++rev); wroteBlob.push([id, j]); }
          }
          for (const id of lastBlob.keys()) if (!payloads.has(id)) { if (shared) q.delBlob.run(++rev, id); else q.delBlob.run(id); dropped.push(id); }
          if (rev !== rev0) q.setRev.run(String(rev));
          if (own) db.exec("COMMIT");
          for (const [id, j] of wroteRes) lastRes.set(id, j);
          for (const [id, j] of wroteBlob) lastBlob.set(id, j);
          for (const id of dropped) lastBlob.delete(id);
          seenSeq = Math.max(seenSeq, entries.length);
          if (shared) seenRev = rev;
        } catch (e) {
          if (own) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } }
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
