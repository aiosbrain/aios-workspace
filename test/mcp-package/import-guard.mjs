import { register } from "node:module";
register(new URL("./import-hook.mjs", import.meta.url), {
  data: { root: process.env.MCP_INSTALL_ROOT },
});
