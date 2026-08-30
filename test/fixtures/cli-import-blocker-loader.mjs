const forbidden = [
  "aios-runtime.mjs",
  "/scripts/connector.mjs",
  "/scripts/connectors/",
  "@aiosbrain/aios-devtools",
];

export async function resolve(specifier, context, nextResolve) {
  if (forbidden.some((token) => specifier.includes(token))) {
    throw new Error(`diagnostic imported forbidden runtime: ${specifier}`);
  }
  return nextResolve(specifier, context);
}
