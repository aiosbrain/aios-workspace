// Ambient typings for the AEM placement engine (see aem.mjs). Hand-written; declares only
// the surface the TypeScript operator-loop collector consumes (the full engine has many more
// exports used by its .mjs consumers).

/** Full AEM placement for a signals object. */
export interface AemPlacement {
  axes: Record<string, number>;
  spine: string; // "L0".."L5"
  overall: number;
  weakest: string; // axis key
}

export function placement(signals: Record<string, number>): AemPlacement;
