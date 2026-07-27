import { c } from "./cli-common.mjs";

function counted(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function renderDaily(orientation) {
  const today = orientation.generatedAt.slice(0, 10);
  const marker =
    orientation.audience === "owner"
      ? "owner-private · local only"
      : `view: ${orientation.audience}`;
  const auditCommand =
    orientation.audience === "owner"
      ? "aios loop manifest --explain --daily"
      : `aios loop manifest --explain --daily --as ${orientation.audience}`;
  const printExcludedHint = () => {
    if (!orientation.counts.excluded) return;
    console.log("");
    console.log(
      c.dim(
        `  ${orientation.counts.excluded} excluded (default-deny) — run \`${auditCommand}\` to inspect`
      )
    );
  };
  const renderRan = () => {
    if (!orientation.ranByTag?.length) return;
    const hours = (minutes) => `${(minutes / 60).toFixed(1)}h`;
    const total = orientation.ranByTag.reduce((sum, tag) => sum + tag.durationMin, 0);
    console.log("");
    console.log(c.bold(`Ran (agent runtime · ${hours(total)})`));
    for (const tag of orientation.ranByTag) {
      console.log(`  • ${c.dim(String(tag.tag).padEnd(14))} ${hours(tag.durationMin)}`);
    }
  };

  console.log(
    c.blue("aios loop daily") +
      c.dim(
        `  window ${orientation.window.from.slice(0, 10)} → ${orientation.window.to.slice(0, 10)}`
      ) +
      c.dim(`     ${marker}`)
  );

  const asksTotal = (orientation.counts.attention ?? 0) + (orientation.counts.queuedAsks ?? 0);
  const transcriptReview =
    orientation.audience === "owner" ? orientation.transcriptReview : undefined;
  if (
    orientation.counts.changed === 0 &&
    orientation.counts.blocked === 0 &&
    orientation.counts.owedToday === 0 &&
    (orientation.counts.calendar ?? 0) === 0 &&
    (orientation.counts.commsNeedingReply ?? 0) === 0 &&
    asksTotal === 0 &&
    transcriptReview === undefined
  ) {
    console.log("");
    if (orientation.audience !== "owner") {
      const hidden = [];
      if (orientation.counts.withheld) hidden.push(`${orientation.counts.withheld} withheld`);
      if (orientation.counts.excluded) {
        hidden.push(`${orientation.counts.excluded} excluded (default-deny)`);
      }
      if (hidden.length) {
        console.log(
          c.dim(
            `0 ${orientation.audience}-visible items (${hidden.join("; ")}) — run \`${auditCommand}\` to audit`
          )
        );
      } else {
        console.log(
          c.green(`0 ${orientation.audience}-visible items. Nothing happened in this view. ✓`)
        );
      }
    } else {
      console.log(
        `${c.bold("Changed (0)")}   ${c.bold("Blocked (0)")}   ${c.bold("Owed today (0)")}`
      );
      console.log(
        c.green(
          orientation.counts.excluded
            ? "No classifiable daily items. ✓"
            : "Nothing carried over. You're clear. ✓"
        )
      );
    }
    renderRan();
    if (orientation.audience === "owner") printExcludedHint();
    return;
  }

  const truncate = (value, length) =>
    value.length > length ? `${value.slice(0, length - 1)}…` : value;
  const refLabel = (item) => (item.ref.row ? `${item.ref.path}#${item.ref.row}` : item.ref.path);
  const annotation = (item) => {
    if (item.stale != null) return c.dim(`  (stale ${item.stale}d)`);
    if (item.due) {
      const dueDay = String(item.due).slice(0, 10);
      return c.dim(`  (due ${dueDay === today ? "today" : item.due})`);
    }
    return "";
  };
  const section = (title, items, total, { expand = false } = {}) => {
    console.log("");
    console.log(c.bold(`${title} (${total})`));
    for (const item of items) {
      console.log(
        `  • ${c.dim(String(item.kind).padEnd(11))} ${truncate(item.summary, 60)}${annotation(item)}   ${c.dim(refLabel(item))}`
      );
    }
    if (total > items.length) {
      const hint = expand ? ` — run \`${auditCommand}\` to inspect` : "";
      console.log(c.dim(`  +${total - items.length} more${hint}`));
    }
  };

  if (orientation.counts.attention) {
    section("Attention", orientation.attention ?? [], orientation.counts.attention);
  }
  if (orientation.counts.queuedAsks) {
    section("Queued asks", orientation.queuedAsks ?? [], orientation.counts.queuedAsks);
  }
  if (asksTotal) {
    console.log(c.dim("  Resolve: `aios asks resolve <id>` · list: `aios asks`"));
  }
  if (transcriptReview !== undefined) {
    console.log("");
    console.log(
      c.bold(`Transcript review (${counted(transcriptReview.pendingStages, "pending stage")})`)
    );
    if (transcriptReview.pendingStages > 0) {
      console.log(
        `  ${counted(transcriptReview.decisions, "decision")} + ${counted(transcriptReview.tasks, "task")} pending review — aios transcripts list; approve with aios transcripts approve <file>`
      );
    }
    const diagnostics = [];
    if (transcriptReview.failedRubric > 0) {
      diagnostics.push(counted(transcriptReview.failedRubric, "rubric failure"));
    }
    if (transcriptReview.gradingErrors > 0) {
      diagnostics.push(counted(transcriptReview.gradingErrors, "grading error"));
    }
    if (transcriptReview.unreadableStages > 0) {
      diagnostics.push(counted(transcriptReview.unreadableStages, "unreadable stage"));
    }
    if (diagnostics.length > 0) {
      console.log(`  ${diagnostics.join(" + ")} — inspect with aios transcripts list`);
    }
  }
  section("Blocked", orientation.blocked, orientation.counts.blocked);
  section("Owed today", orientation.owedToday, orientation.counts.owedToday);
  section("Today's calendar", orientation.calendar ?? [], orientation.counts.calendar ?? 0);
  section(
    "Comms needing reply",
    orientation.commsNeedingReply ?? [],
    orientation.counts.commsNeedingReply ?? 0
  );
  section("Changed", orientation.changed, orientation.counts.changed, { expand: true });
  renderRan();
  printExcludedHint();
}
