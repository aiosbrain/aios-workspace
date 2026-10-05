// Test-only loader: the colour renderers for analyze and the two health commands throw,
// so a PTY run exercises the presenter's render-failure fallback end to end.
const TARGET = "/dist/terminal/report.js";
export async function load(url, context, nextLoad) {
  if (url.endsWith(TARGET)) {
    const real = `${url}?real`;
    const fail = (name) =>
      `export function ${name}() { throw new Error("injected render failure"); }`;
    return {
      format: "module",
      shortCircuit: true,
      source: [
        `export * from ${JSON.stringify(real)};`,
        fail("renderAnalyze"),
        fail("renderContextHealth"),
        fail("renderCodebaseHealth"),
      ].join("\n"),
    };
  }
  return nextLoad(url, context);
}
