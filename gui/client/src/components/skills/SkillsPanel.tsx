import { useCallback, useEffect, useMemo, useState } from "react";
import { Input } from "@aios-alpha/ui";
import { useConnection } from "../../state/cockpit";
import { Skeleton } from "../ui/skeleton";
import { SkillCard } from "./SkillCard";
import { SkillReviewModal, type SkillUnderReview } from "./SkillReviewModal";
import {
  INTEGRATIONS_ROOT,
  INT_HEAD,
  INT_HEAD_H2,
  INT_SUB,
  INT_PROGRESS,
  INT_SECTION,
  INT_SECTION_MUTED,
  META_ERROR,
} from "../integrations/intCard";
import type { SkillConsent, SkillEntry, SkillsResponse } from "../../types/protocol";

const GRID = "grid gap-4 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]";

function matches(s: { name: string; description: string }, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    s.name.toLowerCase().includes(needle) || (s.description || "").toLowerCase().includes(needle)
  );
}

export function SkillsPanel() {
  const { api } = useConnection();
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null); // id currently installing/removing
  const [rowErr, setRowErr] = useState<Record<string, string | null>>({}); // id → error message
  const [review, setReview] = useState<SkillUnderReview | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    setError(null);
    api
      .get<SkillsResponse>("/api/skills")
      .then((d) => setData(d))
      .catch((e: Error) => setError(e.message));
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);

  // Install/uninstall. `consent` is sent for community installs (official ignores it).
  const act = async (id: string, action: "install" | "uninstall", consent?: SkillConsent) => {
    setActing(id);
    setRowErr((p) => ({ ...p, [id]: null }));
    try {
      await api.post(`/api/skills/${id}/${action}`, consent ? { consent } : {});
      setReview(null);
      load();
      return true;
    } catch (e) {
      setRowErr((p) => ({ ...p, [id]: (e as Error).message || "failed" }));
      return false;
    } finally {
      setActing(null);
    }
  };

  // Two clear groups — Official + Marketplace — plus Community only when present.
  // Per-category subheadings are intentionally dropped.
  const { official, marketplace, community, installedCount } = useMemo(
    () => ({
      official: (data?.skills || []).filter((s) => matches(s, query)),
      marketplace: (data?.marketplace || []).filter((s) => matches(s, query)),
      community: (data?.community || []).filter((s) => matches(s, query)),
      installedCount: (data?.skills || []).filter((s) => s.installed).length,
    }),
    [data, query]
  );

  const cardProps = (s: SkillEntry) => ({
    skill: s,
    acting: acting === s.id,
    rowErr: rowErr[s.id],
    onInstall: () => act(s.id, "install"),
    onUninstall: () => act(s.id, "uninstall"),
    onReview: setReview,
  });

  if (error)
    return (
      <div className={INTEGRATIONS_ROOT}>
        <div className={META_ERROR}>error: {error}</div>
      </div>
    );
  if (!data)
    return (
      <div className={INTEGRATIONS_ROOT}>
        <div className={INT_HEAD}>
          <div>
            <h2 className={INT_HEAD_H2}>Skills</h2>
            <p className={INT_SUB}>Loading the skill library…</p>
          </div>
        </div>
        <div className={GRID}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      </div>
    );

  return (
    <div className={INTEGRATIONS_ROOT}>
      <div className={INT_HEAD}>
        <div>
          <h2 className={INT_HEAD_H2}>Skills</h2>
          <p className={INT_SUB}>
            One-click install into <code>.claude/skills/</code>. Provenance and your own review are
            the real safeguard — the scan is advisory.
          </p>
        </div>
        <div className={INT_PROGRESS}>
          {installedCount} of {data.skills.length} installed
        </div>
      </div>

      <Input
        type="search"
        placeholder="Filter skills by name or description…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-4 max-w-md"
      />

      {official.length > 0 && (
        <>
          <h3 className={INT_SECTION}>Official</h3>
          <p className={INT_SUB}>
            Vendored from <code>anthropics/skills</code> and hash-locked.
          </p>
          <div className={GRID}>
            {official.map((s) => (
              <SkillCard key={s.id} {...cardProps(s)} />
            ))}
          </div>
        </>
      )}

      {marketplace.length > 0 && (
        <>
          <h3 className={INT_SECTION}>Marketplace</h3>
          <p className={INT_SUB}>
            First-party (Anthropic) plugins, fetched on install at a pinned commit and byte-verified
            against the catalog before anything lands in <code>.claude/skills/</code>. Installing
            needs network access.
          </p>
          <div className={GRID}>
            {marketplace.map((s) => (
              <SkillCard key={s.id} {...cardProps(s)} />
            ))}
          </div>
        </>
      )}

      {community.length > 0 && (
        <>
          <h3 className={INT_SECTION_MUTED}>Community</h3>
          <p className={INT_SUB}>
            ⚠ Unverified, no first-party provenance. Installing runs its bundled instructions/code —
            review the source and scan, then confirm.
          </p>
          <div className={GRID}>
            {community.map((s) => (
              <SkillCard key={s.id} {...cardProps(s)} />
            ))}
          </div>
        </>
      )}

      {review && (
        <SkillReviewModal
          skill={review}
          acting={acting === review.id}
          rowErr={rowErr[review.id]}
          onClose={() => setReview(null)}
          onInstall={(consent) => act(review.id, "install", consent)}
        />
      )}
    </div>
  );
}
