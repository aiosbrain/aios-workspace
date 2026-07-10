import { useSession } from "../../state/cockpit";
import { Sidebar } from "./Sidebar";
import { ChatView } from "../chat/ChatView";
import { TasksPanel } from "../tasks/TasksPanel";
import { ReviewPanel } from "../review/ReviewPanel";
import { MaturityPanel } from "../maturity/MaturityPanel";
import { CostPanel } from "../cost/CostPanel";
import { SettingsView } from "../settings/SettingsView";

function ViewRouter() {
  const { view } = useSession();
  switch (view) {
    case "chat":
      return <ChatView />;
    case "tasks":
      return <TasksPanel />;
    case "review":
      return <ReviewPanel />;
    case "maturity":
      return <MaturityPanel />;
    case "cost":
      return <CostPanel />;
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
