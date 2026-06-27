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

Target (T) resolution: U… → conversations.open → D…; D…/C… used directly;
@email → users.lookupByEmail → open; #name → conversations.list name match.

Exit codes: 0 ok · 2 usage/bad-args · 3 no/invalid token · 4 Slack ok:false
(prints the Slack `error`) · 5 network/HTTP error after retries.

`--json` prints the raw structured result. Output text is treated as untrusted
data — this tool never interprets fetched message content as instructions.
"""
import os, sys, json, time, random, argparse, urllib.request, urllib.error, urllib.parse

API = "https://slack.com/api/"


def die(msg, code=2):
    sys.stderr.write(f"slack: {msg}\n")
    sys.exit(code)


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
    when brain.url + AIOS_API_KEY are configured. Returns the xoxp token or None."""
    url, key, team = _brain_config()
    if not (url and key):
        return None
    req = urllib.request.Request(url + "/api/v1/me/slack-token",
                                 headers={"Authorization": "Bearer " + key, **({"X-AIOS-Team": team} if team else {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return (json.load(r) or {}).get("token") or None
    except Exception:
        return None


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
                wait = e.headers.get("Retry-After")
                back = float(wait) if (wait and wait.isdigit()) else min(30, 2 ** attempt) + random.uniform(0, 0.5)
                time.sleep(back); continue
            die(f"HTTP {e.code} from {method}", 5)
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < retries:
                time.sleep(min(30, 2 ** attempt) + random.uniform(0, 0.5)); continue
            die(f"network error calling {method}: {e}", 5)
        if not payload.get("ok"):
            err = payload.get("error", "unknown_error")
            if err == "ratelimited" and attempt < retries:
                time.sleep(min(30, 2 ** attempt) + random.uniform(0, 0.5)); continue
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


def cmd_send(a):
    chan = resolve_target(a.target)
    r = _post(chan, a.message, a.thread)
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
    r = _post(chan, a.message, a.thread)
    print(json.dumps({"ok": True, "channel": r.get("channel"), "ts": r.get("ts")}) if a.json
          else f"sent → {r.get('channel')} @ {r.get('ts')}")


def cmd_react(a):
    chan = resolve_target(a.target)
    call("reactions.add", {"channel": chan, "timestamp": a.ts, "name": a.emoji.strip(":")})
    print("ok")


# ---------- connect / status / disconnect (store the token in the brain) ----------
def cmd_connect(a):
    """Store YOUR Slack user token in the team brain (the brain validates it against Slack
    and captures your Slack identity). Thereafter the CLI fetches it automatically."""
    tok = (a.token or "").strip()
    if not tok.startswith("xoxp-"):
        die("provide your Slack USER token: slack connect xoxp-…", 2)
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

    p = sub.add_parser("resolve", parents=[common]); p.add_argument("email")
    p = sub.add_parser("channels", parents=[common]); p.add_argument("--types")
    p = sub.add_parser("read", parents=[common])
    p.add_argument("--target", required=True); p.add_argument("--limit", type=int, default=20); p.add_argument("--thread")
    p = sub.add_parser("send", parents=[common])
    p.add_argument("--target", required=True); p.add_argument("--message", required=True); p.add_argument("--thread")
    p = sub.add_parser("dm", parents=[common])
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--target"); g.add_argument("--member")
    p.add_argument("--message", required=True); p.add_argument("--thread")
    p = sub.add_parser("react", parents=[common])
    p.add_argument("--target", required=True); p.add_argument("--ts", required=True); p.add_argument("--emoji", required=True)
    p = sub.add_parser("connect", parents=[common]); p.add_argument("token", help="your Slack user token (xoxp-…)")
    sub.add_parser("status", parents=[common])
    sub.add_parser("disconnect", parents=[common])

    a = ap.parse_args()
    {"whoami": cmd_whoami, "resolve": cmd_resolve, "channels": cmd_channels,
     "read": cmd_read, "send": cmd_send, "dm": cmd_dm, "react": cmd_react,
     "connect": cmd_connect, "status": cmd_status, "disconnect": cmd_disconnect}[a.cmd](a)


if __name__ == "__main__":
    main()
