// @vitest-environment happy-dom
/**
 * AIO-536 — the shared model <option> list.
 *
 * Flat for a single-provider catalog (the claude-code case — markup unchanged), one
 * <optgroup> per provider when a runtime brokers several, and an honest extra entry
 * when the configured model isn't in the catalog at all.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModelOptions } from "./ModelOptions";
import type { ModelOption } from "../../types/runtime";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(models: ModelOption[], selected?: string) {
  act(() => {
    root!.render(
      <select value={selected ?? ""} onChange={() => {}}>
        <ModelOptions models={models} selected={selected} />
      </select>
    );
  });
  const select = host!.querySelector("select")!;
  return {
    groups: [...select.querySelectorAll("optgroup")].map((g) => g.label),
    options: [...select.querySelectorAll("option")].map((o) => ({
      value: o.value,
      label: o.textContent,
      group: (o.parentElement as HTMLElement).tagName === "OPTGROUP" ? o.parentElement : null,
    })),
  };
}

const CLAUDE: ModelOption[] = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
];

const MULTI: ModelOption[] = [
  { id: "openrouter/qwen/qwen3.7-plus", label: "Qwen3.7 Plus", group: "OpenRouter" },
  { id: "openrouter/qwen/qwen3.7-max", label: "Qwen3.7 Max", group: "OpenRouter" },
  { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
];

test("an ungrouped catalog renders flat, with no optgroups", () => {
  const { groups, options } = render(CLAUDE, "claude-sonnet-4-6");
  expect(groups).toEqual([]);
  expect(options.map((o) => o.value)).toEqual(["claude-sonnet-4-6", "claude-opus-4-8"]);
  expect(options.map((o) => o.label)).toEqual(["Sonnet 4.6", "Opus 4.8"]);
  expect(options.every((o) => o.group === null)).toBe(true);
});

test("a multi-provider catalog groups by provider, in first-seen order", () => {
  const { groups, options } = render(MULTI, "openrouter/qwen/qwen3.7-plus");
  expect(groups).toEqual(["OpenRouter", "Anthropic"]);
  expect(options.map((o) => o.value)).toEqual([
    "openrouter/qwen/qwen3.7-plus",
    "openrouter/qwen/qwen3.7-max",
    "anthropic/claude-sonnet-4-6",
  ]);
  expect(options.every((o) => o.group !== null)).toBe(true);
});

test("a configured model outside the catalog is shown and flagged, not dropped", () => {
  const { options } = render(CLAUDE, "openrouter/qwen/qwen3.7-plus");
  const extra = options.find((o) => o.value === "openrouter/qwen/qwen3.7-plus");
  expect(extra, "the configured model must still appear").toBeTruthy();
  expect(extra!.label).toMatch(/not in this runtime's catalog/);
  // …and it must not silently replace the real catalog entries.
  expect(options.map((o) => o.value)).toContain("claude-sonnet-4-6");
});

test("an out-of-catalog model lands in an 'Other' group when the catalog is grouped", () => {
  const { groups, options } = render(MULTI, "mystery/model");
  expect(groups).toContain("Other");
  expect(options.find((o) => o.value === "mystery/model")).toBeTruthy();
});

test("a model already in the catalog is not duplicated", () => {
  const { options } = render(CLAUDE, "claude-opus-4-8");
  expect(options.filter((o) => o.value === "claude-opus-4-8")).toHaveLength(1);
});

test("no selection and an empty catalog render nothing rather than throwing", () => {
  expect(render(CLAUDE, undefined).options).toHaveLength(2);
  expect(render([], undefined).options).toHaveLength(0);
});
