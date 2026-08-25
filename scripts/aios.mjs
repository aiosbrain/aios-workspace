#!/usr/bin/env node
import { run } from "./cli.mjs";

await run(process.argv.slice(2));
