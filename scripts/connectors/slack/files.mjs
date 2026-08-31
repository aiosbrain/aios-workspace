/**
 * File flows for `aios slack …` (AIO-1068): upload (files.getUploadURLExternal → raw-byte
 * PUT/POST → files.completeUploadExternal) and delete (files.delete).
 *
 * WORKSPACE CONTAINMENT — the slack.py policy, ported to Node:
 *
 *   - `..` is refused on the CALLER-SPELLED path before any normalization (lexical
 *     collapsing is wrong exactly when a component is a symlink).
 *   - For an absolute path, the SHALLOWEST prefix whose realpath IS the workspace root is
 *     the anchor; every remaining caller-spelled component is checked literally, so a
 *     symlink anywhere below the root is seen, not silently resolved away.
 *   - Every intermediate component is refused if it is a symlink; the leaf is opened with
 *     O_NOFOLLOW and fstat-verified to be a regular file, and the size cap and emptiness
 *     checks run on the BYTES READ from that descriptor, never on a stat that could have
 *     gone stale.
 *   - Fails closed: without O_NOFOLLOW support, containment cannot be enforced and the
 *     upload is refused. `--allow-outside-workspace` is the one explicit opt-out.
 *
 *   Node has no openat(2), so the intermediate-directory checks are lstat-based rather
 *   than a descriptor walk: the ADMISSION policy (what is refused) is identical to
 *   slack.py's; the directory-swap race window the Python descriptor walk closed is not
 *   closable with Node's stdlib and is documented here rather than papered over.
 *
 * The upload URL arrives in a Slack API RESPONSE (it is not ours): it goes through the
 * same trustedFetch destination validation as every other request, marked credentialed —
 * the URL is signed and single-use — so file:, malformed, non-loopback-http and
 * cross-origin-redirect upload destinations receive zero bytes.
 */
import * as fs from "node:fs";
import path from "node:path";
import { AiosError, trustedFetch } from "../../cli.mjs";
import { parseVerbArgs } from "./args.mjs";
import { resolveMemberChannel, resolveTarget, retryDelayMs, slackCall } from "./web.mjs";

// Deliberate, documented cap (ported): the whole file is buffered to set Content-Length,
// so "what Slack allows" is the wrong limit — refuse clearly instead of OOMing.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const usage = (message, remediation = "Run `aios slack help` for the file verb reference.") =>
  new AiosError("AIOS_E_USAGE", message, remediation);

const DOTDOT = Symbol("dotdot");

function realpathOrNull(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

/**
 * Split `spelled` into the literal components below `root`, DOTDOT when it spells `..`,
 * or null when it escapes the workspace. Only the anchor is resolved, never the tail.
 */
export function componentsUnderRoot(spelled, root) {
  const parts = spelled.split(path.sep).filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) return DOTDOT;
  if (!path.isAbsolute(spelled)) return parts;
  // Shallowest anchor, not deepest: the anchor is the part we resolve and stop checking,
  // so a deeper match would absorb caller-spelled symlink components unseen.
  for (let index = 1; index <= parts.length; index++) {
    const prefix = path.sep + parts.slice(0, index).join(path.sep);
    if (realpathOrNull(prefix) === root) return parts.slice(index);
  }
  return null;
}

function openLeaf(fullPath, spelled) {
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  try {
    return fs.openSync(fullPath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if (error.code === "ELOOP" || error.code === "EMLINK") {
      throw usage(`Refusing to upload through a symlink: ${spelled} (copy the file instead).`);
    }
    if (error.code === "ENOENT") throw usage(`No such file: ${spelled}`);
    if (error.code === "ENOTDIR" || error.code === "ENXIO") {
      throw usage(`Not a regular file: ${spelled}`);
    }
    throw usage(`Cannot open ${spelled}: ${error.code ?? error.message}`);
  }
}

/** Open `spelled` for reading, guaranteeing it lives inside the working directory. */
export function openContained(spelled, { allowOutside = false, cwd = process.cwd() } = {}) {
  if (allowOutside) return openLeaf(spelled, spelled);
  if (!fs.constants.O_NOFOLLOW) {
    throw usage(
      "Cannot enforce workspace containment on this platform (no O_NOFOLLOW); the upload is " +
        "refused rather than silently unprotected.",
      "Pass --allow-outside-workspace to upload anyway, knowingly."
    );
  }
  const root = realpathOrNull(cwd);
  const parts = componentsUnderRoot(spelled, root);
  if (parts === DOTDOT) {
    throw usage(
      `Refusing a path containing '..': ${spelled}`,
      "Pass the direct path to the file (`..` cannot be checked without resolving it, and " +
        "resolving it is what lets a symlink hide)."
    );
  }
  if (parts === null) {
    throw usage(
      `Refusing to upload a file that resolves outside this workspace: ${spelled} ` +
        `(workspace: ${root}).`,
      "Pass --allow-outside-workspace if that is deliberate."
    );
  }
  if (!parts.length) throw usage(`Not a regular file: ${spelled}`);
  let walked = root;
  for (const component of parts.slice(0, -1)) {
    walked = path.join(walked, component);
    let stats;
    try {
      stats = fs.lstatSync(walked);
    } catch {
      throw usage(`No such file: ${spelled}`);
    }
    if (stats.isSymbolicLink()) {
      throw usage(
        `Refusing to upload through a symlinked directory: ${spelled} ` +
          `(component '${component}' is a symlink).`
      );
    }
    if (!stats.isDirectory()) throw usage(`Not a regular file: ${spelled}`);
  }
  return openLeaf(path.join(walked, parts.at(-1)), spelled);
}

/** Open, validate and read a candidate on ONE descriptor. Returns { data, filename }. */
export function readUploadCandidate(spelled, options = {}) {
  const fd = openContained(spelled, options);
  try {
    if (!fs.fstatSync(fd).isFile()) throw usage(`Not a regular file: ${spelled}`);
    // Read one byte past the cap so oversize is detected from the bytes themselves.
    const buffer = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    let total = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_UPLOAD_BYTES) {
        throw usage(
          `File exceeds this CLI's ${MAX_UPLOAD_BYTES}-byte upload cap (${spelled}). ` +
            "The whole file is buffered in memory to set Content-Length."
        );
      }
    }
    if (!total) throw usage(`Refusing to upload an empty file: ${spelled}`);
    return { data: buffer.subarray(0, total), filename: path.basename(spelled) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Raw-bytes upload to the short-lived URL (NOT a Web API method — no ok:false envelope).
 *  Retries honor Retry-After / backoff via the same retryDelayMs every other retry path
 *  uses — an immediate re-send inside a rate-limit window would burn all four attempts
 *  instantly (Codex round 1). `ctx.sleep` is the test seam. */
async function uploadBytes(ctx, uploadUrl, data) {
  const wait = ctx.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await trustedFetch(uploadUrl, {
        method: "POST",
        body: data,
        headers: { "Content-Type": "application/octet-stream" },
        // The URL is itself the credential (signed, single-use): origin-pin its redirects.
        credentialed: true,
        signal: AbortSignal.timeout(ctx.timeoutMs ?? 120_000),
        fetch: ctx.fetch,
        env: ctx.env,
      });
    } catch (error) {
      if (error instanceof AiosError) throw error;
      if (attempt < 3) {
        await wait(retryDelayMs(null, attempt));
        continue;
      }
      throw new AiosError(
        "AIOS_E_NETWORK",
        `Network error uploading file bytes: ${error.message}`,
        "Check network connectivity and retry."
      );
    }
    if (response.status < 400) return;
    if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
      await wait(retryDelayMs(response.headers.get("retry-after"), attempt));
      continue;
    }
    // Deliberately names neither the URL (a credential) nor the body (Slack's, not ours).
    throw new AiosError(
      "AIOS_E_NETWORK",
      `HTTP ${response.status} uploading file bytes to Slack's upload URL.`,
      "Retry; report to Slack if it persists."
    );
  }
}

export async function cmdFile(ctx, argv) {
  const args = parseVerbArgs(argv, {
    flags: {
      target: "value",
      member: "value",
      path: "value",
      message: "value",
      "allow-outside-workspace": "boolean",
    },
    requireOneOf: [["target", "member"], ["path"]],
  });
  if (args.help) return null;
  // Read and validate FIRST: a refusal must not have spoken to Slack at all.
  const { data, filename } = readUploadCandidate(args.path, {
    allowOutside: args.allowOutsideWorkspace === true,
    cwd: ctx.cwd,
  });
  const channel = args.member
    ? await resolveMemberChannel(ctx, args.member)
    : await resolveTarget(ctx, args.target);
  const granted = await slackCall(ctx, "files.getUploadURLExternal", {
    filename,
    length: data.length,
  });
  if (!granted.upload_url || !granted.file_id) {
    throw new AiosError(
      "AIOS_E_PROVIDER",
      "files.getUploadURLExternal did not return upload_url/file_id.",
      "Retry; report to Slack if it persists."
    );
  }
  await uploadBytes(ctx, granted.upload_url, data);
  const complete = await slackCall(ctx, "files.completeUploadExternal", {
    files: JSON.stringify([{ id: granted.file_id, title: filename }]),
    channel_id: channel,
    initial_comment: args.message ?? null,
  });
  const files = complete.files ?? [];
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, channel, files })}\n`);
  } else {
    process.stdout.write(
      `uploaded → ${channel}: ${filename} (${files[0]?.id ?? granted.file_id})\n`
    );
  }
  return 0;
}

/** `aios slack file-delete <FILE_ID>` — remove an uploaded file (the cleanup half of the
 *  upload/delete smoke; slack.py never had it, which left no bounded-cleanup path). */
export async function cmdFileDelete(ctx, argv) {
  const args = parseVerbArgs(argv, { positional: "file" });
  if (args.help) return null;
  if (!args.file) throw usage("file-delete requires a Slack file id (F…).");
  await slackCall(ctx, "files.delete", { file: args.file });
  if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, file: args.file })}\n`);
  else process.stdout.write(`deleted ${args.file}\n`);
  return 0;
}
