// Pure helpers for parsing and merging the markdown task/decision tables that the `aios`
// CLI syncs to the Team Brain. Kept dependency-free and side-effect-free so they can be
// unit-tested directly (see test/tasks-table.test.mjs) without invoking the CLI.

// AIO-524: `—` (em dash) is the workspace-wide "no value" sentinel used in every scaffolded
// markdown table (tasks-team.md, tasks-private.md, decision-log.md, scope-ledger.md, etc — see
// scripts/scaffold-project.sh). parseFactRows/parseStakeholderMentionRows (workspace-parse.mjs)
// already treat a bare `—` cell as "no value" for their date-ish fields (occurredAt); parseTaskRows
// didn't, so a fresh scaffold's example task row (`Due` column = `—`) round-tripped the literal
// em-dash character into `due`, which the Team Brain writes straight into a Postgres `date` column
// (`due_date date` in postgres/schema.sql) — "invalid input syntax for type date" on the very first
// `aios push`. Only date-shaped fields need this (assignee/status/sprint are free text on the brain
// side and tolerate a literal `—`). Exported so workspace-parse.mjs's decision-row parser (which
// has the same due_date-shaped `decided_at` column on the brain side) reuses this instead of a
// second, independently-drifting "—"-to-null implementation.
export function dateCell(cells, idx, name) {
  const i = idx(name);
  if (i < 0) return null;
  const value = cells[i];
  return value && value !== "—" ? value : null;
}

export function parseTableRows(body) {
  const rows = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = [];
    let cell = "";
    let lastTokenWasDelimiter = false;
    for (let i = 1; i < t.length; i++) {
      if (t[i] === "\\") {
        let end = i;
        while (t[end] === "\\") end++;
        const slashCount = end - i;
        if (t[end] === "|") {
          cell += "\\".repeat(Math.floor(slashCount / 2));
          if (slashCount % 2 === 1) {
            cell += "|";
            lastTokenWasDelimiter = false;
          } else {
            cells.push(cell.trim());
            cell = "";
            lastTokenWasDelimiter = true;
          }
          i = end;
        } else {
          cell += "\\".repeat(slashCount);
          lastTokenWasDelimiter = false;
          i = end - 1;
        }
      } else if (t[i] === "|") {
        cells.push(cell.trim());
        cell = "";
        lastTokenWasDelimiter = true;
      } else {
        cell += t[i];
        lastTokenWasDelimiter = false;
      }
    }
    if (!lastTokenWasDelimiter) cells.push(cell.trim());
    if (!cells.length) continue;
    if (cells.every((x) => /^[-: ]*$/.test(x))) continue; // separator row
    rows.push(cells);
  }
  return rows;
}

export function parsePmCell(raw, rowKey) {
  const value = raw.trim();
  if (!value) return {};
  // Linear is the only live PM provider. Plane is retired — we no longer recognize a `plane:`
  // cell as a projection target. History is still kept: an unrecognized cell (e.g. a legacy
  // `plane:T-01`) is preserved verbatim as `pm_raw` so it round-trips byte-for-byte through
  // mergeTaskWriteback rather than being blanked. It never becomes a live pm_provider, so it
  // is not re-projected.
  const m = value.match(/^(linear)(?::|\s+)?(.+)?$/i);
  if (!m) return { pm_raw: value };
  return {
    pm_provider: m[1].toLowerCase(),
    pm_external_id: (m[2] || rowKey).trim(),
  };
}

export function parseTaskRows(body) {
  // | ID | Task | Assignee | Status | Sprint | Due | PM | PM URL |
  // v1.2 optional hierarchy columns: | Parent | Labels | Priority | (body is dashboard/DB-only).
  const rows = parseTableRows(body);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.toLowerCase());
  if (!header.includes("id") || !header.includes("task")) return [];
  const idx = (name) => header.indexOf(name);
  return rows
    .slice(1)
    .map((cells) => {
      const rowKey = cells[idx("id")] || "";
      const pm = idx("pm") >= 0 ? parsePmCell(cells[idx("pm")] || "", rowKey) : {};
      const row = {
        row_key: rowKey,
        title: cells[idx("task")] || "",
        assignee: idx("assignee") >= 0 ? cells[idx("assignee")] || "" : "",
        status: idx("status") >= 0 ? cells[idx("status")] || "" : "",
        sprint: idx("sprint") >= 0 ? cells[idx("sprint")] || "" : "",
        due: dateCell(cells, idx, "due"),
        ...pm,
        pm_url: idx("pm url") >= 0 ? cells[idx("pm url")] || null : null,
      };
      // v1.2 hierarchy fields — only emit when the column is present (keep six-column tables clean).
      if (idx("parent") >= 0) row.parent = (cells[idx("parent")] || "").trim() || null;
      if (idx("labels") >= 0) {
        row.labels = (cells[idx("labels")] || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (idx("priority") >= 0) row.priority = (cells[idx("priority")] || "").trim() || null;
      return row;
    })
    .filter((r) => r.row_key);
}

// ── sync-origin return leg (brain-api 1.13, AIO-537) ─────────────────────────────────────────
// The brain→Linear projection is one-way and the dashboard writeback feed is UI-origin only, so
// a row this workspace PUSHED could change status in Linear and never come back — the markdown
// silently decayed (field audit: 6 rows said `todo` while Linear said Done). `aios pull` now also
// asks for `mode=sync-origin`, and these helpers decide which of those rows represent a REAL
// change worth writing.

// Mirrors the brain's `normalizeTaskStatus` (lib/api/schemas.ts): the canonical set plus the
// case/space/dash folding it applies. Returns null when the local text is NOT canonical (e.g.
// `todo`, `waiting on legal`) — the brain stored that verbatim in `raw_status` and mapped the row
// to `backlog`.
export const CANONICAL_TASK_STATUSES = ["backlog", "ready", "in_progress", "blocked", "done"];
export function canonicalTaskStatus(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return CANONICAL_TASK_STATUSES.includes(s) ? s : null;
}

/**
 * Plan the sync-origin merge: given the current markdown and the brain's sync-origin rows, return
 * the (few) rows that carry a REAL status/assignee change, each rebuilt from the LOCAL cells so
 * `mergeTaskWriteback` rewrites only those two fields and leaves every other column verbatim.
 *
 * Rules (contract, docs/brain-api.md § sync-origin return leg):
 *   • status/assignee only — body, title, sprint, due, hierarchy stay local/brain-canonical here.
 *   • never create or delete a row: a row_key with no local line is skipped (the return leg must
 *     not resurrect a row the owner deleted; genuinely new rows arrive via push/writeback).
 *   • ECHO GUARD: skip when the brain's status is merely a normalization of what this workspace
 *     pushed — either the local text already canonicalizes to the brain status, or the brain's
 *     `raw_status` still equals the local cell (the brain never re-derived it). An unknown local
 *     status like `todo` is overwritten ONLY by a real brain-side change (the brain clears
 *     `raw_status` when a provider sets the status authoritatively).
 *   • assignee: a non-empty brain assignee that differs wins; an empty one never blanks a local
 *     name (the brain's assignee is free text and often simply unset).
 */
export function planSyncOriginWriteback(content, rows) {
  const table = parseTableRows(content);
  const skipped = [];
  if (!table.length) return { rows: [], skipped: (rows || []).map((r) => r.row_key) };
  const header = table[0].map((h) => h.toLowerCase());
  if (!header.includes("id") || !header.includes("task"))
    return { rows: [], skipped: (rows || []).map((r) => r.row_key) };
  const at = (cells, name) => {
    const i = header.indexOf(name);
    return i >= 0 ? (cells[i] ?? "") : "";
  };
  const byKey = new Map();
  for (const cells of table.slice(1)) {
    const key = at(cells, "id");
    if (key && !byKey.has(key)) byKey.set(key, cells);
  }

  const out = [];
  for (const row of rows || []) {
    const cells = byKey.get(row.row_key);
    if (!cells) {
      skipped.push(row.row_key);
      continue;
    }
    const localStatus = at(cells, "status").trim();
    const localAssignee = at(cells, "assignee").trim();
    const brainStatus = String(row.status ?? "").trim();
    const brainAssignee = String(row.assignee ?? "").trim();
    const rawStatus = row.raw_status == null ? null : String(row.raw_status).trim();

    let status = localStatus;
    if (
      brainStatus &&
      canonicalTaskStatus(localStatus) !== brainStatus &&
      !(rawStatus !== null && rawStatus === localStatus)
    ) {
      status = brainStatus;
    }
    const assignee = brainAssignee && brainAssignee !== localAssignee ? brainAssignee : localAssignee;
    if (status === localStatus && assignee === localAssignee) {
      skipped.push(row.row_key);
      continue;
    }
    // Rebuild from the LOCAL cells (raw text, not re-parsed values) so `due: —`, a retired `pm`
    // cell, or a comma-spacing choice survives byte-for-byte; only status/assignee move.
    out.push({
      row_key: row.row_key,
      title: at(cells, "task"),
      assignee,
      status,
      sprint: at(cells, "sprint"),
      due: at(cells, "due"),
      parent: at(cells, "parent"),
      labels: at(cells, "labels"),
      priority: at(cells, "priority"),
      pm_raw: at(cells, "pm"),
      pm_url: at(cells, "pm url"),
    });
  }
  return { rows: out, skipped };
}

/**
 * Feature-detection for the return leg: a PRE-1.13 brain ignores `mode` and answers with the
 * dashboard writeback feed, which must NEVER be merged as if it were sync-origin. Trust only a
 * response that echoes `mode: "sync-origin"`, and only the requested project's group.
 */
export function syncOriginRowsFor(res, project) {
  if (!res || res.mode !== "sync-origin") return [];
  return (res.tasks || []).filter((g) => g.project === project).flatMap((g) => g.rows || []);
}

// Merge dashboard-writeback task rows into a markdown tasks.md table. Matches by row_key
// (updates in place; appends unknown rows; never deletes). v1.2: when the brain returns
// hierarchy fields (parent/labels/priority), the optional Parent|Labels|Priority columns are
// added to the header in place and existing rows padded; a plain six-column table with no
// such edits is left structurally untouched. `body` is never written here (dashboard/DB-only).
export function mergeTaskWriteback(content, rows) {
  const cellFor = (col, row) => {
    switch (col) {
      case "id":
        return row.row_key || "";
      case "task":
        return row.title || "";
      case "assignee":
        return row.assignee || "";
      case "status":
        return row.status || "";
      case "sprint":
        return row.sprint || "";
      case "due":
        return row.due || "";
      case "parent":
        return row.parent || "";
      case "labels":
        return Array.isArray(row.labels) ? row.labels.join(", ") : row.labels || "";
      case "priority":
        return row.priority || "";
      case "pm":
        // Live provider (linear) rebuilds as `provider:id`. Otherwise fall back to the preserved
        // raw cell (`pm_raw`) so a retired/unrecognized cell survives an edit round-trip instead of
        // being blanked. Only truly empty cells collapse to "".
        return row.pm_provider
          ? row.pm_external_id
            ? `${row.pm_provider}:${row.pm_external_id}`
            : row.pm_provider
          : row.pm_raw || "";
      case "pm url":
        return row.pm_url || "";
      default:
        return "";
    }
  };
  const reFor = (rowKey) =>
    new RegExp(`^\\|\\s*${(rowKey || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|.*$`, "m");
  const upsert = (text, rowKey, line) => {
    const re = reFor(rowKey);
    return re.test(text) ? text.replace(re, () => line) : text.trimEnd() + "\n" + line + "\n";
  };
  const isSeparator = (line) => {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    return cells.length > 0 && cells.every((c) => /^[-: ]*$/.test(c));
  };

  const lines = content.split("\n");
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const cells = lines[i]
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim().toLowerCase());
    if (cells.includes("id") && cells.includes("task")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    // No recognizable table — append legacy six-column lines. NOTE: hierarchy values on the
    // incoming rows are dropped here (there is no header to widen). This only happens when
    // tasks.md has no parseable table; the scaffold always ships one. Revisit if the brain
    // half ever needs to materialize a fresh hierarchical table from nothing.
    const order = ["id", "task", "assignee", "status", "sprint", "due"];
    let out = content;
    for (const row of rows)
      out = upsert(out, row.row_key, `| ${order.map((c) => cellFor(c, row)).join(" | ")} |`);
    return out;
  }

  // Upgrade the header in place only when a row carries a MEANINGFUL hierarchy value — not merely
  // the key. The brain writeback always includes parent/labels/priority (possibly null/[]/"none"),
  // so keying on presence would widen a six-column table on every pull; the contract says a table
  // with no hierarchy edits stays structurally untouched.
  const hasMeaningfulHierarchy = rows.some(
    (r) =>
      (typeof r.parent === "string" && r.parent.trim() !== "") ||
      (Array.isArray(r.labels) && r.labels.length > 0) ||
      (typeof r.priority === "string" &&
        r.priority.trim() !== "" &&
        r.priority.trim().toLowerCase() !== "none")
  );
  if (hasMeaningfulHierarchy) {
    const headerCells = lines[headerIdx]
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const lower = headerCells.map((c) => c.toLowerCase());
    const added = ["Parent", "Labels", "Priority"].filter((c) => !lower.includes(c.toLowerCase()));
    if (added.length) {
      headerCells.push(...added);
      lines[headerIdx] = `| ${headerCells.join(" | ")} |`;
      const sepIdx = headerIdx + 1;
      if (sepIdx < lines.length && isSeparator(lines[sepIdx])) {
        lines[sepIdx] = `| ${headerCells.map(() => "---").join(" | ")} |`;
      }
      for (let i = sepIdx + 1; i < lines.length; i++) {
        if (!/^\s*\|/.test(lines[i])) continue;
        const cells = lines[i]
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim());
        if (!cells.length) continue;
        while (cells.length < headerCells.length) cells.push("");
        lines[i] = `| ${cells.join(" | ")} |`;
      }
    }
  }

  let out = lines.join("\n");
  const order = lines[headerIdx]
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim().toLowerCase());
  for (const row of rows)
    out = upsert(out, row.row_key, `| ${order.map((c) => cellFor(c, row)).join(" | ")} |`);
  return out;
}
