#!/usr/bin/env node
import { run } from "./cli.mjs";

// A real CLI ends shim resolution. Later workspace commands start a fresh delegation chain.
delete process.env.AIOS_SHIM_VISITED_ROOTS;

await run(process.argv.slice(2));
