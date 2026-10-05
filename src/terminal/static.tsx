import { Box, renderToString } from "ink";
import { stripVTControlCharacters } from "node:util";
import type { ReactNode } from "react";
import { Providers } from "./theme.js";
import type { Capabilities } from "./types.js";

// Strip controls in external filenames/provider text before terminal rendering.
// Control characters in provider text must never become terminal commands.
export const safeText = (value: unknown) =>
  // eslint-disable-next-line no-control-regex
  stripVTControlCharacters(String(value ?? "")).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
export function renderStatic(ctx: Capabilities, children: ReactNode) {
  const text = renderToString(
    <Providers ctx={ctx}>
      <Box width={ctx.width} flexDirection="column">
        {children}
      </Box>
    </Providers>,
    { columns: ctx.width }
  );
  return ctx.colorDepth === 0 ? stripVTControlCharacters(text) : text;
}
