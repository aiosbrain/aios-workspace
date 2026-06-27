import type { SkillEntry } from "../../types/protocol";
import type { SkillUnderReview } from "./SkillReviewModal";

const TRUST_BADGE: Record<string, string> = {
  official: "official · Apache-2.0",
  marketplace: "marketplace · official",
  community: "community · unverified",
};

/**
 * One skill card. Official skills install in one click; marketplace + community skills
 * route through the Review modal (advisory scan + consent) before install.
 */
export function SkillCard({
  skill,
  acting,
  rowErr,
  onInstall,
  onUninstall,
  onReview,
}: {
  skill: SkillEntry;
  acting: boolean;
  rowErr?: string | null;
  onInstall: () => void;
  onUninstall: () => void;
  onReview: (skill: SkillUnderReview) => void;
}) {
  const isCommunity = skill.trust === "community";
  const isMarketplace = skill.trust === "marketplace";
  const reviewed = isCommunity || isMarketplace; // both go through the Review modal

  return (
    <div className={`int-card${skill.installed ? " wired" : ""}`}>
      <div className="int-card-top">
        <span className="int-name">{skill.name}</span>
        <span className={`int-status ${skill.installed ? "wired" : ""}`}>
          {skill.installed ? "● installed" : "○ available"}
        </span>
      </div>
      <p className="int-summary">{skill.description}</p>
      <div className="skill-caps">
        {skill.capabilities?.bundles_code ? (
          <span className="cap code" title={(skill.capabilities.code_files || []).join(", ")}>
            ⚙ runs code
            {skill.capabilities.code_files
              ? ` (${(skill.capabilities.code_files || []).length})`
              : ""}
          </span>
        ) : (
          !reviewed && <span className="cap">text-only</span>
        )}
        <span className={`cap trust ${skill.trust}`}>{TRUST_BADGE[skill.trust] || skill.trust}</span>
      </div>
      <div className="int-card-foot">
        <span className="int-transport">{skill.category}</span>
        {skill.installed ? (
          <button className="wiz-secondary" disabled={acting} onClick={onUninstall}>
            {acting ? "…" : "Remove"}
          </button>
        ) : reviewed ? (
          <button
            className="int-connect"
            disabled={acting}
            onClick={() => onReview({ id: skill.id, name: skill.name, trust: skill.trust })}
          >
            Review &amp; install
          </button>
        ) : (
          <button className="int-connect" disabled={acting} onClick={onInstall}>
            {acting ? "Installing…" : "Install"}
          </button>
        )}
      </div>
      {rowErr && <p className="skill-err">{rowErr}</p>}
    </div>
  );
}
