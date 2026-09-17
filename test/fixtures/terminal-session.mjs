import { createPresenter } from "../../scripts/ui.mjs";
const ui = await createPresenter();
if (!ui) throw new Error("Rich renderer was not loaded");
const scenario = process.argv[2];
if (scenario === "progress") {
  await ui.run(
    { label: "Fetching synthetic items" },
    () => new Promise((resolve) => setTimeout(resolve, 150))
  );
  await ui.run(
    { label: "Pushing synthetic items", completed: 1, total: 2 },
    () => new Promise((resolve) => setTimeout(resolve, 150))
  );
  ui.message("Completed synthetic sync", "success");
} else {
  const { clack } = await import("../../scripts/onboard-ui.mjs");
  clack.intro("AIOS setup");
  let answer;
  if (scenario === "secret") answer = await clack.password({ message: "Test secret" });
  else if (scenario.startsWith("confirm"))
    answer = await clack.confirm({ message: "Save origin?", initialValue: false });
  else if (scenario === "multi")
    answer = await clack.multiselect({
      message: "Tools",
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ],
      initialValues: ["b"],
    });
  else answer = await clack.text({ message: "Name" });
  if (clack.isCancel(answer)) {
    clack.cancel();
    process.exitCode = 1;
  } else
    clack.outro(
      scenario === "secret"
        ? `Stored ${answer.trim().length} characters`
        : `Answer ${JSON.stringify(answer)}`
    );
}
console.log(`RAW_MODE=${process.stdin.isRaw === true}`);
