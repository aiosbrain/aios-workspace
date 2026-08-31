// --import preload: sabotage every module under scripts/connectors/slack/ so a test can
// prove a BROKEN Slack adapter is quarantined to its own command surface
// (test/slack-adapter-quarantine.test.mjs).
import { register } from "node:module";

register(new URL("./broken-slack-hooks.mjs", import.meta.url));
