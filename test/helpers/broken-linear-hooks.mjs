/** Module customization hooks for broken-linear-loader.mjs. */
export async function load(url, context, nextLoad) {
  if (url.includes("/connectors/linear/")) {
    return {
      format: "module",
      shortCircuit: true,
      source: 'throw new Error("broken adapter fixture");',
    };
  }
  return nextLoad(url, context);
}
