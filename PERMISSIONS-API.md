# Per-session approval settings

`GET /api/threads/:id/permissions` reads the saved preference. `PUT` accepts
`{"mode":"auto"}`, `{"mode":"manual"}`, `{"mode":"bypass"}`, or `{"mode":null}`.
The routes require the existing Viewer browser login, and PUT requires the
Viewer origin. They are not exposed through the agent MCP or vault plugin.

| Mode | Reviewer | Approval policy | Sandbox |
| --- | --- | --- | --- |
| auto | Native automatic reviewer | on-request | workspace-write |
| manual | User | on-request | workspace-write |
| bypass | User (no approval requests) | never | danger-full-access |
| null | Follow configured reviewer | on-request | workspace-write |

Bypass disables both approval requests and sandbox restrictions for subsequent
turns. It does not override host or organization restrictions; a native backend
rejection is propagated. Manual mode avoids model-based approval while retaining
the workspace sandbox.

Settings are persisted per native Codex thread under `thread-permissions` in the
Viewer data directory. Hybrid IDs resolve to the selected native thread; a new
runtime binding or delegated child does not inherit bypass. This API currently
rejects Google threads. New threads retain existing defaults.

The response includes `effectiveOn: "nextTurn"`: it reports the preference,
not evidence that a running native turn changed. End or interrupt active turns
and pause active Goals/Watchdogs before PUT. Busy, uncertain, or approval-pending
threads return 409. Subsequent normal turns, Goal activation, and thread resume
pass the chosen settings to Codex. Resetting to auto/manual restores the
workspace sandbox in those requests. Existing actions are never replayed.

This patch adds the HTTP API only; no browser selector is included.
