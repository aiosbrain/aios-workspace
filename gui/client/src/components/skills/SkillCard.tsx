import type { SkillEntry } from "../../types/protocol";
import type { SkillUnderReview } from "./SkillReviewModal";
import { skillSourceUrl } from "./skillSource";
import { INT_CONNECT } from "../integrations/intCard";
import { WIZ_SECONDARY } from "../integrations/wizard";

const TRUST_LABEL: Record<string, string> = {
  official: "Official",
  marketplace: "Marketplace",
  community: "Community",
};

// Trust pills lean on the token palette: marketplace = cyan, community = amber,
// official stays neutral (its trust is structural, not a warning).
const TRUST_TONE: Record<string, string> = {
  official: "border-border text-muted-foreground",
  marketplace: "border-cyan/40 text-cyan",
  community: "border-amber/40 text-amber",
};

const PILL =
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide";

/**
 * One skill card — compact and uniform-height. Official skills install in one click;
 * marketplace + community skills route through the Review modal (advisory scan + consent)
 * before install. The description is clamped; the full text is on the title attr + modal.
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
  const runsCode = skill.capabilities?.bundles_code;
  const codeCount = skill.capabilities?.code_files?.length;
  const source = skillSourceUrl(skill);

  return (
    <div
      className={`flex h-full flex-col gap-3 rounded-xl border bg-card p-4 shadow-card transition-colors ${
        skill.installed ? "border-accent/40" : "border-border"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium leading-snug text-card-foreground">{skill.name}</span>
        <span
          className={`flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-wide ${
            skill.installed ? "text-accent" : "text-muted-foreground"
          }`}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              skill.installed ? "bg-lime" : "bg-muted-foreground/50"
            }`}
          />
          {skill.installed ? "Installed" : "Available"}
        </span>
      </div>

      <p
        className="line-clamp-3 min-h-[3.6em] text-[12.5px] leading-[1.45] text-muted-foreground"
        title={skill.description}
      >
        {skill.description}
      </p>

      <div className="flex flex-wrap gap-1.5">
        <span
          className={`${PILL} ${TRUST_TONE[skill.trust] || "border-border text-muted-foreground"}`}
        >
          {TRUST_LABEL[skill.trust] || skill.trust}
        </span>
        {runsCode ? (
          <span
            className={`${PILL} border-primary/40 text-primary`}
            title={(skill.capabilities?.code_files || []).join(", ")}
          >
            Runs code{codeCount ? ` · ${codeCount}` : ""}
          </span>
        ) : (
          !reviewed && (
            <span className={`${PILL} border-border text-muted-foreground`}>Text only</span>
          )
        )}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        {source ? (
          <a
            className="font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            href={source}
            target="_blank"
            rel="noreferrer"
            title="Inspect the source on GitHub before installing"
          >
            View source ↗
          </a>
        ) : (
          <span className="font-mono text-[11px] text-muted-foreground/60">No public source</span>
        )}
        {skill.installed ? (
          <button className={WIZ_SECONDARY} disabled={acting} onClick={onUninstall}>
            {acting ? "…" : "Remove"}
          </button>
        ) : reviewed ? (
          <button
            className={INT_CONNECT}
            disabled={acting}
            onClick={() => onReview({ id: skill.id, name: skill.name, trust: skill.trust, source })}
          >
            Review &amp; install
          </button>
        ) : (
          <button className={INT_CONNECT} disabled={acting} onClick={onInstall}>
            {acting ? "Installing…" : "Install"}
          </button>
        )}
      </div>
      {rowErr && <p className="text-xs text-[color:var(--red)]">{rowErr}</p>}
    </div>
  );
}
