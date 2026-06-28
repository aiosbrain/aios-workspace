import { useSession } from "../../state/cockpit";
import { Sidebar } from "./Sidebar";
import { ChatView } from "../chat/ChatView";
import { ReviewPanel } from "../review/ReviewPanel";
import { SettingsView } from "../settings/SettingsView";

function ViewRouter() {
  const { view } = useSession();
  switch (view) {
    case "chat":
      return <ChatView />;
    case "review":
      return <ReviewPanel />;
    case "settings":
      return <SettingsView />;
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
