# Codex Viewer architecture

Codex Viewer is a local, single-user Vue application backed by the existing Node HTTP/SSE bridge and Codex App Server. Raw messages remain canonical. This migration adds component and state boundaries; runtime plugin loading is a future feature.

## Ownership and dependencies

```text
Vue components → viewer store → HTTP/SSE client → Node routes → App Server
                      ↓                           ↓
                    shared protocol and event reducer
```

| Module | Owns | Does not own |
| --- | --- | --- |
| `shared/protocol.ts` | Wire types, pure validation/helpers, item merging, event reduction | Vue, DOM, filesystem, network |
| `web/api.ts` | Typed requests, uploads, one SSE subscription per client, abort/dispose | Conversation caches or UI |
| `web/store.ts` | Canonical thread entities, selection, drafts, approvals, asynchronous operations | DOM nodes, visual layout |
| `web/App.vue` | One store instance, application lifecycle, hash navigation, persisted sidebar layout, component assembly | Protocol merging or a second connection |
| `web/components/` | Feature views, local dialog/selection/expanded state | Direct fetch/SSE or mutable copies of canonical threads |
| Rendering helpers | Markdown/source mapping, highlighting, link preview DOM | Agent instructions, history mutation, execution policy |
| `server/` | Authentication, authorization, persistence access, Codex connection and HTTP/SSE | Frontend presentation |

The store exposes readonly state and named operations. Components receive the application store through Vue provide/inject; there is no import-time store singleton. Presentation children use props and emitted events. Vue's built-in reactivity is sufficient for the current application; no router, state library, dependency-injection container or plugin registry is introduced.

Each loaded thread has one canonical entity. `currentId` and sidebar IDs reference that entity. Its draft owns text, attachments, selected skills, desired settings, loading/submission flags, uncertainty and errors. Pending approvals are keyed by request ID and retain their owning thread. Effective settings come from Codex; pending settings remain local until explicitly submitted.

## Requests, snapshots and events

All network operations go through the client. Selection and configuration reads use separate request scopes; a new request aborts the previous request in the same scope. List, usage and Watchdog reads join an existing request; event invalidations are batched and changes during a read request one follow-up. The initial SSE resync owns bootstrap reads. Completion checks both the request identity and the connection generation. The selection generation independently prevents a late A/B response from changing the user's latest choice.

Opening a thread buffers its events while the snapshot is in flight. The accepted snapshot replaces that thread and its approvals, then buffered events newer than its sequence are applied through the shared reducer. Other threads continue updating. Unknown approval-resolution events are retained for in-flight snapshots, so an approval first discovered in a snapshot cannot be resurrected after resolution.

SSE event IDs identify the server epoch. Delivered event sequences suppress duplicate deltas; snapshot watermarks are per thread and never discard another thread's updates. Offline notifications invalidate reads, and a changed epoch resets sequence tracking. A list refresh merges metadata without replacing live turns or effective settings; status is updated only if no live event or snapshot arrived during the read. Metadata changed during the list read takes precedence over its older response.

Metadata refresh preserves loaded sidebar IDs and the pagination cursor; loading another page has a separate read scope. Node drains SSE buffers normally, including frames larger than its high-water mark. A client exceeding 8,000,000 queued bytes is disconnected and recovers through replay or resync. Only content-hashed build assets receive private immutable browser caching; authentication is still checked on every server request.

Send, interrupt, approval and skill changes run only from explicit actions. Reconnects and mounting never retry them. A send timeout can mean Codex accepted the action: retain the draft, mark its state uncertain, and query state before another attempt. Browser request cancellation does not undo an already-accepted server action.

The sidebar's backend restart replaces the shared Codex child process while keeping the HTTP server, login cookies, uploads and browser drafts. The authenticated restart route checks foreground requests, approvals, scheduled checks and all native loaded threads before shutdown; unreadable or unsaved threads prevent restart. Admission and scheduling pause during the replacement. The adapter waits for the old process to close before launching its replacement with the same launch overrides. Existing offline/online events restore browser snapshots without replaying turns. This does not restart the Node bridge or support per-thread runtime replacement.

Watchdogs persist user-authorized recurring work in `watchdogs.sqlite` through Node's built-in SQLite. `server/watchdogs.ts` owns configuration revisions, atomic claims and immutable run snapshots; `server/main.ts` queries due tasks through a partial expression index and schedules them using the same thread lock, settings validation and native turn starter as interactive messages. One active run per thread is enforced by a SQLite unique index. Missed deadlines coalesce; run completion advances to a future deadline. A structured report remains provisional until native completion, and edits made after a claim take precedence over its outcome. Every thread-lock release reconciles completion received during a foreground RPC. Change notifications run after commit; a notification failure does not fail the saved write.

`server/watchdog-mcp.ts` exposes five built-in tools through a stdio server injected by App Server launch overrides. It forwards calls to an authenticated loopback route, using native `_meta.threadId` for ownership. Scheduled turns can read tasks and report their own result but cannot create or modify schedules. Only this local management server uses `default_tools_approval_mode="approve"`; execution retains native command/file approvals. Browser routes retain cookie, origin and authorized-root checks. Neither the bridge nor the scheduler changes global Codex configuration. Both old resumed and new threads receive the tools. The bridge owns its launch configuration; the generic adapter keeps per-instance additions out of forked title workers.

Each run persists its unique native message ID before submission. Lost acknowledgements are reconciled against native history; uncertain runs are paused without replay. Restart recovery checks unfinished runs before dispatching due tasks. A run saves the foreground settings and restores them under the shared thread lock; incoming watchdog settings do not replace browser drafts. SSE invalidations refresh the task list, while the editor keeps its local input on revision conflicts. Closing or switching dialog views clears local busy state and invalidates old read/write callbacks; an explicit default reasoning effort remains null when editing.

## Rendering and lifecycle

Vue owns component structure and stable keys. `MessageBody` owns an empty Markdown container whose descendants are managed exclusively by the existing renderer. `ActivityBlock` uses the existing highlighter on code containers; unchanged output keeps its DOM. No unsanitized message HTML enters Vue templates.

The transcript projects canonical items into detached display rows once per animation frame. The shared reducer replaces changed item identities; unchanged identities and turn status reuse rows before any serialization. A selection freezes this display projection while canonical state continues advancing. Clearing the selection schedules the latest projection. Following the latest message, manual scroll position and expanded command output retain their existing behavior. This scans loaded items; virtualization is deferred until long histories require it.

Streaming Markdown paints wait at least 100 ms between updates, with a longer gap after expensive paints. Completion flushes the latest source immediately unless selection is holding the display. Parsing, reference resolution and sanitization still process the full document; unchanged sanitized blocks reuse formatted HTML, including KaTeX output. Each active message cache holds at most 2,000,000 string code units and is cleared on completion, thread change or unmount. Source atoms are rebuilt from the current document, and deferred paints preserve active selections. Full parsing and DOM replacement remain the long-message ceiling.

Whole-message copying reads the displayed message's original source. Selection copying uses the renderer's source-position map. Link previews remain outside the transcript and do not enter copied text.

Mermaid fence completion comes from Markdown tokenizer events. `MessageBody` preserves diagram subtrees by source position and content while replacing surrounding Markdown. The transcript owns one lazy Mermaid renderer, serial layout queue and bounded SVG cache; each diagram view owns its observer registration, source toggle and Blob URL. Rendering waits until a completed fence approaches the viewport, and selection defers result insertion. Inline images, zoom and downloads share the same validated SVG. Leaving a thread aborts queued work and releases views; an in-flight layout retains its measuring DOM until it settles, then its obsolete result is discarded.

Every installation has a matching release:

- App unmount disposes its store, SSE connection and pending requests, and removes hash listeners.
- Transcript unmount cancels its animation frame, selection/copy listeners, preview fetch and popover.
- Dialog unmount cancels pending directory reads; activity timers exist only while running.
- Development entry replacement uses the same unmount path. Vite HMR is not runtime plugin loading.

## Adding a feature

1. Add a component at the existing shell, transcript, composer or dialog boundary. Keep local presentation state in that component.
2. Read shared context from the readonly store. Add a named store operation only when the feature changes shared state or calls the backend.
3. Put new HTTP behavior in the client and authorized Node route. Reuse the Codex adapter; components do not start agents or alter approval policy.
4. Reuse the existing source renderer/highlighter for message-like content. Keep derived presentation separate from original messages.
5. Release subscriptions, timers and temporary DOM on unmount. Test the real user behavior and any new ordering guarantees.

Future panel/message plugins can use these same boundaries. A first concrete plugin should establish the necessary loading, registration and disposal contract before a public SDK is published. Tool/service plugins will additionally need a backend lifecycle and permission model. This repository currently promises neither a stable third-party plugin API nor in-flight replacement of the Codex runtime.

## Verification and compatibility

`npm run build` checks Node/shared/test TypeScript, checks Vue SFC types with `vue-tsc`, and builds with Vite. `npm test` runs existing parser/server checks plus controlled asynchronous store tests. `npm run test:browser` covers production UI behavior and a Vite-backed real mount/unmount check, using simulated Codex throughout.

`node scripts/check-watchdogs.ts` is an opt-in live acceptance check using an isolated Codex home and a temporary local status file. It consumes two model turns to verify natural-language creation in a previously saved thread, then scheduled execution, reporting and completion. It cleans up its temporary task, history and copied authentication file.

Preserve HTTP/SSE wire formats, existing hash links, browser storage keys, attachment storage and startup commands. Browser tests retain the existing selectors and assertions for copying, approvals, source safety, two concurrent conversations, reading/scrolling and desktop layout. Narrow-screen and mobile layouts are no longer supported. Linux Chromium coverage does not replace validation of Windows fonts, scaling or WSL lifetime behavior.

Subagent monitoring uses `GET /api/threads/:id/subagents` for spawned descendants and `GET /api/threads/:id?refresh=1` for a fresh read-only history. Neither path resumes a thread or changes its settings. Existing SSE notices update known descendants; visible active panels reconcile every two seconds. Stored history merges with live items so delayed rollout reads cannot truncate streamed output. Subagent records reuse the conversation renderer with a separate thread and no input controls. Watchdogs and subagents occupy independent collapsible desktop rails beside the main conversation.
