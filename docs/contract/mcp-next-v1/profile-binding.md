# Explicit profile destination verification — revision 1

A profile selects one canonical Brain origin, team and project UUID. Before accepting the binding, and again on each runtime read, tool listing or call, the client authenticates with that profile's credential reference and verifies the selected destination. It must not combine credential or destination fields from another profile, the current working directory, or unrelated environment variables.

`GET /api/v1/projects/{project_id}` uses the existing member API bearer credential and optional matching `X-AIOS-Team`. A successful uncached response is exactly `{ "project_id": "<UUID>", "team_id": "<UUID>" }`, derived from a current member/project authorization check. The client requires both IDs to match its explicit selection. The existing projects-list response remains unchanged.

Missing or invalid credentials return401. A missing, malformed, different-team or currently inaccessible destination returns404 with `not_found`; authorization substrate failure returns503 with `unavailable`. Responses use `Cache-Control: no-store`. An older server's404 means destination verification is unavailable; never silently accept a cached binding or infer a different project. Delegated credentials do not become member credentials.

This read confirms current destination access, not permission for every action. Effective capability remains the intersection of explicit local grants, current server advertisement, and current authorization/policy at invocation. Profile edit, grant revocation, credential rotation/removal and install recovery invalidate retained launch bindings through monotonically increasing generations. Restoration of old configuration must not reduce those generations or restore an old grant.

Guided profile installation requires a verifiable profile-capable installed artifact and its exact dependency closure. The currently public legacy descriptor cannot be treated as profile-capable. Local candidate acceptance is evidence only; publication and enablement remain separate release work.
