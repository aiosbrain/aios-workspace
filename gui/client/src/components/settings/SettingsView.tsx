import { useEffect, useState } from "react";
import { User, Cpu, Blocks, Zap, SunMoon, Lock } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useConnection, useRuntime, useSession } from "../../state/cockpit";
import { ThemeToggle } from "../layout/ThemeToggle";
import { AgentSettings } from "./AgentSettings";
import { IntegrationsPanel } from "../integrations/IntegrationsPanel";
import { SkillsPanel } from "../skills/SkillsPanel";
import { cn } from "../../lib/cn";

type Section = "account" | "agent" | "integrations" | "skills" | "appearance" | "privacy";

export const SET_SECTION = "mb-7";
export const SET_SECTION_TITLE = "mb-2 font-display text-base font-normal";
export const SET_SECTION_HINT =
  "mt-1.5 mb-3 text-[length:var(--aios-text-small)] leading-[1.55] text-muted-foreground";
const KV_ROW =
  "flex justify-between gap-4 border-b border-border-visible px-3.5 py-[11px] last:border-b-0";
const KV_DT = "text-[13px] text-muted-foreground";
const KV_DD = "m-0 max-w-[60%] truncate text-[13px]";
const KV_DD_MONO = cn(KV_DD, "font-mono text-xs");

const SECTIONS: { key: Section; label: string; icon: LucideIcon }[] = [
  { key: "account", label: "Account", icon: User },
  { key: "agent", label: "Agent", icon: Cpu },
  { key: "integrations", label: "Integrations", icon: Blocks },
  { key: "skills", label: "Skills", icon: Zap },
  { key: "appearance", label: "Appearance", icon: SunMoon },
  { key: "privacy", label: "Privacy", icon: Lock },
];

interface Me {
  name?: string;
  email?: string;
  role?: string;
  team?: string;
}

function AccountSection() {
  const { api, repo, role } = useConnection();
  const { runtime } = useRuntime();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    api
      .get<{ ok: boolean; me: Me | null }>("/api/me")
      .then((d) => setMe(d.me))
      .catch(() => {});
  }, [api]);

  const repoName = repo ? repo.split("/").filter(Boolean).pop() : "workspace";
  const displayName = me?.name || repoName || "Workspace";
  const initial = (displayName[0] || "A").toUpperCase();

  return (
    <section className={SET_SECTION}>
      <div className="mb-5 flex items-center gap-3.5">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-violet font-mono text-xl font-semibold text-primary-foreground">
          {initial}
        </span>
        <div>
          <div className="font-display text-lg">{displayName}</div>
          {me?.email && (
            <div className="text-[length:var(--aios-text-small)] text-muted-foreground">
              {me.email}
            </div>
          )}
          {(me?.role || role) && (
            <div className="text-[length:var(--aios-text-small)] text-muted-foreground">
              role · {me?.role || role}
            </div>
          )}
        </div>
      </div>
      <dl className="m-0 flex flex-col overflow-hidden rounded-lg border border-border-visible">
        <div className={KV_ROW}>
          <dt className={KV_DT}>Workspace</dt>
          <dd className={KV_DD} title={repo}>
            {repoName}
          </dd>
        </div>
        <div className={KV_ROW}>
          <dt className={KV_DT}>Path</dt>
          <dd className={KV_DD_MONO} title={repo}>
            {repo || "—"}
          </dd>
        </div>
        <div className={KV_ROW}>
          <dt className={KV_DT}>Runtime</dt>
          <dd className={KV_DD_MONO}>{runtime || "—"}</dd>
        </div>
        {me?.team && (
          <div className={KV_ROW}>
            <dt className={KV_DT}>Team</dt>
            <dd className={KV_DD}>{me.team}</dd>
          </div>
        )}
      </dl>
      {!me && (
        <p className={SET_SECTION_HINT}>
          Connect the team brain (<code>aios onboard</code>) to populate your profile.
        </p>
      )}
    </section>
  );
}

export function SettingsView() {
  const { setView, setInput } = useSession();
  const [section, setSection] = useState<Section>("account");

  const fillsOwnLayout = section === "integrations" || section === "skills";

  return (
    <div className="flex h-full min-h-0">
      <nav className="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-border-visible bg-card px-3 py-5">
        <div className="px-2.5 pb-3 font-display text-lg font-normal">Settings</div>
        {SECTIONS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={cn(
              "flex cursor-pointer items-center gap-2.5 rounded-md bg-transparent px-2.5 py-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
              section === key && "bg-[var(--accent-soft)] text-foreground"
            )}
            onClick={() => setSection(key)}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        {section === "integrations" && (
          <IntegrationsPanel
            onTryInChat={(prompt: string) => {
              setView("chat");
              setInput(prompt);
            }}
          />
        )}
        {section === "skills" && <SkillsPanel />}

        {!fillsOwnLayout && (
          <div className="max-w-[760px] px-8 py-7">
            {section === "account" && <AccountSection />}
            {section === "agent" && <AgentSettings />}
            {section === "appearance" && (
              <section className={SET_SECTION}>
                <h3 className={SET_SECTION_TITLE}>Theme</h3>
                <p className={SET_SECTION_HINT}>
                  Dark is the workspace's terminal-native default; light is opt-in. Your choice is
                  saved on this machine.
                </p>
                <ThemeToggle />
              </section>
            )}
            {section === "privacy" && (
              <section className={SET_SECTION}>
                <h3 className={SET_SECTION_TITLE}>Privacy</h3>
                <p className={SET_SECTION_HINT}>
                  🔒 Your connector keys are encrypted on this machine (dotenvx) and never sent to
                  the team brain. The cockpit binds to localhost only and is gated by a one-time
                  session token from <code>npm run gui</code>. Nothing leaves your machine until you
                  run <code>aios push</code>.
                </p>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
