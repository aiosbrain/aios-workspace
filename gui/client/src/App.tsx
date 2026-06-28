import { CockpitProvider } from "./state/cockpit";
import { AppShell } from "./components/layout/AppShell";
import { Toaster } from "./components/ui/sonner";

export default function App() {
  return (
    <CockpitProvider>
      <AppShell />
      <Toaster position="bottom-right" />
    </CockpitProvider>
  );
}
