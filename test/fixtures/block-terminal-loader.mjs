export async function resolve(specifier, context, nextResolve) {
  if (specifier === "ink" || specifier === "react" || specifier.startsWith("react/")) {
    throw new Error(`Unexpected terminal dependency: ${specifier}`);
  }
  return nextResolve(specifier, context);
}
