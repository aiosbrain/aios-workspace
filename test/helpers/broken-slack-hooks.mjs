/** Module customization hooks for broken-slack-loader.mjs. */
export async function load(url, context, nextLoad) {
  if (url.includes("/connectors/slack/")) {
    return {
      format: "module",
      shortCircuit: true,
      source: 'throw new Error("broken slack adapter fixture");',
    };
  }
  return nextLoad(url, context);
}
