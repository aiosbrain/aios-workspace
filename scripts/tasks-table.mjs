// Pure helpers for parsing and merging the markdown task/decision tables that the `aios`
// CLI syncs to the Team Brain. Kept dependency-free and side-effect-free so they can be
// unit-tested directly (see test/tasks-table.test.mjs) without invoking the CLI.

export function parseTableRows(body) {
  const rows = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = [];
    let cell = "";
    let endedWithDelimiter = false;
    for (let i = 1; i < t.length; i++) {
      if (t[i] === "\\" && t[i + 1] === "|") {
        cell += "|";
        i++;
        endedWithDelimiter = false;
      } else if (t[i] === "|") {
        cells.push(cell.trim());
        cell = "";
        endedWithDelimiter = i === t.length - 1;
      } else {
        cell += t[i];
        endedWithDelimiter = false;
      }
    }
    if (!endedWithDelimiter) cells.push(cell.trim());
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
        due: idx("due") >= 0 ? cells[idx("due")] || null : null,
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
