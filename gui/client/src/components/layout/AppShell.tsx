import { useSession } from "../../state/cockpit";
import { Sidebar } from "./Sidebar";
import { ChatView } from "../chat/ChatView";
import { ReviewPanel } from "../review/ReviewPanel";
import { MaturityPanel } from "../maturity/MaturityPanel";
import { SettingsView } from "../settings/SettingsView";

function ViewRouter() {
  const { view } = useSession();
  switch (view) {
    case "chat":
      return <ChatView />;
    case "review":
      return <ReviewPanel />;
    case "maturity":
      return <MaturityPanel />;
    case "settings":
      return <SettingsView />;
  }
}

export function AppShell() {
  return (
    <div className="flex h-full flex-row">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <ViewRouter />
      </div>
    </div>
  );
}
