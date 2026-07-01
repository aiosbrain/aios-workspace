import { useState } from "react";
import { CockpitProvider, useSession } from "./state/cockpit";
import { AppShell } from "./components/layout/AppShell";
import { CommandPalette } from "./components/command/CommandPalette";
import { useGlobalShortcuts } from "./lib/shortcuts";
import { Toaster } from "./components/ui/sonner";

/**
 * Global command layer: owns the ⌘K palette open-state and binds the keyboard shortcuts.
 * Lives inside CockpitProvider so it can read session actions (newChat).
 */
function CommandLayer() {
  const { newChat } = useSession();
  const [paletteOpen, setPaletteOpen] = useState(false);
  useGlobalShortcuts({
    onPalette: () => setPaletteOpen((o) => !o),
    onNewChat: () => newChat(),
  });
  return <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />;
}

export default function App() {
  return (
    <CockpitProvider>
      <AppShell />
      <CommandLayer />
      <Toaster position="bottom-right" />
    </CockpitProvider>
  );
}
