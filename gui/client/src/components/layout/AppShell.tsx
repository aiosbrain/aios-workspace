import { useSession } from "../../state/cockpit";
import { Sidebar } from "./Sidebar";
import { ChatView } from "../chat/ChatView";
// Legacy panels (strangler bridge) — rewritten in TypeScript in Phase 3.
import {
  SettingsPanel,
  SkillsPanel,
  ReviewPanel,
  IntegrationsPanel,
} from "../../legacy/panels.jsx";

function ViewRouter() {
  const { view, model, changeModel, newChat, setView, setInput } = useSession();
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
      return (
        <SettingsPanel model={model} onModelChange={changeModel} onPersonalityApplied={newChat} />
      );
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
