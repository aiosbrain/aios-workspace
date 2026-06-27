import { useEffect, useState } from "react";
import { useConnection } from "../../state/cockpit";
import type { SkillConsent, SkillScanResponse } from "../../types/protocol";

const RISK_LABEL: Record<string, string> = {
  low: "low risk",
  elevated: "review",
  high: "high risk",
};

export interface SkillUnderReview {
  id: string;
  name: string;
  trust: string;
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
    <div className="wiz-overlay" onClick={onClose}>
      <div className="wiz skill-review" onClick={(e) => e.stopPropagation()}>
        <div className="wiz-head">
          <h3>Review &amp; install — {skill.name}</h3>
          <button className="wiz-x" onClick={onClose}>
            ✕
          </button>
        </div>

        {scanErr && (
          <div className="wiz-error">
            {isMarketplace ? "fetch / verify" : "scan"} failed: {scanErr}
          </div>
        )}
        {!scan && !scanErr && (
          <div className="wiz-validating">
            {isMarketplace ? "Fetching + verifying skill…" : "Scanning skill…"}
          </div>
        )}

        {scan && (
          <>
            <div className="skill-review-head">
              <span className={`risk-badge ${scan.riskClass}`}>
                {RISK_LABEL[scan.riskClass] || scan.riskClass}
              </span>
              <span className="skill-review-meta">
                {scan.counts.high} high-severity of {scan.counts.total} findings ·{" "}
                {scan.counts.code_files} code file{scan.counts.code_files === 1 ? "" : "s"}
              </span>
            </div>
            {isMarketplace ? (
              <p className="wiz-note">
                This skill is <strong>marketplace · official</strong> (Anthropic's
                <code>claude-plugins-official</code> directory). It was fetched at a pinned commit
                and byte-verified against the catalog. The scan below is <strong>advisory</strong> —
                review it, then install.
              </p>
            ) : (
              <p className="wiz-note">
                This skill is <strong>community · unverified</strong> with no first-party
                provenance. The scan below is <strong>advisory</strong> — it can miss obfuscated
                behavior. Install only if you trust the source.
              </p>
            )}

            <div className="skill-findings">
              {scan.findings.length === 0 ? (
                <p className="skill-finding ok">No findings — instructions only, no code.</p>
              ) : (
                scan.findings.map((f, i) => (
                  <div key={i} className={`skill-finding ${f.severity}`}>
                    <span className="skill-finding-loc">
                      {f.file}:{f.line}
                    </span>
                    <span className="skill-finding-rule">{f.rule}</span>
                    <code className="skill-finding-snip">{f.snippet}</code>
                  </div>
                ))
              )}
            </div>

            <label className="skill-consent">
              <input
                type="checkbox"
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
              <div className="skill-typed">
                <p className="wiz-note skill-typed-warn">
                  ⚠ This skill scanned <strong>HIGH risk</strong>. Type
                  <code>{skill.id}</code> to confirm.
                </p>
                <input
                  className="wiz-text"
                  placeholder={skill.id}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                />
              </div>
            )}

            {rowErr && <div className="wiz-error">{rowErr}</div>}
            <div className="wiz-done-actions">
              <button className="wiz-go" disabled={!canInstall} onClick={() => onInstall(consent)}>
                {acting ? "Installing…" : isMarketplace ? "Install" : "Install anyway"}
              </button>
              <button className="wiz-secondary" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
