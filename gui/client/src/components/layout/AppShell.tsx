import { useSession } from "../../state/cockpit";
import { Sidebar } from "./Sidebar";
import { ChatView } from "../chat/ChatView";
import { CommsView } from "../comms/CommsView";
import { TasksPanel } from "../tasks/TasksPanel";
import { ReviewPanel } from "../review/ReviewPanel";
import { MaturityPanel } from "../maturity/MaturityPanel";
import { CostPanel } from "../cost/CostPanel";
import { LoopPanel } from "../loop/LoopPanel";
import { SettingsView } from "../settings/SettingsView";

function ViewRouter() {
  const { view } = useSession();
  switch (view) {
    case "chat":
      return <ChatView />;
    case "comms":
      return <CommsView />;
    case "tasks":
      return <TasksPanel />;
    case "review":
      return <ReviewPanel />;
    case "maturity":
      return <MaturityPanel />;
    case "cost":
      return <CostPanel />;
    case "loop":
      return <LoopPanel />;
    case "settings":
      return <SettingsView />;
  }
}

export function AppShell() {
  return (
    <div className="flex h-[100dvh] min-h-0 flex-row overflow-hidden">
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <ViewRouter />
      </div>
    </div>
  );
}
