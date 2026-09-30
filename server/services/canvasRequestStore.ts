import type Database from 'better-sqlite3';
export type CanvasRequest = { contentId: number | null; message: string; updatedAt: number };
export function createCanvasRequestStore(database: Database.Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS canvas_requests (
    user_id INTEGER NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    content_id INTEGER, message TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, request_id))`);
  const get = (owner: number, id: string) => database.prepare('SELECT content_id AS contentId, message, updated_at, fingerprint FROM canvas_requests WHERE user_id=? AND request_id=?').get(owner, id) as (CanvasRequest & { fingerprint: string }) | undefined;
  const claim = database.transaction((owner: number, id: string, fingerprint: string) => {
    const previous = get(owner, id);
    if (previous) return { fresh: false, mismatch: previous.fingerprint !== fingerprint, request: previous };
    database.prepare('INSERT INTO canvas_requests (user_id,request_id,fingerprint,updated_at) VALUES (?,?,?,?)').run(owner, id, fingerprint, Date.now());
    return { fresh: true, mismatch: false, request: get(owner, id)! };
  });
  const record = (owner: number, id: string, event: { contentId?: number; type?: string; message?: string }) => {
    if (Number.isSafeInteger(event.contentId) && event.contentId! > 0) database.prepare('UPDATE canvas_requests SET content_id=?, updated_at=? WHERE user_id=? AND request_id=?').run(event.contentId, Date.now(), owner, id);
    if (event.type === 'error' && event.message) database.prepare('UPDATE canvas_requests SET message=?, updated_at=? WHERE user_id=? AND request_id=?').run(event.message.slice(0, 1000), Date.now(), owner, id);
  };
  return { claim, get, record };
}
