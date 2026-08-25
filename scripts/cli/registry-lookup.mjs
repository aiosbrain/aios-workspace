import { validateCommandDescriptor } from "./command-contract.mjs";

export function commandIndex(commands) {
  const index = new Map();
  for (const descriptor of commands) {
    validateCommandDescriptor(descriptor);
    for (const name of [descriptor.name, ...(descriptor.aliases ?? [])]) {
      if (index.has(name)) throw new Error(`aios registry: duplicate command name '${name}'`);
      index.set(name, descriptor);
    }
  }
  return index;
}

function editDistance(a, b) {
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, index) => index);
  for (let row = 1; row <= a.length; row++) {
    const current = [row];
    for (let column = 1; column < cols; column++) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[cols - 1];
}

export function nearestName(names, input) {
  if (!input) return null;
  const best = names
    .map((name) => ({ name, distance: editDistance(input, name) }))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))[0];
  return best && best.distance <= Math.max(2, Math.floor(input.length / 3)) ? best.name : null;
}

export function renderCommandUsage(commands, header, footer) {
  return [...header, ...commands.flatMap((descriptor) => descriptor.usage), ...footer].join("\n");
}
