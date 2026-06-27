import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Input } from "@aios-alpha/ui";
import { useConnection } from "../../state/cockpit";
import { Skeleton } from "../ui/skeleton";
import { SkillCard } from "./SkillCard";
import { SkillReviewModal, type SkillUnderReview } from "./SkillReviewModal";
import type { SkillConsent, SkillEntry, SkillsResponse } from "../../types/protocol";

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

  // group official skills by category (filtered by the search query)
  const { groups, marketplace, community, referenced, installedCount } = useMemo(() => {
    const g: Record<string, SkillEntry[]> = {};
    const official = (data?.skills || []).filter((s) => matches(s, query));
    for (const s of official) (g[s.category] ||= []).push(s);
    return {
      groups: g,
      marketplace: (data?.marketplace || []).filter((s) => matches(s, query)),
      community: (data?.community || []).filter((s) => matches(s, query)),
      referenced: (data?.referenced || []).filter((s) => matches(s, query)),
      installedCount: (data?.skills || []).filter((s) => s.installed).length,
    };
  }, [data, query]);

  if (error)
    return (
      <div className="integrations">
        <div className="msg meta error">error: {error}</div>
      </div>
    );
  if (!data)
    return (
      <div className="integrations">
        <div className="int-head">
          <div>
            <h2>Skills</h2>
            <p className="int-sub">Loading the skill library…</p>
          </div>
        </div>
        <div className="int-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      </div>
    );

  return (
    <div className="integrations">
      <div className="int-head">
        <div>
          <h2>Skills</h2>
          <p className="int-sub">
            Official Anthropic skills are vendored from <code>anthropics/skills</code> and
            hash-locked — one-click install into <code>.claude/skills/</code>. Marketplace skills
            come from Anthropic's official plugin directory (<code>claude-plugins-official</code>):
            first-party vetted, but fetched-on-install at a pinned commit and byte-verified against
            the catalog. Community skills carry no first-party provenance and require your review.
            Scanning is <strong>advisory</strong> — provenance and your own review are the real
            safeguard.
          </p>
        </div>
        <div className="int-progress">
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

      {Object.keys(groups)
        .sort()
        .map((cat) => (
          <Fragment key={cat}>
            <h3 className="int-section">{cat}</h3>
            <div className="int-grid">
              {groups[cat].map((s) => (
                <SkillCard
                  key={s.id}
                  skill={s}
                  acting={acting === s.id}
                  rowErr={rowErr[s.id]}
                  onInstall={() => act(s.id, "install")}
                  onUninstall={() => act(s.id, "uninstall")}
                  onReview={setReview}
                />
              ))}
            </div>
          </Fragment>
        ))}

      {marketplace.length > 0 && (
        <>
          <h3 className="int-section">Marketplace — Anthropic official plugins</h3>
          <div className="int-grid">
            {marketplace.map((s) => (
              <SkillCard
                key={s.id}
                skill={s}
                acting={acting === s.id}
                rowErr={rowErr[s.id]}
                onInstall={() => act(s.id, "install")}
                onUninstall={() => act(s.id, "uninstall")}
                onReview={setReview}
              />
            ))}
          </div>
          <p className="int-foot">
            ↪ Marketplace skills are first-party (Anthropic) but <strong>fetched on install</strong>{" "}
            from <code>claude-plugins-official</code> at a pinned commit. The fetched bytes are
            byte-verified against the catalog before anything lands in <code>.claude/skills/</code>{" "}
            — a tampered or drifted upstream is refused. Installing needs network access.
          </p>
        </>
      )}

      {community.length > 0 && (
        <>
          <h3 className="int-section int-section-muted">
            Community — unverified (scan + consent required)
          </h3>
          <div className="int-grid">
            {community.map((s) => (
              <SkillCard
                key={s.id}
                skill={s}
                acting={acting === s.id}
                rowErr={rowErr[s.id]}
                onInstall={() => act(s.id, "install")}
                onUninstall={() => act(s.id, "uninstall")}
                onReview={setReview}
              />
            ))}
          </div>
          <p className="int-foot">
            ⚠ Community skills are not vendored or first-party. Installing one runs its bundled
            instructions/code in your workspace — treat it like installing software from a stranger.
          </p>
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

      {referenced.length > 0 && (
        <>
          <h3 className="int-section int-section-muted">Documents — available in Claude</h3>
          <div className="int-grid">
            {referenced.map((s) => (
              <div key={s.id} className="int-card">
                <div className="int-card-top">
                  <span className="int-name">{s.name}</span>
                </div>
                <p className="int-summary">{s.description}</p>
                <div className="int-card-foot">
                  <span className="int-transport">official · hosted</span>
                  <a
                    className="int-connect"
                    href={data.referenced_docs_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Enable in Claude ↗
                  </a>
                </div>
              </div>
            ))}
          </div>
          <p className="int-foot">
            These document skills are Anthropic-hosted (proprietary license) — used inside Claude,
            not copied here.
          </p>
        </>
      )}
    </div>
  );
}
