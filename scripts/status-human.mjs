import { createPresenter } from "./ui.mjs";
import { c } from "./cli-common.mjs";
import { HELD_GLYPH } from "./sync-plan.mjs";

export async function renderHumanStatus(repo, cfg, plan, printLoopCriticalWarnings) {
  const presenter = await createPresenter();
  if (presenter) {
    printLoopCriticalWarnings(repo, plan, cfg);
    presenter.status({
      project: cfg.project,
      destination: cfg.brain_url || "Offline / standalone",
      fresh: plan.push.filter((item) => item.isNew),
      modified: plan.push.filter((item) => !item.isNew),
      held: plan.blocked,
      clean: plan.clean.length,
    });
    await import("./pm.mjs").then(({ printProjectionHealth }) =>
      printProjectionHealth(cfg, { optional: true })
    );
    return;
  }
  const mode = cfg.brain_url ? cfg.brain_url : c.dim("<offline/standalone>");
  console.log(c.blue(`aios status — project '${cfg.project}' → ${mode}`));
  console.log("");

  printLoopCriticalWarnings(repo, plan, cfg);

  const newItems = plan.push.filter((i) => i.isNew);
  const modified = plan.push.filter((i) => !i.isNew);

  const section = (label, items, fmt) => {
    if (!items.length) return;
    console.log(label);
    for (const i of items) console.log(`  ${fmt(i)}`);
    console.log("");
  };
  section(
    c.green(`new (${newItems.length}):`),
    newItems,
    (i) => `${i.rel} ${c.dim(`[${i.kind}, ${i.tier}]`)}`
  );
  section(
    c.yellow(`modified (${modified.length}):`),
    modified,
    (i) => `${i.rel} ${c.dim(`[${i.kind}, ${i.tier}]`)}`
  );
  section(
    c.blue(`${HELD_GLYPH} held (${plan.blocked.length}):`),
    plan.blocked,
    (i) => `${i.rel} — ${i.reason}`
  );
  console.log(c.dim(`clean (already synced): ${plan.clean.length}`));

  if (plan.blocked.length) {
    console.log("");
    console.log(
      c.dim(
        `the ${plan.blocked.length} held file(s) stayed on this machine. To sync one: ` +
          "add `access: team` (or `external`) frontmatter — promotion is deliberate."
      )
    );
  }
  await import("./pm.mjs").then(({ printProjectionHealth }) =>
    printProjectionHealth(cfg, { optional: true })
  );
}
