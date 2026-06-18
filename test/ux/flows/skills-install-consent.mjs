// test/ux/flows/skills-install-consent.mjs — Flow B.
//
// Skills "install with consent": open Skills → community-example → Review & install → see the
// advisory scan findings (with file:line + a risk badge) → consent → install.
//
// community-example is ELEVATED (not high), so `requiresTypedConfirm` is FALSE: consent is a
// plain accept, NOT a typed confirm. This flow asserts that a typed-confirm field is required
// ONLY when requiresTypedConfirm is true (here it is not). The HIGH → typed-confirm path is
// ALREADY covered deterministically by test/skill-install.test.mjs — we reference it, never
// duplicate it.
//
// Judge-independent post-assert: after the flow, `.claude/skills/community-example/` exists
// (the install actually landed).

import { existsSync } from "node:fs";
import path from "node:path";
import { scanSkillById } from "../../../gui/server/skill-library.mjs";

export const id = "skills-install-consent";

export const SKILL_ID = "community-example";

export const intent =
  `Goal: install a COMMUNITY skill through its consent gate.\n` +
  `Steps:\n` +
  `1. Open the Skills tab. Screenshot the skills grid.\n` +
  `2. Find the community skill "${SKILL_ID}" and click "Review & install".\n` +
  `3. Confirm the review modal shows the advisory SCAN: findings with file:line and a RISK ` +
  `BADGE. Screenshot the modal.\n` +
  `4. Confirm that install is BLOCKED until consent is given (the consent control / checkbox). ` +
  `Because this skill is "elevated" (not high-risk), a plain consent is enough — you should ` +
  `NOT be asked to type the skill id. Give consent.\n` +
  `5. Install it and confirm the card reflects the installed state. Screenshot the result.\n` +
  `6. Run \`errors\` to capture console errors, then stop and summarize.`;

// Rubric: findings shown · consent required pre-install · install reflected · no console errors.
// Threshold 1.0 on the consent gate being load-bearing.
export const rubric = {
  flow: id,
  threshold: 1.0,
  criteria: [
    { id: "scan_findings_shown", ask: "Does the Review & install modal show the advisory scan: at least one finding with a file:line and a risk badge?" },
    { id: "consent_required_pre_install", ask: "Is install blocked until an explicit consent control is satisfied (no install without consent)?" },
    { id: "no_typed_confirm_for_elevated", ask: "Since this skill is elevated (not high-risk), is plain consent sufficient — i.e. the user was NOT forced to type the skill id?" },
    { id: "install_reflected", ask: "After consent + install, does the UI clearly reflect that the skill is now installed?" },
    { id: "no_console_errors", ask: "Did the flow complete with no console errors? (evidence: the captured errors output)" },
  ],
};

/**
 * Judge-independent post-assert: the install actually landed, AND the consent-gate contract
 * matches the design (elevated → no typed confirm). We assert the structural contract from
 * skill-library (the source of truth) so the harness catches a regression in the gate even if
 * the judge is lenient.
 */
export function postAssert({ repo }) {
  const checks = [];

  const dir = path.join(repo, ".claude", "skills", SKILL_ID);
  const installed = existsSync(dir) && existsSync(path.join(dir, "SKILL.md"));
  checks.push({ name: "skill_installed", ok: installed, detail: installed ? `${SKILL_ID} present in .claude/skills` : `${SKILL_ID} missing from .claude/skills` });

  // Contract check: community-example must be elevated with NO typed-confirm requirement.
  // (If it were high, the typed-confirm path applies — already covered by skill-install.test.mjs.)
  let scan = null;
  try { scan = scanSkillById(SKILL_ID); } catch { /* leave null */ }
  const contractOk = !!scan && scan.riskClass === "elevated" && scan.requiresTypedConfirm === false;
  checks.push({
    name: "consent_contract",
    ok: contractOk,
    detail: scan
      ? `riskClass=${scan.riskClass}, requiresTypedConfirm=${scan.requiresTypedConfirm} (expected elevated / false)`
      : "could not scan community-example",
  });

  return { ok: checks.every((c) => c.ok), checks };
}

// Whether a typed confirm is expected for this skill (drives the flow assertion).
export function requiresTypedConfirm() {
  try { return scanSkillById(SKILL_ID).requiresTypedConfirm === true; }
  catch { return false; }
}
