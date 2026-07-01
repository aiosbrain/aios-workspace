import { useEffect, useState } from "react";
import { useConnection } from "../../state/cockpit";
import { cn } from "../../lib/cn";
import {
  WIZ_OVERLAY,
  WIZ,
  WIZ_HEAD,
  WIZ_X,
  WIZ_NOTE,
  WIZ_VALIDATING,
  WIZ_ERROR,
  WIZ_TEXT,
  WIZ_GO,
  WIZ_SECONDARY,
  WIZ_DONE_ACTIONS,
} from "../integrations/wizard";
import type { SkillConsent, SkillScanResponse } from "../../types/protocol";

const RISK_LABEL: Record<string, string> = {
  low: "low risk",
  elevated: "review",
  high: "high risk",
};

const RISK_BADGE_BASE =
  "rounded-md px-[9px] py-0.5 font-mono text-[11px] font-semibold uppercase tracking-[0.04em] border";
const RISK_TONE: Record<string, string> = {
  low: "text-emerald border-emerald/40 bg-emerald/10",
  elevated: "text-amber border-amber/40 bg-amber/10",
  high: "text-destructive border-destructive/45 bg-destructive/10",
};
const FINDING_BASE =
  "grid grid-cols-[minmax(120px,auto)_auto_1fr] items-baseline gap-2 border-l-2 px-1 py-[3px] text-xs";
const FINDING_TONE: Record<string, string> = {
  high: "border-l-destructive",
  info: "border-l-[var(--text-dim)]",
  ok: "border-l-emerald text-muted-foreground",
};

export interface SkillUnderReview {
  id: string;
  name: string;
  trust: string;
  source?: string | null;
}

/**
 * Review & install gate for non-official skills. Runs the advisory scan, requires an
 * explicit "I reviewed" checkbox, and (community high-risk only) a typed confirmation of
 * the skill id before install is allowed.
 */
export function SkillReviewModal({
  skill,
  acting,
  rowErr,
  onClose,
  onInstall,
}: {
  skill: SkillUnderReview;
  acting: boolean;
  rowErr?: string | null;
  onClose: () => void;
  onInstall: (consent: SkillConsent) => void;
}) {
  const { api } = useConnection();
  const [scan, setScan] = useState<SkillScanResponse | null>(null);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [typed, setTyped] = useState("");
  const isMarketplace = skill.trust === "marketplace";

  useEffect(() => {
    setScan(null);
    setScanErr(null);
    api
      .get<SkillScanResponse>(`/api/skills/${skill.id}/scan`)
      .then((d) => setScan(d))
      .catch((e: Error) => setScanErr(e.message));
  }, [api, skill.id]);

  const needsTyped = scan?.requiresTypedConfirm; // server: community high-risk only
  const canInstall = accepted && (!needsTyped || typed === skill.id) && !acting;
  const consent: SkillConsent = { accepted: true, ...(needsTyped ? { typed } : {}) };

  return (
    <div className={WIZ_OVERLAY} onClick={onClose}>
      <div className={cn(WIZ, "w-[min(640px,100%)]")} onClick={(e) => e.stopPropagation()}>
        <div className={WIZ_HEAD}>
          <h3>Review &amp; install — {skill.name}</h3>
          <button className={WIZ_X} onClick={onClose}>
            ✕
          </button>
        </div>

        {skill.source && (
          <a
            className="mb-1 inline-block font-mono text-[11px] text-[color:var(--link)] underline-offset-2 hover:underline"
            href={skill.source}
            target="_blank"
            rel="noreferrer"
          >
            View source on GitHub ↗
          </a>
        )}

        {scanErr && (
          <div className={WIZ_ERROR}>
            {isMarketplace ? "fetch / verify" : "scan"} failed: {scanErr}
          </div>
        )}
        {!scan && !scanErr && (
          <div className={WIZ_VALIDATING}>
            {isMarketplace ? "Fetching + verifying skill…" : "Scanning skill…"}
          </div>
        )}

        {scan && (
          <>
            <div className="flex items-center gap-2.5">
              <span className={cn(RISK_BADGE_BASE, RISK_TONE[scan.riskClass])}>
                {RISK_LABEL[scan.riskClass] || scan.riskClass}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {scan.counts.high} high-severity of {scan.counts.total} findings ·{" "}
                {scan.counts.code_files} code file{scan.counts.code_files === 1 ? "" : "s"}
              </span>
            </div>
            {isMarketplace ? (
              <p className={WIZ_NOTE}>
                This skill is <strong>marketplace · official</strong> (Anthropic's
                <code>claude-plugins-official</code> directory). It was fetched at a pinned commit
                and byte-verified against the catalog. The scan below is <strong>advisory</strong> —
                review it, then install.
              </p>
            ) : (
              <p className={WIZ_NOTE}>
                This skill is <strong>community · unverified</strong> with no first-party
                provenance. The scan below is <strong>advisory</strong> — it can miss obfuscated
                behavior. Install only if you trust the source.
              </p>
            )}

            <div className="flex max-h-[240px] flex-col gap-1 overflow-y-auto rounded-[8px] border border-border-visible p-2">
              {scan.findings.length === 0 ? (
                <p className={cn(FINDING_BASE, FINDING_TONE.ok)}>
                  No findings — instructions only, no code.
                </p>
              ) : (
                scan.findings.map((f, i) => (
                  <div key={i} className={cn(FINDING_BASE, FINDING_TONE[f.severity])}>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {f.file}:{f.line}
                    </span>
                    <span className="font-mono text-[11px] text-primary">{f.rule}</span>
                    <code className="truncate font-mono text-[11px] text-foreground">
                      {f.snippet}
                    </code>
                  </div>
                ))
              )}
            </div>

            <label className="flex cursor-pointer items-start gap-2 text-[13px]">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              <span>
                {isMarketplace
                  ? "I reviewed the findings and want to install this marketplace skill."
                  : "I reviewed the findings and accept the risk of installing this unverified skill."}
              </span>
            </label>
            {needsTyped && (
              <div>
                <p className={WIZ_NOTE}>
                  ⚠ This skill scanned <strong>HIGH risk</strong>. Type
                  <code className="font-mono text-xs text-destructive">{skill.id}</code> to confirm.
                </p>
                <input
                  className={WIZ_TEXT}
                  placeholder={skill.id}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                />
              </div>
            )}

            {rowErr && <div className={WIZ_ERROR}>{rowErr}</div>}
            <div className={WIZ_DONE_ACTIONS}>
              <button className={WIZ_GO} disabled={!canInstall} onClick={() => onInstall(consent)}>
                {acting ? "Installing…" : isMarketplace ? "Install" : "Install anyway"}
              </button>
              <button className={WIZ_SECONDARY} onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
