import { useEffect, useState } from "react";
import { User, Cpu, Blocks, Zap, SunMoon, Lock } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useConnection, useRuntime, useSession } from "../../state/cockpit";
import { ThemeToggle } from "../layout/ThemeToggle";
import { AgentSettings } from "./AgentSettings";
import { IntegrationsPanel } from "../integrations/IntegrationsPanel";
import { SkillsPanel } from "../skills/SkillsPanel";

type Section = "account" | "agent" | "integrations" | "skills" | "appearance" | "privacy";

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
    api.get<{ ok: boolean; me: Me | null }>("/api/me").then((d) => setMe(d.me)).catch(() => {});
  }, [api]);

  const repoName = repo ? repo.split("/").filter(Boolean).pop() : "workspace";
  const displayName = me?.name || repoName || "Workspace";
  const initial = (displayName[0] || "A").toUpperCase();

  return (
    <section className="set-section">
      <div className="set-account">
        <span className="set-avatar">{initial}</span>
        <div>
          <div className="set-account-name">{displayName}</div>
          {me?.email && <div className="set-account-sub">{me.email}</div>}
          {(me?.role || role) && <div className="set-account-sub">role · {me?.role || role}</div>}
        </div>
      </div>
      <dl className="set-kv">
        <div>
          <dt>Workspace</dt>
          <dd title={repo}>{repoName}</dd>
        </div>
        <div>
          <dt>Path</dt>
          <dd className="set-kv-mono" title={repo}>{repo || "—"}</dd>
        </div>
        <div>
          <dt>Runtime</dt>
          <dd className="set-kv-mono">{runtime || "—"}</dd>
        </div>
        {me?.team && (
          <div>
            <dt>Team</dt>
            <dd>{me.team}</dd>
          </div>
        )}
      </dl>
      {!me && (
        <p className="set-section-hint">
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
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-nav-title">Settings</div>
        {SECTIONS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={`settings-nav-link${section === key ? " on" : ""}`}
            onClick={() => setSection(key)}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </nav>

      <div className="settings-main">
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
          <div className="set-body">
            {section === "account" && <AccountSection />}
            {section === "agent" && <AgentSettings />}
            {section === "appearance" && (
              <section className="set-section">
                <h3 className="set-section-title">Theme</h3>
                <p className="set-section-hint">
                  Dark is the workspace's terminal-native default; light is opt-in. Your choice is
                  saved on this machine.
                </p>
                <ThemeToggle />
              </section>
            )}
            {section === "privacy" && (
              <section className="set-section">
                <h3 className="set-section-title">Privacy</h3>
                <p className="set-section-hint">
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
