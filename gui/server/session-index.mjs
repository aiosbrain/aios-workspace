import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function readSessionIndex(indexPath) {
  try {
    const idx = JSON.parse(readFileSync(indexPath, "utf8"));
    if (Array.isArray(idx.sessions))
      return { sessions: idx.sessions, lastSelected: idx.lastSelected || null };
  } catch {
    /* missing/corrupt -> fresh */
  }
  return { sessions: [], lastSelected: null };
}

export function writeSessionIndex(indexPath, idx) {
  try {
    writeFileSync(indexPath, JSON.stringify(idx, null, 2));
  } catch {
    /* best-effort */
  }
}

// Insert or update one session entry (merge fields), bump updatedAt, set lastSelected.
export function upsertSession(indexPath, id, fields = {}) {
  const idx = readSessionIndex(indexPath);
  let session = idx.sessions.find((x) => x.id === id);
  if (!session) {
    session = { id, title: "", createdAt: new Date().toISOString(), model: "" };
    idx.sessions.push(session);
  }
  Object.assign(session, fields, { updatedAt: new Date().toISOString() });
  idx.lastSelected = id;
  writeSessionIndex(indexPath, idx);
  return session;
}

export function hasVisibleSessionContent(sessionsDir, session) {
  if (String(session?.title || "").trim()) return true;
  if (!session?.id) return false;

  const transcript = path.join(sessionsDir, `${session.id}.jsonl`);
  if (!existsSync(transcript)) return false;

  try {
    for (const line of readFileSync(transcript, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "echo_user" && String(event.text || "").trim()) return true;
      } catch {
        /* skip torn lines */
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function visibleSessionIndex(sessionsDir, idx) {
  const sessions = idx.sessions
    .filter((session) => hasVisibleSessionContent(sessionsDir, session))
    .sort((a, b) =>
      (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "")
    );
  const visibleIds = new Set(sessions.map((session) => session.id));
  return {
    sessions,
    lastSelected: visibleIds.has(idx.lastSelected) ? idx.lastSelected : null,
  };
}
