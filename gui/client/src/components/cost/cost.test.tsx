// Cost chart tests (AIO-457) — rendered with react-dom/server like comms.test.tsx
// (no jsdom): enough to pin the fixed-height/accessibility/actuals-only contract.

import { describe, test, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { AIOS_COST_CURSOR_BLUE, colorFor, CostBarChart, COST_CHART_H } from "./CostBarChart";
import {
  CostSettingsForm,
  buildConfigPatch,
  formFromConfig,
  parseUsd,
  type CostSettingsFormValues,
} from "./CostSettingsForm";
import type { CostConfigResponse, CostProviderActual } from "../../types/protocol";

const row = (
  provider: string,
  label: string,
  total_usd: number | null,
  status: CostProviderActual["status"] = total_usd == null ? "unknown" : "billing"
): CostProviderActual => ({ provider, label, status, total_usd, lines: total_usd == null ? 0 : 1 });

const TWO = [
  row("claude", "Claude", 200, "subscription"),
  row("anthropic", "Anthropic API", 42.13),
];
const FIVE = [
  ...TWO,
  row("cursor", "Cursor", 20, "config"),
  row("opencode", "Opencode", 3.25),
  row("codex", "Codex", null),
];

describe("CostBarChart", () => {
  test("provider colors are canonical design tokens", () => {
    expect(colorFor("claude", 0)).toBe("var(--aios-violet)");
    expect(colorFor("anthropic", 0)).toBe("var(--aios-fuchsia)");
    expect(AIOS_COST_CURSOR_BLUE).toBe("#3b82f6");
    expect(colorFor("cursor", 0)).toBe(AIOS_COST_CURSOR_BLUE);
    expect(colorFor("codex", 0)).toBe("var(--aios-emerald)");
    expect(colorFor("opencode", 0)).toBe("var(--aios-amber)");
    expect(Array.from({ length: 6 }, (_, i) => colorFor("unknown", i))).toEqual([
      "var(--aios-violet)",
      "var(--aios-fuchsia)",
      "var(--aios-emerald)",
      "var(--aios-amber)",
      "var(--aios-cyan)",
      "var(--aios-destructive)",
    ]);
    expect(colorFor("unknown", 6)).toBe("var(--aios-violet)");
  });

  test("GUI source carries no raw color literals", () => {
    const raw =
      /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb|color|device-cmyk)\s*\(/gi;
    const colorPropertyValue =
      /(?:\[\s*["'](?:color|background|background-color|backgroundColor|border|border-color|borderColor|fill|stroke)["']\s*\]|["'](?:color|background|background-color|backgroundColor|border|border-color|borderColor|fill|stroke)["']|\b(?:color|background|background-color|backgroundColor|border|border-color|borderColor|fill|stroke))\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`|([^;\n}>]*)(?=;|}|>|$))/gi;
    const paintAttributeValue =
      /\b(?:fill|stroke)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s>]+))/gi;
    const colorKeyword =
      /\b(?:aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen|currentcolor|transparent|inherit|initial|revert-layer|revert|unset|none|accentcolor|accentcolortext|activeborder|activecaption|activetext|appworkspace|background|buttonborder|buttonface|buttonhighlight|buttonshadow|buttontext|canvas|canvastext|captiontext|field|fieldtext|graytext|highlight|highlighttext|inactiveborder|inactivecaption|inactivecaptiontext|infobackground|infotext|linktext|mark|marktext|menu|menutext|scrollbar|selecteditem|selecteditemtext|threeddarkshadow|threedface|threedhighlight|threedlightshadow|threedshadow|visitedtext|window|windowframe|windowtext)\b(?!\s*\()/gi;
    const allowedColorKeywords = new Set(["currentcolor", "transparent"]);
    const cssWideKeywords = new Set(["inherit", "initial", "revert", "revert-layer", "unset"]);
    const nonColorPaintKeywords = new Set(["none"]);
    const cssSystemKeywords = new Set([
      "accentcolor",
      "accentcolortext",
      "activeborder",
      "activecaption",
      "activetext",
      "appworkspace",
      "background",
      "buttonborder",
      "buttonface",
      "buttonhighlight",
      "buttonshadow",
      "buttontext",
      "canvas",
      "canvastext",
      "captiontext",
      "field",
      "fieldtext",
      "graytext",
      "highlight",
      "highlighttext",
      "inactiveborder",
      "inactivecaption",
      "inactivecaptiontext",
      "infobackground",
      "infotext",
      "linktext",
      "mark",
      "marktext",
      "menu",
      "menutext",
      "scrollbar",
      "selecteditem",
      "selecteditemtext",
      "threeddarkshadow",
      "threedface",
      "threedhighlight",
      "threedlightshadow",
      "threedshadow",
      "visitedtext",
      "window",
      "windowframe",
      "windowtext",
    ]);
    const governedSystemKeywords = new Set<string>();
    const stripComments = (source: string) =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/<!--[\s\S]*?-->/g, "");
    const skippedDirectories = new Set([".git", "coverage", "dist", "node_modules", "vendor"]);
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory() && skippedDirectories.has(entry.name)) return [];
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return files(path);
        return /\.(?:css|ts|tsx|astro|mdx|svg|js|mjs|html)$/.test(entry.name) &&
          !/\.(?:test|spec)\./.test(entry.name)
          ? [path]
          : [];
      });
    for (const mutation of [
      "#abc",
      "rgb(1 2 3)",
      "rgba(1 2 3 / .5)",
      "hsl(1 2% 3%)",
      "hsla(1 2% 3% / .5)",
      "oklch(60% .2 20)",
      "oklab(60% .2 .1)",
      "lab(60% .2 .1)",
      "lch(60% .2 20)",
      "hwb(20 30% 40%)",
      "color(display-p3 1 0 0)",
      "device-cmyk(0 1 1 0)",
    ]) {
      expect(stripComments(`const mutation = '${mutation}'`).match(raw)?.length).toBeGreaterThan(0);
    }
    const keywordsFromValue = (value: string) => {
      if (/^(?:text|bg|border)-[a-z0-9-]+$/i.test(value.trim())) return [];
      return (
        value
          .replace(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g, "")
          .replace(/\burl\(\s*(?:"[^"]*"|'[^']*'|[^)])*\)/gi, "")
          .replace(/--[\w-]+/g, "")
          .replace(/\b[a-z][\w-]*\s*(?=\()/gi, "")
          .match(colorKeyword) ?? []
      );
    };
    const colorKeywords = (source: string) =>
      [
        ...[...stripComments(source).matchAll(colorPropertyValue)].flatMap((match) =>
          keywordsFromValue(match[1] ?? match[2] ?? match[3] ?? match[4])
        ),
        ...[...stripComments(source).matchAll(paintAttributeValue)].flatMap((match) =>
          keywordsFromValue(match[1] ?? match[2] ?? match[3] ?? match[4])
        ),
      ].map((value) => value.toLowerCase());
    const classifyColorKeywords = (source: string) => {
      const values = colorKeywords(source);
      return {
        allowed: values.filter((value) => allowedColorKeywords.has(value)),
        cssWide: values.filter((value) => cssWideKeywords.has(value)),
        nonColorPaint: values.filter((value) => nonColorPaintKeywords.has(value)),
        system: values.filter((value) => cssSystemKeywords.has(value)),
        governedSystem: values.filter((value) => governedSystemKeywords.has(value)),
        disallowed: values.filter(
          (value) =>
            !allowedColorKeywords.has(value) &&
            !cssWideKeywords.has(value) &&
            !nonColorPaintKeywords.has(value) &&
            !governedSystemKeywords.has(value)
        ),
      };
    };
    expect(
      classifyColorKeywords(
        'color: currentColor; background-color: transparent; fill="none"; color: inherit; color: initial; color: unset; color: revert; color: revert-layer;'
      )
    ).toEqual({
      allowed: ["currentcolor", "transparent"],
      cssWide: ["inherit", "initial", "unset", "revert", "revert-layer"],
      nonColorPaint: ["none"],
      system: [],
      governedSystem: [],
      disallowed: [],
    });
    for (const mutation of ["red", "blue", "CanvasText", "ButtonFace", "rebeccapurple"]) {
      expect(classifyColorKeywords(`color: ${mutation};`).disallowed).toEqual([
        mutation.toLowerCase(),
      ]);
    }
    for (const keyword of cssSystemKeywords) {
      const classified = classifyColorKeywords(`color: ${keyword};`);
      expect(classified.system).toEqual([keyword]);
      expect(classified.governedSystem).toEqual([]);
      expect(classified.disallowed).toEqual([keyword]);
    }
    expect(classifyColorKeywords('fill="red"; stroke={"CanvasText"}').disallowed).toEqual([
      "red",
      "canvastext",
    ]);
    expect(classifyColorKeywords("fill=red stroke=CanvasText").disallowed).toEqual([
      "red",
      "canvastext",
    ]);
    expect(classifyColorKeywords("color: var(--missing-color, blue);").disallowed).toEqual([
      "blue",
    ]);
    for (const [mutation, expected] of [
      ["border: 1px solid red;", ["red"]],
      ["background: url(x) blue;", ["blue"]],
      ["background: url(red.svg) blue; color: var(--red);", ["blue"]],
      ["border: var(--missing, 1px solid red);", ["red"]],
      ["background: var(--missing, url(x) CanvasText);", ["canvastext"]],
      ["background: linear-gradient(red, blue);", ["red", "blue"]],
      ["background: var(--red) blue;", ["blue"]],
      ["background: theme.value red;", ["red"]],
      ["color: Palette.value blue;", ["blue"]],
      ["<div style=color:red>", ["red"]],
      ["color: red", ["red"]],
      ["fill={`red`}", ["red"]],
      ['fill={ok ? "red" : "blue"}', ["red", "blue"]],
      ['const style = { background: ok ? "red" : "blue" }', ["red", "blue"]],
      ["const style = { background: `${value} red` }", ["red"]],
      ['const style = { "background": "red" }', ["red"]],
      ['const style = { ["border"]: "1px solid blue" }', ["blue"]],
    ] as const) {
      expect(classifyColorKeywords(mutation).disallowed).toEqual(expected);
    }
    expect(
      classifyColorKeywords(
        'fill={ ok ? "red" : "blue" } stroke={ ok ? "CanvasText" : "rebeccapurple" }'
      ).disallowed
    ).toEqual(["red", "blue", "canvastext", "rebeccapurple"]);
    expect(
      classifyColorKeywords(
        '<div style="color: red; background: url(x) blue; border: 1px solid rebeccapurple"></div>'
      ).disallowed
    ).toEqual(["red", "blue", "rebeccapurple"]);
    expect(
      classifyColorKeywords(
        'const styles = { background: "url(x) red", backgroundColor: "blue", border: "1px solid rebeccapurple", borderColor: "CanvasText" }'
      ).disallowed
    ).toEqual(["red", "blue", "rebeccapurple", "canvastext"]);
    expect(classifyColorKeywords("color: CanvasText;").system).toEqual(["canvastext"]);
    const found = files(".").flatMap((path) =>
      (stripComments(readFileSync(path, "utf8")).match(raw) ?? []).map(
        (value) => `${path.replace(/^\.\//, "")}: ${value}`
      )
    );
    expect(found).toEqual(["src/components/cost/CostBarChart.tsx: #3b82f6"]);
    const named = files(".").flatMap((path) =>
      classifyColorKeywords(readFileSync(path, "utf8")).disallowed.map(
        (value) => `${path.replace(/^\.\//, "")}: ${value}`
      )
    );
    expect(named).toEqual([]);
    expect(readFileSync("src/components/cost/CostBarChart.tsx", "utf8")).toContain(
      "Governed provider-identity exception"
    );
  });

  test("height is fixed regardless of provider count", () => {
    const two = renderToStaticMarkup(<CostBarChart rows={TWO} period="2026-07" />);
    const five = renderToStaticMarkup(<CostBarChart rows={FIVE} period="2026-07" />);
    expect(two).toContain(`height="${COST_CHART_H}"`);
    expect(five).toContain(`height="${COST_CHART_H}"`);
    expect((two.match(/height="150"/g) ?? []).length).toBe(1);
    expect((five.match(/height="150"/g) ?? []).length).toBe(1);
  });

  test("has a labeled USD x-axis with tabular figures", () => {
    const html = renderToStaticMarkup(<CostBarChart rows={TWO} period="2026-07" />);
    expect(html).toContain("$0"); // axis origin tick
    expect(html).toMatch(/\$\d/); // dollar-denominated ticks
    expect(html).toContain("tabular-nums");
    expect(html).toContain("font-variant-numeric:tabular-nums");
  });

  test("exposes a full text equivalent and exact amounts", () => {
    const html = renderToStaticMarkup(<CostBarChart rows={FIVE} period="2026-07" />);
    expect(html).toContain('role="img"');
    expect(html).toContain("Actual spend by provider for 2026-07");
    expect(html).toContain("Claude $200.00");
    expect(html).toContain("Anthropic API $42.13");
    expect(html).toContain("Codex unknown");
    expect(html).toContain("$42.13"); // rendered amount label
  });

  test("never draws a bar for an unknown provider and never mentions tokens", () => {
    const html = renderToStaticMarkup(<CostBarChart rows={FIVE} period="2026-07" />);
    // 4 known providers → 4 bars (rects); codex (unknown) gets none.
    expect((html.match(/<rect/g) ?? []).length).toBe(4);
    expect(html.toLowerCase()).not.toContain("token");
    expect(html.toLowerCase()).not.toContain("estimate");
  });

  test("empty state is honest text, still at fixed height", () => {
    const html = renderToStaticMarkup(
      <CostBarChart rows={[row("codex", "Codex", null)]} period="2026-07" />
    );
    expect(html).toContain("No actual spend recorded for 2026-07.");
    expect(html).toContain(`height="${COST_CHART_H}"`);
  });
});

// ── Settings form: a failed config GET must never turn into a config wipe ──────────────────────────

const BLANK_FORM: CostSettingsFormValues = {
  claude: "",
  cursor: "",
  codex: "",
  opencode: "",
  zai: "",
  anthropic: "",
  openai: "",
  openrouter: "",
};

function renderForm(props: Partial<Parameters<typeof CostSettingsForm>[0]> = {}) {
  return renderToStaticMarkup(
    <CostSettingsForm
      period="2026-07"
      form={BLANK_FORM}
      loaded={false}
      loadError={null}
      status={null}
      busy={false}
      onChange={() => {}}
      onSave={() => {}}
      onRetry={() => {}}
      {...props}
    />
  );
}

describe("CostSettingsForm", () => {
  test("Save and inputs are disabled until the config GET has hydrated the form", () => {
    // Reviewer repro: GET failed → all-blank form. Saving it would post explicit
    // nulls and delete every existing entry, so everything must be disabled.
    const html = renderForm({ loaded: false, loadError: "http 500" });
    const saveBtn = html.slice(html.lastIndexOf("<button"));
    expect(saveBtn).toContain('disabled=""'); // the attribute, not the Tailwind variant
    expect((html.match(/<input[^>]*\sdisabled=""/g) ?? []).length).toBe(8);
    expect(html).toContain("editing is disabled so a save can’t wipe your existing entries");
    expect(html).toContain("Retry");
  });

  test("hydrated form is fully editable", () => {
    const html = renderForm({
      loaded: true,
      form: {
        claude: "200",
        cursor: "20",
        codex: "",
        opencode: "15",
        zai: "10",
        anthropic: "42.13",
        openai: "10",
        openrouter: "8.5",
      },
    });
    const saveBtn = html.slice(html.lastIndexOf("<button"));
    expect(saveBtn).not.toContain('disabled=""');
    expect((html.match(/<input[^>]*\sdisabled=""/g) ?? []).length).toBe(0);
    expect(html).toContain('value="42.13"');
  });
});

describe("config patch round-trip", () => {
  const CFG: CostConfigResponse = {
    ok: true,
    subscriptions: { claude: 200, cursor: null, codex: 0, opencode: 15, zai: 10 },
    metered: {
      anthropic: { "2026-07": 42.13 },
      cursor: {},
      codex: {},
      openai: { "2026-07": 10 },
      opencode: {},
      openrouter: { "2026-07": 8.5 },
      zai: {},
    },
  };

  test("formFromConfig displays exactly what the server resolved", () => {
    expect(formFromConfig(CFG, "2026-07")).toEqual({
      claude: "200",
      cursor: "",
      codex: "0",
      opencode: "15",
      zai: "10",
      anthropic: "42.13",
      openai: "10",
      openrouter: "8.5",
    });
  });

  test("buildConfigPatch preserves hydrated values and nulls only true blanks", () => {
    const built = buildConfigPatch(formFromConfig(CFG, "2026-07"), "2026-07");
    expect(built).toEqual({
      patch: {
        subscriptions: { claude: 200, cursor: null, codex: 0, opencode: 15, zai: 10 },
        metered: {
          anthropic: { "2026-07": 42.13 },
          openai: { "2026-07": 10 },
          openrouter: { "2026-07": 8.5 },
        },
      },
    });
  });

  test("buildConfigPatch rejects invalid amounts instead of posting them", () => {
    const built = buildConfigPatch({ ...BLANK_FORM, cursor: "lots" }, "2026-07");
    expect(built).toEqual({ error: '"lots" isn\'t a valid USD amount' });
    expect(parseUsd("$20")).toBe(20);
    expect(parseUsd("  ")).toBeNull();
    expect(Number.isNaN(parseUsd("-5") as number)).toBe(true);
  });
});
