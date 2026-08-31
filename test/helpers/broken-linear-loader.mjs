// --import preload: sabotage every module under scripts/connectors/linear/ so a test can
// prove a BROKEN Linear adapter is quarantined to its own command surface
// (test/linear-adapter-quarantine.test.mjs).
import { register } from "node:module";

register(new URL("./broken-linear-hooks.mjs", import.meta.url));
