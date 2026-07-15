import { useEffect, useState } from "react";
import {
  MessageSquare,
  MessageSquarePlus,
  Repeat,
  Settings,
  SunMoon,
  UploadCloud,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "../ui/command";
import { useConnection, useSession } from "../../state/cockpit";
import { toggleTheme } from "../../theme.js";
import type { SessionSearchResult } from "../../types/protocol";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * ⌘K palette: fuzzy over chat titles + quick actions, with full-content chat search
 * folded in. cmdk does the fuzzy filtering over each item's `value`; we enrich a chat's
 * value with its server-side content snippet so a content-only match still survives the
 * filter (and shows the snippet). The primary search surface for the cockpit.
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const { api } = useConnection();
  const { chats, openChat, newChat, setView } = useSession();
  const [query, setQuery] = useState("");
  const [snippets, setSnippets] = useState<Map<string, string>>(() => new Map());

  // Reset transient state whenever the palette closes.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setSnippets(new Map());
    }
  }, [open]);

  // Debounced full-content search → snippet per session id.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSnippets(new Map());
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .get<{ results: SessionSearchResult[] }>(`/api/sessions/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (cancelled) return;
          setSnippets(new Map((r.results || []).map((h) => [h.id, h.snippet])));
        })
        .catch(() => {
          if (!cancelled) setSnippets(new Map());
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, api]);

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  const actions = [
    {
      id: "new",
      label: "New chat",
      icon: <MessageSquarePlus size={16} />,
      shortcut: "⌘N",
      onRun: () => run(newChat),
    },
    {
      id: "loop",
      label: "Operator Loop",
      icon: <Repeat size={16} />,
      onRun: () => run(() => setView("loop")),
    },
    {
      id: "review",
      label: "Team Brain Sync",
      icon: <UploadCloud size={16} />,
      onRun: () => run(() => setView("review")),
    },
    {
      id: "settings",
      label: "Settings",
      icon: <Settings size={16} />,
      onRun: () => run(() => setView("settings")),
    },
    {
      id: "theme",
      label: "Toggle theme",
      icon: <SunMoon size={16} />,
      onRun: () => run(() => toggleTheme()),
    },
  ];

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder="Search chats or run a command…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        <CommandGroup heading="Actions">
          {actions.map((a) => (
            <CommandItem key={a.id} value={`action ${a.label}`} onSelect={a.onRun}>
              {a.icon}
              <span>{a.label}</span>
              {a.shortcut && <CommandShortcut>{a.shortcut}</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="Chats">
          {chats.map((c) => {
            const snippet = snippets.get(c.id);
            return (
              <CommandItem
                key={c.id}
                // Fold the content snippet into the searchable value so a content-only
                // match keeps the chat visible under cmdk's filter.
                value={`chat ${c.title || ""} ${snippet || ""}`}
                onSelect={() => run(() => openChat(c.id))}
              >
                <MessageSquare size={16} className="shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">{c.title || "New chat"}</span>
                  {snippet && query.trim() && (
                    <span className="truncate text-xs text-muted-foreground">{snippet}</span>
                  )}
                </div>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
