// Ambient typings for the restricted flat-YAML reader, consumed by the TS
// operator-loop collector under nodenext resolution.

export function stripQuotes(s: string): string;

export function parseFlatYaml(text: string): Record<string, string | string[]>;
