import { useSession } from "../../state/cockpit";
import { Sidebar } from "./Sidebar";
import { ChatView } from "../chat/ChatView";
import { SkillsPanel } from "../skills/SkillsPanel";
import { IntegrationsPanel } from "../integrations/IntegrationsPanel";
import { ReviewPanel } from "../review/ReviewPanel";
import { SettingsPanel } from "../settings/SettingsPanel";

function ViewRouter() {
  const { view, setView, setInput } = useSession();
  switch (view) {
    case "chat":
      return <ChatView />;
    case "skills":
      return <SkillsPanel />;
    case "integrations":
      return (
        <IntegrationsPanel
          onTryInChat={(prompt: string) => {
            setView("chat");
            setInput(prompt);
          }}
        />
      );
    case "review":
      return <ReviewPanel />;
    case "settings":
      return <SettingsPanel />;
  }
}

export function AppShell() {
  return (
    <div className="app">
      <Sidebar />
      <div className="app-main">
        <ViewRouter />
      </div>
    </div>
  );
}
