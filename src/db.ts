import { Database } from "bun:sqlite";

const db = new Database("sleep.db");
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    note TEXT NOT NULL DEFAULT ''
  );
`);

export type Entry = {
  id: number;
  started_at: string; // ISO UTC
  ended_at: string | null; // ISO UTC, null = идёт сон
  note: string;
};

export type Feeding = {
  id: number;
  at: string; // ISO UTC — время окончания кормления
  amount_ml: number;
};

db.exec(`
  CREATE TABLE IF NOT EXISTS feedings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    amount_ml INTEGER NOT NULL DEFAULT 60
  );
`);

export const getActive = (): Entry | undefined =>
  db
    .query<Entry, []>("SELECT * FROM entries WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1")
    .get() ?? undefined;

export const listEntries = (limit = 200): Entry[] =>
  db
    .query<Entry, [number]>("SELECT * FROM entries ORDER BY started_at DESC LIMIT ?")
    .all(limit);

// Выборка за диапазон дат (границы — ISO-строки, сравнение лексикографическое)
export const listEntriesRange = (fromIso: string, toIso: string): Entry[] =>
  db
    .query<Entry, [string, string]>(
      "SELECT * FROM entries WHERE started_at >= ? AND started_at <= ? ORDER BY started_at ASC"
    )
    .all(fromIso, toIso);

export const getEntry = (id: number): Entry | undefined =>
  db.query<Entry, [number]>("SELECT * FROM entries WHERE id = ?").get(id) ?? undefined;

export const createEntry = (
  startedAt: string,
  endedAt: string | null,
  note = ""
): Entry =>
  db
    .query<Entry, [string, string | null, string]>(
      "INSERT INTO entries (started_at, ended_at, note) VALUES (?, ?, ?) RETURNING *"
    )
    .get(startedAt, endedAt, note)!;

export const startSleep = (startedAt: string, note = ""): Entry =>
  createEntry(startedAt, null, note);

export const stopSleep = (id: number, endedAt: string): Entry | undefined =>
  db
    .query<Entry, [string, number]>(
      "UPDATE entries SET ended_at = ? WHERE id = ? AND ended_at IS NULL RETURNING *"
    )
    .get(endedAt, id) ?? undefined;

export const updateEntry = (
  id: number,
  startedAt: string,
  endedAt: string | null,
  note: string
): Entry | undefined =>
  db
    .query<Entry, [string, string | null, string, number]>(
      "UPDATE entries SET started_at = ?, ended_at = ?, note = ? WHERE id = ? RETURNING *"
    )
    .get(startedAt, endedAt, note, id) ?? undefined;

export const deleteEntry = (id: number): boolean =>
  db.query("DELETE FROM entries WHERE id = ?").run(id).changes > 0;

// ---------- Питание ----------
export const listFeedings = (limit = 200): Feeding[] =>
  db
    .query<Feeding, [number]>("SELECT * FROM feedings ORDER BY at DESC LIMIT ?")
    .all(limit);

export const getFeeding = (id: number): Feeding | undefined =>
  db.query<Feeding, [number]>("SELECT * FROM feedings WHERE id = ?").get(id) ?? undefined;

export const listFeedingsRange = (fromIso: string, toIso: string): Feeding[] =>
  db
    .query<Feeding, [string, string]>(
      "SELECT * FROM feedings WHERE at >= ? AND at <= ? ORDER BY at ASC"
    )
    .all(fromIso, toIso);

export const createFeeding = (at: string, amountMl: number): Feeding =>
  db
    .query<Feeding, [string, number]>(
      "INSERT INTO feedings (at, amount_ml) VALUES (?, ?) RETURNING *"
    )
    .get(at, amountMl)!;

export const updateFeeding = (id: number, at: string, amountMl: number): Feeding | undefined =>
  db
    .query<Feeding, [string, number, number]>(
      "UPDATE feedings SET at = ?, amount_ml = ? WHERE id = ? RETURNING *"
    )
    .get(at, amountMl, id) ?? undefined;

export const deleteFeeding = (id: number): boolean =>
  db.query("DELETE FROM feedings WHERE id = ?").run(id).changes > 0;

export default db;
