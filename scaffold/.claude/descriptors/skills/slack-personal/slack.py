#!/usr/bin/env python3
"""
slack.py — a tiny, zero-dependency Slack CLI that acts as the authenticated user
(John), gateway-free. It talks straight to the Slack Web API over HTTPS using a
USER token (xoxp-…), so messages appear as the user and replies land in the user's
own DMs. Stdlib only — runs under a bare `python3` (e.g. on the Hermes box, where
the token is injected per-invocation by the setuid `cred-exec` wrapper).

This is NOT the Hermes Slack *gateway adapter* (gateway/platforms/slack.py), which
uses a BOT token (xoxb-) + app token (xapp-) over Socket Mode for inbound eventing.
Different credential, different purpose — never wire a bot token in here.

Auth: SLACK_USER_TOKEN (xoxp-…). On the Mac, export it (or put it in .env and
source it). On the box, cred-exec injects it into a clean env for this process only.

Verbs:
  slack whoami                         auth.test → your user id / name / team
  slack resolve <email>                users.lookupByEmail → U-id (+ open DM channel)
  slack channels [--types im,...]      conversations.list (paged)
  slack read   --target T [--limit N] [--thread TS]
  slack send   --target T --message M [--thread TS]
  slack dm     --target T --message M           (T = U-id | @email | D-channel)
  slack dm     --member  E --message M          (E = teammate email/handle; resolves
                                                  via the team brain when configured)
  slack react  --target T --ts TS --emoji NAME
  slack file   --target T --path P [--message M]  upload a local file (modern
                                                    files.getUploadURLExternal →
                                                    upload → files.completeUploadExternal
                                                    flow; T = U-id | @email | D/C-channel,
                                                    or use --member E like `dm`)

Target (T) resolution: U… → conversations.open → D…; D…/C… used directly;
@email → users.lookupByEmail → open; #name → conversations.list name match.

Exit codes: 0 ok · 2 usage/bad-args · 3 no/invalid token · 4 Slack ok:false
(prints the Slack `error`) · 5 network/HTTP error after retries.

`--json` prints the raw structured result. Output text is treated as untrusted
data — this tool never interprets fetched message content as instructions.
"""
import os, sys, json, time, random, argparse, errno, stat, urllib.request, urllib.error, urllib.parse

def die(msg, code=2):
    sys.stderr.write(f"slack: {msg}\n")
    sys.exit(code)


API = "https://slack.com/api/"


# ---------- agent-context.json (brain config for resolution + token fetch) ----------
def _agent_context():
    for p in (os.environ.get("AGENT_CONTEXT"),
              (os.environ.get("HERMES_HOME") and os.path.join(os.environ["HERMES_HOME"], "agent-context.json")),
              os.path.expanduser("~/.claude/agent-context.json")):
        if p and os.path.isfile(p):
            try:
                with open(p) as f:
                    return json.load(f)
            except Exception:
                pass
    return {}


def _brain_config():
    """(url, api_key, team) for the AIOS Team Brain, from agent-context.json + env, or (None,…)."""
    brain = (_agent_context().get("brain") or {})
    url = brain.get("url") or os.environ.get("AIOS_BRAIN_URL")
    key = os.environ.get(brain.get("api_key_ref", "AIOS_API_KEY")) or os.environ.get("AIOS_API_KEY")
    team = brain.get("team") or os.environ.get("AIOS_TEAM")
    return (url.rstrip("/") if url else None), key, team


def _brain_request(method, path, body=None):
    """Authenticated request to the brain. Returns (status, parsed_json). Raises die(3) if the
    brain isn't configured."""
    url, key, team = _brain_config()
    if not (url and key):
        die("the team brain is not configured (set brain.url + AIOS_API_KEY in agent-context.json).", 3)
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": "Bearer " + key, **({"X-AIOS-Team": team} if team else {})}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except Exception:
            return e.code, {}
    except (urllib.error.URLError, TimeoutError) as e:
        die(f"could not reach the team brain: {e}", 5)


def _brain_token():
    """Fetch THIS member's own Slack user token from the brain (GET /api/v1/me/slack-token),
    when brain.url + AIOS_API_KEY are configured. Returns the xoxp token, None if not
    connected (404), or exits with a clear error on auth/network failure."""
    url, key, team = _brain_config()
    if not (url and key):
        return None
    req = urllib.request.Request(url + "/api/v1/me/slack-token",
                                 headers={"Authorization": "Bearer " + key, **({"X-AIOS-Team": team} if team else {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return (json.load(r) or {}).get("token") or None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        msg = None
        try:
            body = json.load(e)
            err = body.get("error")
            msg = err.get("message") if isinstance(err, dict) else err
        except Exception:
            pass
        die(f"team brain token fetch failed (HTTP {e.code}{': ' + msg if msg else ''})", 3)
    except (urllib.error.URLError, TimeoutError) as e:
        die(f"could not reach the team brain for token: {e}", 5)


_TOKEN = None
def token():
    """Resolve the Slack user token: (1) SLACK_USER_TOKEN env (box cred-exec / Mac .env — preferred),
    (2) the member's own token from the brain, (3) error. Cached in-process; never written to disk."""
    global _TOKEN
    if _TOKEN:
        return _TOKEN
    _TOKEN = os.environ.get("SLACK_USER_TOKEN", "").strip() or _brain_token()
    if not _TOKEN:
        die("no Slack token: set SLACK_USER_TOKEN, or connect via `aios connect slack` so the brain holds it.", 3)
    # Catches a common footgun: `export SLACK_USER_TOKEN=$(dotenvx run -- printenv KEY)` (or similar
    # command-substitution wrapping) captures the wrapper's own log banner into the value alongside the
    # real token, embedding a control character mid-string. That corrupts the Authorization header and,
    # uncaught, dumps the raw (secret-bearing) header value in a Python traceback. Fail fast here instead,
    # with a message that never echoes the value itself.
    if any(c in _TOKEN for c in ("\n", "\r", "\t")) or not _TOKEN.startswith(("xoxp-", "xoxb-")):
        die("SLACK_USER_TOKEN looks malformed (embedded whitespace/control chars, or missing xoxp-/xoxb- "
            "prefix) — likely picked up extra output from a wrapper command (e.g. `dotenvx run -- printenv "
            "...` captures dotenvx's own log banner into the value). Export the token directly, or run this "
            "CLI itself under the wrapper (`dotenvx run --quiet -- slack ...`) instead of capturing its "
            "output into a variable. Value intentionally not shown.", 2)
    return _TOKEN


# ---------- Slack Web API ----------
def call(method, params=None, retries=4):
    """POST a Slack Web API method (form-encoded, Bearer user token). Returns the
    parsed JSON. Retries 429/5xx with backoff honoring Retry-After. Exits 4 on
    ok:false, 5 on network failure."""
    body = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None}).encode()
    headers = {"Authorization": "Bearer " + token(),
               "Content-Type": "application/x-www-form-urlencoded"}
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(API + method, data=body, headers=headers)
            with urllib.request.urlopen(req, timeout=45) as r:
                payload = json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                time.sleep(_retry_delay(e, attempt)); continue
            die(f"HTTP {e.code} from {method}", 5)
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < retries:
                time.sleep(_retry_delay(None, attempt)); continue
            die(f"network error calling {method}: {e}", 5)
        except ValueError:
            # e.g. "Invalid header value" — Python's own ValueError embeds the offending header
            # (which contains the bearer token) in its message/repr. Never let that reach stdout/stderr
            # or an uncaught traceback; die() here prints only this fixed, secret-free string.
            die(f"malformed HTTP request calling {method} (bad token or header value — value not shown; "
                "check SLACK_USER_TOKEN for stray whitespace/control characters)", 5)
        if not payload.get("ok"):
            err = payload.get("error", "unknown_error")
            if err == "ratelimited" and attempt < retries:
                time.sleep(_retry_delay(None, attempt)); continue
            if err in ("invalid_auth", "not_authed", "token_revoked", "account_inactive"):
                die(f"Slack auth failed ({err}) — check SLACK_USER_TOKEN.", 3)
            die(f"Slack API error on {method}: {err}", 4)
        return payload
    die(f"exhausted retries on {method}", 5)


# ---------- team-brain resolver (optional; congruent with aios-team-brain) ----------
def brain_resolve_slack(member):
    """Resolve a teammate (email or handle) to a Slack U-id via the team brain's
    /api/v1/identities/resolve endpoint, when brain.url + AIOS_API_KEY are configured.
    Returns a U-id or None (caller falls back to Slack's own lookup)."""
    url, key, team = _brain_config()
    if not (url and key):
        return None
    q = {"provider": "slack"}
    q["email" if "@" in member else "handle"] = member
    req = urllib.request.Request(url + "/api/v1/identities/resolve?" + urllib.parse.urlencode(q),
                                 headers={"Authorization": "Bearer " + key, **({"X-AIOS-Team": team} if team else {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
    except Exception:
        return None
    # endpoint returns the member's identities; pick the slack external_id
    for ident in (data.get("identities") or []):
        if ident.get("provider") == "slack" and ident.get("external_id"):
            return ident["external_id"]
    return data.get("slack_id") or None


# ---------- target resolution ----------
def open_dm(user_id):
    return call("conversations.open", {"users": user_id})["channel"]["id"]


def resolve_target(target):
    """Map a CLI target to a postable channel id (D…/C…)."""
    if not target:
        die("missing --target")
    if target.startswith("@") and "@" in target[1:]:        # @email
        target = target[1:]
    if "@" in target and not target.startswith(("U", "W", "C", "D", "G")):  # bare email
        uid = call("users.lookupByEmail", {"email": target})["user"]["id"]
        return open_dm(uid)
    if target[0] in ("U", "W"):                              # user id → DM
        return open_dm(target)
    if target[0] in ("C", "D", "G"):                         # channel/DM/group id → direct
        return target
    if target.startswith("#"):                               # channel name
        name = target[1:]
        cur = ""
        while True:
            page = call("conversations.list", {"types": "public_channel,private_channel",
                                               "limit": 1000, "cursor": cur or None})
            for c in page.get("channels", []):
                if c.get("name") == name:
                    return c["id"]
            cur = (page.get("response_metadata") or {}).get("next_cursor") or ""
            if not cur:
                break
        die(f"channel #{name} not found")
    die(f"unrecognized target: {target}")


# ---------- verbs ----------
def cmd_whoami(a):
    r = call("auth.test")
    if a.json:
        print(json.dumps(r, indent=2))
    else:
        print(f"{r.get('user')} ({r.get('user_id')}) on team {r.get('team')} ({r.get('team_id')})")


def cmd_resolve(a):
    if a.member:
        uid = brain_resolve_slack(a.member)
        if not uid:
            die(f"could not resolve teammate '{a.member}' (no brain match; try the email form instead)", 4)
        chan = open_dm(uid)
        if a.json:
            print(json.dumps({"id": uid, "dm_channel": chan}, indent=2))
        else:
            print(f"{a.member} → {uid} (dm: {chan})")
        return
    r = call("users.lookupByEmail", {"email": a.email})
    u = r["user"]
    if a.json:
        print(json.dumps({"id": u["id"], "name": u.get("name"),
                          "real_name": u.get("real_name"), "team_id": u.get("team_id")}, indent=2))
    else:
        print(f"{u.get('real_name') or u.get('name')} → {u['id']}")


def cmd_channels(a):
    types = a.types or "im,public_channel"
    out, cur = [], ""
    while True:
        page = call("conversations.list", {"types": types, "limit": 1000, "cursor": cur or None})
        out.extend(page.get("channels", []))
        cur = (page.get("response_metadata") or {}).get("next_cursor") or ""
        if not cur:
            break
    if a.json:
        print(json.dumps(out, indent=2))
    else:
        for c in out:
            label = c.get("name") or (c.get("user") if c.get("is_im") else c.get("id"))
            print(f"{c['id']}\t{'im' if c.get('is_im') else 'channel'}\t{label}")


def cmd_read(a):
    chan = resolve_target(a.target)
    if a.thread:
        r = call("conversations.replies", {"channel": chan, "ts": a.thread, "limit": a.limit})
    else:
        r = call("conversations.history", {"channel": chan, "limit": a.limit})
    msgs = r.get("messages", [])
    if a.json:
        print(json.dumps(msgs, indent=2))
    else:
        for m in reversed(msgs):
            who = m.get("user") or m.get("username") or m.get("bot_id") or "?"
            print(f"[{m.get('ts')}] {who}: {(m.get('text') or '').replace(chr(10), ' ')}")


def _post(chan, text, thread=None):
    return call("chat.postMessage", {"channel": chan, "text": text,
                                     "thread_ts": thread, "as_user": "true"})


def message_arg(a):
    """Read multiline message text without requiring shell escaping."""
    if getattr(a, "message_stdin", False):
        message = sys.stdin.read()
        if not message:
            die("--message-stdin received empty input", 2)
        return message
    return a.message


def cmd_send(a):
    chan = resolve_target(a.target)
    r = _post(chan, message_arg(a), a.thread)
    print(json.dumps({"ok": True, "channel": r.get("channel"), "ts": r.get("ts")}) if a.json
          else f"sent → {r.get('channel')} @ {r.get('ts')}")


def cmd_dm(a):
    if a.member:
        uid = brain_resolve_slack(a.member)
        if uid:
            chan = open_dm(uid)
        elif "@" in a.member:                     # fall back to Slack's own email lookup
            chan = resolve_target(a.member)
        else:
            die(f"could not resolve teammate '{a.member}' (no brain match and not an email)", 4)
    else:
        chan = resolve_target(a.target)
    r = _post(chan, message_arg(a), a.thread)
    print(json.dumps({"ok": True, "channel": r.get("channel"), "ts": r.get("ts")}) if a.json
          else f"sent → {r.get('channel')} @ {r.get('ts')}")


def _assert_uploadable_url(url):
    """Refuse an upload URL that is not https (or http on loopback, for tests).

    This POST carries the FILE CONTENTS, so wherever this URL points is where the file goes.
    urlopen honours file:, ftp: and anything else urllib has a handler for, and the URL is not
    ours — it arrives in a Slack API response. A tampered or spoofed response naming
    `file:///…` or an attacker's host turns "upload this to Slack" into "write/send this
    somewhere else", with no prompt and no log line, since the URL is deliberately never
    printed.

    https is the only thing Slack actually returns. http is permitted solely for loopback, so
    the credential-free mock suite can exercise the real code path — a mock cannot leave the
    machine.
    """
    parsed = urllib.parse.urlparse(url or "")
    host = parsed.hostname or ""
    if parsed.scheme == "https":
        return
    if parsed.scheme == "http" and host in ("127.0.0.1", "localhost", "::1"):
        return
    # Names the SCHEME, never the URL: the URL is single-use and credential-bearing.
    die(f"refusing to upload to a non-https URL (scheme '{parsed.scheme or "none"}')", 5)


def _upload_bytes(upload_url, data):
    """PUT/POST the raw file bytes to the short-lived URL from files.getUploadURLExternal.

    RAW BYTES, NOT MULTIPART. Slack accepts either, and raw is the safer of the two here:
    the multipart form requires hand-building a `Content-Disposition` header containing the
    filename, and a filename is attacker-influenced data in exactly the places this CLI gets
    used (a downloaded attachment, a generated report, anything with a quote or a newline in
    its name). Interpolating it into a header is header injection waiting to happen, and there
    is no escaping rule that makes it safe. Raw bytes carry no filename at all — the name is
    passed as a JSON parameter to getUploadURLExternal/completeUploadExternal, where it is data.

    This URL is NOT a Slack Web API method — no Bearer token, no ok:false envelope — so it does
    not go through call(); failures are network/HTTP only (exit 5). The URL is single-use and
    credential-bearing: it is never logged, not even on error.
    """
    _assert_uploadable_url(upload_url)
    # Content-Length is set by urllib from `data`; setting it here too sends it twice, which
    # some servers reject and others hang on.
    headers = {"Content-Type": "application/octet-stream"}
    for attempt in range(4):
        req = urllib.request.Request(upload_url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                r.read()
            return
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(_retry_delay(e, attempt))
                continue
            # Deliberately does NOT include the URL or the response body: the URL is a
            # credential and the body is Slack's, not ours, to echo.
            die(f"HTTP {e.code} uploading file bytes to Slack's upload URL", 5)
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < 3:
                time.sleep(_retry_delay(None, attempt))
                continue
            die(f"network error uploading file bytes: {e}", 5)
    die("exhausted retries uploading file bytes", 5)


def _retry_delay(err, attempt):
    """Honour Slack's Retry-After when it sends one; otherwise exponential backoff + jitter.

    Slack states a rate limit precisely, and guessing longer wastes time while guessing shorter
    earns another 429 — so a well-formed header always wins. `isdigit()` rather than
    try/float/except: Retry-After is defined as whole seconds, and a malformed value should fall
    through to backoff rather than be silently swallowed by a bare `pass`.

    Every retry path in this file routes through here — the Web API and the upload URL cannot
    drift apart on backoff behaviour, and there is exactly one randomness call site to reason
    about. That site uses SystemRandom: jitter does not need cryptographic randomness, but the
    default Mersenne Twister earns a static-analysis finding on every use, and one seeded-RNG
    exemption to argue about is one too many for a decorrelation nudge.
    """
    headers = getattr(err, "headers", None) if err is not None else None
    raw = headers.get("Retry-After") if headers else None
    if raw and str(raw).strip().isdigit():
        return max(0.0, min(60.0, float(str(raw).strip())))
    return min(30, 2 ** attempt) + random.SystemRandom().uniform(0, 0.5)


# Deliberate, documented cap. Slack itself allows far more, but this CLI buffers the whole file
# in memory to compute Content-Length, so "what Slack allows" is the wrong limit — an agent
# pointed at a multi-GB file should get a clear refusal, not an OOM. Raise it knowingly if a real
# workflow needs more; do not raise it to match Slack's own maximum.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024


# O_NONBLOCK matters as much as O_NOFOLLOW: opening a FIFO read-only WITHOUT it blocks until a
# writer appears, so the process hangs before any check can run. (Verified: a mkfifo target hung
# the CLI indefinitely.)
LEAF_FLAGS = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)


def _die_open(err, shown):
    if err.errno in (errno.ELOOP, errno.EMLINK):
        die(f"refusing to upload through a symlink: {shown} (copy the file instead)", 2)
    if err.errno == errno.ENOENT:
        die(f"no such file: {shown}", 2)
    if err.errno in (errno.ENOTDIR, errno.ENXIO):
        die(f"not a regular file: {shown}", 2)
    die(f"cannot open {shown}: {err.strerror}", 2)


def _realpath_or_none(p):
    """realpath(p), or None when it cannot be resolved. A failure means "this prefix is not the
    workspace root", which is exactly what None says — no silent skip needed."""
    try:
        return os.path.realpath(p)
    except OSError:
        return None


def _is_symlink_at(name, dir_fd):
    """True when `name` under `dir_fd` is a symlink. Used ONLY to word an error message, so a
    failure to tell resolves to False: the refusal has already happened either way."""
    try:
        return stat.S_ISLNK(os.lstat(name, dir_fd=dir_fd).st_mode)
    except OSError:
        return False


def _components_under_root(path, root):
    """Split `path` into the literal components that sit BELOW `root`, or None if it escapes.

    ONLY THE ANCHOR IS RESOLVED, NEVER THE TAIL, and that asymmetry is the entire point.

    Resolving the anchor is required because `getcwd()` is canonical (`/private/var/...`) while
    a caller may legitimately spell the same directory `/var/...`. A lexical comparison rejects
    an in-workspace file given its absolute path — a bug this had, caught by testing three
    spellings of one file.

    Keeping the TAIL literal is equally required. An earlier version resolved the whole path and
    walked the RESULT, which meant O_NOFOLLOW never saw a symlink that resolved inside the
    workspace: a planted `report.txt -> .env` was silently replaced by `.env` before the walk
    began, and uploaded. Resolving the tail destroys the very evidence the walk exists to check.

    So: find the deepest prefix of the caller's path whose realpath IS the root, and return the
    remaining components exactly as the caller spelled them.
    """
    parts = os.path.abspath(path).split(os.sep)
    for i in range(len(parts), 0, -1):
        prefix = os.sep.join(parts[:i]) or os.sep
        if _realpath_or_none(prefix) == root:
            return [c for c in parts[i:] if c not in ("", ".")]
    return None


def _open_contained(path, allow_outside=False):
    """Open `path` for reading, guaranteeing it lives inside the working directory.

    CHECKING AND OPENING ARE ONE OPERATION HERE, deliberately. An earlier version resolved the
    path, compared it to the workspace, then opened the ORIGINAL path — two lookups, so an
    attacker able to write an intermediate directory swaps it for a symlink in between and the
    descriptor lands outside the workspace regardless of what the check concluded. Verifying a
    path and opening a path are not the same act unless a descriptor carries the guarantee
    forward.

    The workspace root is opened ONCE, and every caller-spelled component below it is opened
    relative to the previous descriptor with O_NOFOLLOW. Nothing can be swapped out from under a
    descriptor already held, and a symlink anywhere below the root — whether it points inside
    the workspace or outside it — fails at the step that opens it.

    Pinning the root by realpath is what makes the walk viable at all: a bare walk from `/`
    refuses every path under a temp directory on macOS, where /var, /tmp and /etc are themselves
    symlinks.

    `..` is refused rather than normalised: collapsing `a/../b` lexically is wrong precisely when
    `a` is a symlink.

    FAILS CLOSED. If the platform cannot do openat or O_NOFOLLOW, containment cannot be enforced,
    so the upload is refused rather than quietly downgraded — a silent downgrade is how a control
    becomes decorative. `--allow-outside-workspace` remains the one way to opt out, and it has to
    be typed.
    """
    if allow_outside:
        try:
            return os.open(path, LEAF_FLAGS)
        except OSError as e:
            _die_open(e, path)

    if os.open not in getattr(os, "supports_dir_fd", set()) or not getattr(os, "O_NOFOLLOW", 0):
        die(
            "cannot enforce workspace containment on this platform (no openat/O_NOFOLLOW), so "
            "this upload is refused rather than silently unprotected. Pass "
            "--allow-outside-workspace to upload anyway, knowingly.",
            2,
        )

    root = os.getcwd()  # already canonical: getcwd() resolves symlinks
    parts = _components_under_root(path, root)
    if parts is None or any(c == ".." for c in parts):
        die(
            "refusing to upload a file that resolves outside this workspace:\n"
            f"  named:     {path}\n"
            f"  resolves:  {os.path.realpath(os.path.abspath(path))}\n"
            f"  workspace: {root}\n"
            "Pass --allow-outside-workspace if that is deliberate.",
            2,
        )
    if not parts:
        die(f"not a regular file: {path}", 2)

    dir_fd = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        for comp in parts[:-1]:
            try:
                nxt = os.open(comp, DIR_FLAGS, dir_fd=dir_fd)
            except OSError as e:
                # macOS reports ENOTDIR (not ELOOP) for O_NOFOLLOW|O_DIRECTORY on a symlink, so
                # the generic mapping would say "not a regular file" for a symlinked directory —
                # true, useless, and actively misleading on a security refusal. lstat is used for
                # the MESSAGE only; the refusal already happened.
                if e.errno == errno.ENOTDIR and _is_symlink_at(comp, dir_fd):
                    die(
                        f"refusing to upload through a symlinked directory: {path} "
                        f"(component '{comp}' is a symlink)",
                        2,
                    )
                _die_open(e, path)
            os.close(dir_fd)
            dir_fd = nxt
        try:
            return os.open(parts[-1], LEAF_FLAGS, dir_fd=dir_fd)
        except OSError as e:
            _die_open(e, path)
    finally:
        os.close(dir_fd)


def _read_upload_candidate(path, allow_outside=False):
    """Open, validate and read a file on ONE descriptor. Returns (bytes, filename).

    Every check here is against the OPENED FILE, never the path, because this CLI's whole job
    is to put bytes into a channel other people can read. Checking a path and then opening it
    is two different files whenever anything can write the directory between the two calls:
    stat a harmless 1KB note, upload whatever replaced it. Same reason the size cap is enforced
    on the bytes actually read rather than on a previously-stat'd size.

    O_NOFOLLOW refuses a symlinked final component outright. That is stricter than "resolve it
    and check the target" on purpose — a resolved target is still only true until read() — and
    it costs a real user one `cp` while removing "upload this innocuous-looking link" entirely.

    O_NOFOLLOW guards only the FINAL component, which is not the interesting attack:
    `reports/ -> ~/.ssh` plus an upload of `reports/id_rsa` sails straight past it. Containment
    closes that, and `_open_contained()` does the containment and the open as ONE descriptor
    walk so there is no window between deciding a path is safe and opening it.
    """
    fd = _open_contained(path, allow_outside=allow_outside)

    # Type-check the RAW descriptor before handing it to fdopen: fdopen on a directory raises
    # IsADirectoryError, which would surface as an unhandled internal error instead of a usage
    # message. fstat cannot be fooled by the path changing underneath us.
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            os.close(fd)
            die(f"not a regular file: {path}", 2)
    except OSError as e:
        os.close(fd)
        die(f"cannot stat {path}: {e.strerror}", 2)

    with os.fdopen(fd, "rb") as f:
        # Read one byte past the cap so an oversized file is detected from the bytes themselves,
        # not from a size that was true a moment ago.
        data = f.read(MAX_UPLOAD_BYTES + 1)

    if not data:
        # completeUploadExternal rejects a zero-length upload with an opaque error.
        die(f"refusing to upload an empty file: {path}", 2)
    if len(data) > MAX_UPLOAD_BYTES:
        die(
            f"file exceeds this CLI's {MAX_UPLOAD_BYTES}-byte upload cap ({path}). "
            f"The whole file is buffered in memory to set Content-Length.",
            2,
        )
    return data, os.path.basename(path)


def cmd_file(a):
    # Read and validate FIRST: a refusal must not have spoken to Slack at all, and resolving a
    # channel for a file we are about to reject is a wasted API call with a side effect (open_dm
    # creates the DM conversation).
    data, filename = _read_upload_candidate(a.path, allow_outside=a.allow_outside_workspace)

    if a.member:
        uid = brain_resolve_slack(a.member)
        if uid:
            chan = open_dm(uid)
        elif "@" in a.member:
            chan = resolve_target(a.member)
        else:
            die(f"could not resolve teammate '{a.member}' (no brain match and not an email)", 4)
    else:
        chan = resolve_target(a.target)

    got = call("files.getUploadURLExternal", {"filename": filename, "length": len(data)})
    upload_url, file_id = got.get("upload_url"), got.get("file_id")
    if not (upload_url and file_id):
        die("files.getUploadURLExternal did not return upload_url/file_id", 4)

    _upload_bytes(upload_url, data)

    complete = call("files.completeUploadExternal", {
        "files": json.dumps([{"id": file_id, "title": filename}]),
        "channel_id": chan,
        "initial_comment": a.message,
    })
    files_out = complete.get("files", [])
    print(json.dumps({"ok": True, "channel": chan, "files": files_out}) if a.json
          else f"uploaded → {chan}: {filename} ({files_out[0].get('id') if files_out else file_id})")


def cmd_react(a):
    chan = resolve_target(a.target)
    call("reactions.add", {"channel": chan, "timestamp": a.ts, "name": a.emoji.strip(":")})
    print("ok")


# ---------- connect / status / disconnect (store the token in the brain) ----------
def _connect_token(a):
    """Resolve a connect token without leaving it in argv when --stdin or env is used."""
    if a.stdin:
        return sys.stdin.read().strip()
    if a.token:
        return a.token.strip()
    return os.environ.get("SLACK_USER_TOKEN", "").strip()


def cmd_connect(a):
    """Store YOUR Slack user token in the team brain (the brain validates it against Slack
    and captures your Slack identity). Thereafter the CLI fetches it automatically."""
    tok = _connect_token(a)
    if not tok:
        die("provide your Slack USER token: slack connect --stdin | SLACK_USER_TOKEN=… slack connect | slack connect xoxp-…", 2)
    if not tok.startswith("xoxp-"):
        die("token must be a Slack USER token (xoxp-…)", 2)
    status, resp = _brain_request("POST", "/api/v1/me/slack-token", {"token": tok})
    if status >= 400 or not resp.get("ok"):
        die(f"connect failed: {(resp.get('error') or {}).get('message') if isinstance(resp.get('error'), dict) else resp.get('error') or status}", 4)
    print(json.dumps(resp) if a.json
          else f"connected as {resp.get('slack_user_id')} in workspace {resp.get('workspace')}")


def cmd_status(a):
    status, resp = _brain_request("GET", "/api/v1/me/slack-token")
    connected = status < 400 and resp.get("connected")
    out = {"connected": bool(connected), "slack_user_id": resp.get("slack_user_id"),
           "workspace": resp.get("workspace")}
    print(json.dumps(out) if a.json
          else (f"connected as {out['slack_user_id']} in {out['workspace']}" if connected
                else "not connected — run: slack connect xoxp-… (or `aios connect slack`)"))


def cmd_disconnect(a):
    _brain_request("DELETE", "/api/v1/me/slack-token")
    print("disconnected")


def main():
    ap = argparse.ArgumentParser(prog="slack", description="Send/read Slack as the authenticated user (xoxp).")
    # --json is accepted both before the verb (slack --json send …) and after it
    # (slack send … --json) via a shared parent parser.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", help="raw JSON output")
    ap.add_argument("--json", action="store_true", help="raw JSON output")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("whoami", parents=[common])

    p = sub.add_parser("resolve", parents=[common])
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("email", nargs="?", help="teammate email (Slack users.lookupByEmail)")
    g.add_argument("--member", help="teammate handle/name, resolved via the team brain (read-only, sends nothing)")
    p = sub.add_parser("channels", parents=[common]); p.add_argument("--types")
    p = sub.add_parser("read", parents=[common])
    p.add_argument("--target", required=True); p.add_argument("--limit", type=int, default=20); p.add_argument("--thread")
    p = sub.add_parser("send", parents=[common])
    p.add_argument("--target", required=True)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--message")
    g.add_argument("--message-stdin", action="store_true", help="read the complete message from stdin")
    p.add_argument("--thread")
    p = sub.add_parser("dm", parents=[common])
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--target"); g.add_argument("--member")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--message")
    g.add_argument("--message-stdin", action="store_true", help="read the complete message from stdin")
    p.add_argument("--thread")
    p = sub.add_parser("file", parents=[common])
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--target"); g.add_argument("--member")
    p.add_argument("--path", required=True, help="local file path to upload")
    p.add_argument(
        "--allow-outside-workspace",
        action="store_true",
        help="permit a file that resolves outside the cwd (e.g. a generated file in a temp dir)",
    )
    p.add_argument("--message", help="initial_comment shown with the upload")
    p = sub.add_parser("react", parents=[common])
    p.add_argument("--target", required=True); p.add_argument("--ts", required=True); p.add_argument("--emoji", required=True)
    p = sub.add_parser("connect", parents=[common])
    p.add_argument("token", nargs="?", help="your Slack user token (xoxp-…); prefer --stdin or SLACK_USER_TOKEN")
    p.add_argument("--stdin", action="store_true", help="read token from stdin (avoids shell history/ps)")
    sub.add_parser("status", parents=[common])
    sub.add_parser("disconnect", parents=[common])

    a = ap.parse_args()
    {"whoami": cmd_whoami, "resolve": cmd_resolve, "channels": cmd_channels,
     "read": cmd_read, "send": cmd_send, "dm": cmd_dm, "react": cmd_react,
     "file": cmd_file,
     "connect": cmd_connect, "status": cmd_status, "disconnect": cmd_disconnect}[a.cmd](a)


if __name__ == "__main__":
    try:
        main()
    except (SystemExit, KeyboardInterrupt):
        raise
    except Exception as e:
        # Last-resort safety net: an unexpected exception's default traceback can include local
        # variables (headers, tokens) via str(e)/repr(e). Print only the exception type, never its
        # message, so a future bug here can't become a second token-leak incident like this one.
        die(f"unexpected error ({type(e).__name__}) — rerun with a fresh token if this persists", 5)
