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
| null | Follow Viewer default | on-request | workspace-write |

Bypass disables both approval requests and sandbox restrictions for subsequent
turns. It does not override host or organization restrictions; a native backend
rejection is propagated. Manual mode avoids model-based approval while retaining
the workspace sandbox.

Settings are persisted per native Codex or Antigravity thread under `thread-permissions` in the
Viewer data directory. Hybrid IDs resolve to the selected native thread; a new
runtime binding or delegated child does not inherit bypass. This API currently
supports both backends. New threads default to auto review.

The response includes `effectiveOn: "nextTurn"`: it reports the preference,
not evidence that a running native turn changed. End or interrupt active turns
and pause active Goals/Watchdogs before PUT. Busy, uncertain, or approval-pending
threads return 409. Subsequent normal turns, Goal activation, and thread resume
pass the chosen settings to the selected backend. Resetting to auto/manual restores the
workspace sandbox in those requests. Existing actions are never replayed.

The browser composer shows an approval selector next to Mode. Changes are saved
immediately for the next turn. The vault plugin does not expose this API.

## Viewer default and review failure recovery

`GET/PUT /api/permissions/default` reads or saves `{ "mode": "auto" | "manual" }` in `default-permissions.json`. An absent file means `auto`. Per-thread choices take precedence; a null choice follows this Viewer default, not the native CLI configuration. The browser exposes this under More actions → Default approval. Global bypass is not offered.

Native `item/autoApprovalReview/completed` notifications produce a failure prompt for capacity errors, transport errors, timeouts or denied assessments. Ordinary model errors and cancelled/stale reviews do not trigger a bypass prompt. The sidebar marks the affected session. A browser reload retains the prompt while the backend remains running; pending prompts are not persisted across backend restarts.

`POST /api/threads/:id/permissions/fallback` accepts `{ "failureId": "…", "mode": "manual" | "bypass" | "dismiss" }`. It requires the current failure ID and browser origin. Dismiss keeps the current policy. A switch pauses the Goal and active Watchdog, interrupts an active turn and verifies that it stopped, then saves the per-thread mode for the next turn. Failed/unconfirmed interruption leaves permissions unchanged. It does not approve or replay the failed operation, start a new turn, resume the Goal, or change the global default. These routes remain unavailable to agent MCP and the vault plugin.
