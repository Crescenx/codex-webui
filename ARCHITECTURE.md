# Codex Viewer architecture

Viewer-managed delegation runs Codex tasks in independent working copies. `server/hybrid.ts` retains logical conversations, operation receipts and result delivery; `server/agents-mcp.ts` authenticates native caller metadata. `server/agent-workspace.ts` applies inspected changes using three-way merge and recovery journals. Native and managed Codex descendants share the existing subagent panel.

## Runtime boundary

`server/runtimes.ts` multiplexes Codex and the optional Antigravity Rust stdio app-server. Models use `antigravity/` and threads use `agy:` prefixes; approval IDs retain provider ownership. `server/hybrid.ts` preserves each provider's native binding and delivers incremental history when switching models. Goal activation injects pending history before starting the native Goal, with durable receipts preventing replay of unknown outcomes. List and quota reads retain healthy-provider results on partial failure. Google quota groups survive the shared usage DTO through to the UI, separate from Codex reset credits.

The previous ACP transport and skills bridge remain removed. Historical `antigravity:` bindings are retained but excluded from execution; they are not aliases for new `agy:` sessions. The Rust process owns a Viewer-specific state directory even when the parent environment defines another app-server home.

Codex Viewer is a local, single-user Vue application backed by the existing Node HTTP/SSE bridge and Codex App Server. Raw messages remain canonical. This migration adds component and state boundaries; runtime plugin loading is a future feature.

## Ownership and dependencies

Codex Goal is native per-thread state, independent of collaboration mode. Viewer exposes `GET/POST /api/threads/:id/goal` and `POST /api/threads/:id/goal/clear`, backed by `thread/goal/get/set/clear`. Shared reducers consume native goal notifications, while guarded reads restore snapshots after reconnect. Model calls to native goal tools use the same state and require no Viewer MCP wrapper. Activation first synchronizes effective thread settings and lets Codex start its own turn. Interrupt-and-send temporarily pauses the goal to prevent continuation racing the replacement input; an unconfirmed submission is never replayed. Active goals also reserve their thread between turns against Watchdog dispatch and planned backend restart.

Run `node scripts/check-goals.ts` for an isolated real-Codex check with deterministic local model responses: native tool exposure, a natural-language message invoking goal creation, two-turn continuation, usage, budget clearing, and restart recovery. It uses no credentials or paid model calls. UI and race coverage lives in the existing Node/Playwright test commands.

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
| `web/transcript.ts` | Bounded presentation memory and completed Markdown renders | Canonical history or network reads |
| `web/App.vue` | One store instance, application lifecycle, hash navigation, persisted sidebar layout, component assembly | Protocol merging or a second connection |
| `web/components/` | Feature views, local dialog/selection/expanded state | Direct fetch/SSE or mutable copies of canonical threads |
| Rendering helpers | Markdown/source mapping, highlighting, link preview DOM | Agent instructions, history mutation, execution policy |
| `server/` | Authentication, authorization, persistence access, Codex connection and HTTP/SSE | Frontend presentation |

The store exposes readonly state and named operations. Components receive the application store through Vue provide/inject; there is no import-time store singleton. Presentation children use props and emitted events. Vue's built-in reactivity is sufficient for the current application; no router, state library, dependency-injection container or plugin registry is introduced.

Each loaded thread has one canonical entity. `currentId` and sidebar IDs reference that entity. Its draft owns text, attachments, selected skills, desired settings, loading/submission flags, uncertainty and errors. Pending approvals are keyed by request ID and retain their owning thread. Effective settings come from Codex; pending settings remain local until explicitly submitted.

## Requests, snapshots and events

Authenticated page/API requests renew the same session and HttpOnly cookie for 24 hours. Cached assets never set cookies, and SSE heartbeat writes do not renew sessions. Since EventSource hides HTTP status, connection errors probe the existing Watchdog list endpoint once at a time; a 401 closes SSE, stops subsequent HTTP calls and preserves drafts with an explicit login-expired state.

The sidebar requests 50 thread metadata records per native page. Each page validates distinct working directories and resolves Git roots with four concurrent workers, without caching authorization across requests. Project lists have independent CSS scrollers capped at min(360px, 40vh), and retain DOM/scroll positions while collapsed. User-triggered project history scans share the global pagination request and advance until that project gains visible rows or history ends; folding/switching cancels subsequent pages. Outer scroll continuation never drains history merely to fill a capped or collapsed project. Failed pagination leaves the cursor and loaded entities intact for explicit retry.

All network operations go through the client. Selection and configuration reads use separate request scopes; a new request aborts the previous request in the same scope. List, usage and Watchdog reads join an existing request; event invalidations are batched and changes during a read request one follow-up. The initial SSE resync owns bootstrap reads. Completion checks both the request identity and the connection generation. The selection generation independently prevents a late A/B response from changing the user's latest choice.

Creation returns a sequenced thread snapshot plus the models validated for that request. The store uses it directly unless newer SSE events have already arrived, in which case it resyncs normally. History and configuration refreshes run in the background; unchanged effective settings can be submitted while options load, but edited settings and unconfirmed experimental context capabilities remain gated. The new-task dialog also permits ordinary creation with project defaults while its optional model choices load. The server reads approval configuration once per creation and only checks account eligibility when experimental context is requested.

Opening a thread buffers its events while the snapshot is in flight. The accepted snapshot replaces that thread and its approvals, then buffered events newer than its sequence are applied through the shared reducer. Other threads continue updating. Unknown approval-resolution events are retained for in-flight snapshots, so an approval first discovered in a snapshot cannot be resurrected after resolution.

Selection changes immediately, showing any cached history while `/open` revalidates in the background. A first read shows a loading state. Sending remains disabled until synchronization succeeds; failure retains cached content and drafts with an explicit retry. Selection generation and per-thread snapshot/event ordering also apply to this cached display.

SSE event IDs identify the server epoch. Delivered event sequences suppress duplicate deltas; snapshot watermarks are per thread and never discard another thread's updates. Offline notifications invalidate reads, and a changed epoch resets sequence tracking. A list refresh merges metadata without replacing live turns or effective settings; status is updated only if no live event or snapshot arrived during the read. Metadata changed during the list read takes precedence over its older response.

Metadata refresh preserves loaded sidebar IDs and the pagination cursor; loading another page has a separate read scope. Node drains SSE buffers normally, including frames larger than its high-water mark. A client exceeding 8,000,000 queued bytes is disconnected and recovers through replay or resync. Only content-hashed build assets receive private immutable browser caching; authentication is still checked on every server request.

Send, interrupt, approval and skill changes run only from explicit actions. Reconnects and mounting never retry them. A send timeout can mean Codex accepted the action: retain the draft, mark its state uncertain, and query state before another attempt. Browser request cancellation does not undo an already-accepted server action.

The sidebar's restart replaces the entire Viewer Node process and its shared Codex child. The authenticated route checks foreground requests, approvals, scheduled checks and all native loaded threads before accepting; unreadable or unsaved threads prevent restart. Admission and scheduling pause, and HTTP 202 is flushed before closing HTTP, SSE, sandboxes and the old child. The CLI uses Node 24 `process.execve` to re-execute its original entrypoint and arguments while retaining systemd supervision. A bounded, two-minute authentication handoff in the replacement environment preserves the port, launch token and existing cookie expirations; startup consumes it before launching Codex and never writes it to disk. SSE's new process epoch triggers snapshot recovery without replaying turns. Acceptance alone is not success: the browser waits for a new epoch, native readiness and resync, with a 60-second failure deadline. Each tab then saves its draft inputs and uploaded attachment references to a one-shot sessionStorage entry and reloads the page to load current frontend assets. Startup consumes that entry and reports success after resync; storage failure leaves the existing page and drafts intact. Frontend source changes still need a build before restarting.

Watchdogs persist user-authorized recurring and one-off work in `watchdogs.sqlite` through Node's built-in SQLite. `server/watchdogs.ts` owns configuration revisions, atomic claims and immutable run snapshots; `server/main.ts` queries due tasks through a partial expression index and schedules them using the same thread lock, settings validation and native turn starter as interactive messages. One active run per thread is enforced by a SQLite unique index. Missed deadlines coalesce; recurring completion advances to a future deadline. A structured report remains provisional until native completion, and edits made after a claim take precedence over its outcome. Every thread-lock release reconciles completion received during a foreground RPC. Change notifications run after commit; a notification failure does not fail the saved write.

Configuration accepts exactly one of legacy `intervalMinutes` or `schedule`: `{kind:'daily',everyDays,startDate,time}`, `{kind:'weekly',weekdays,time}` (ISO weekdays 1–7), or `{kind:'once',at}`. Calendar strings use `YYYY-MM-DD`, `HH:mm`, and `YYYY-MM-DDTHH:mm` in the backend local timezone. HTTP/MCP lists return `timeZone`, which the editor and deadline display use even when the browser is in another timezone. The existing JSON records and run snapshots require no table migration. Central date calculation preserves daily anchors and weekly wall times, including across DST; new or changed one-off appointments must be future times. Manual runs preserve recurring calendar anchors, while fixed intervals retain their original reset behavior. One-off success with either continue or complete consumes the appointment; failure, missing reports and uncertainty retain the existing input-required behavior. Editing instructions during a one-off cannot duplicate its occurrence, and changing its appointment during a run preserves the new deadline even if it becomes overdue. Resuming a consumed appointment requires a changed future time; explicit run_now can repeat it.

`server/watchdog-mcp.ts` exposes five built-in tools through a stdio server injected by App Server launch overrides. It forwards calls to an authenticated loopback route, using native `_meta.threadId` for ownership. Scheduled turns can read tasks, submit their outcome, and delete tasks in the same conversation at the user's request; other management remains blocked. Outcomes require only `runId` and `outcome`; optional summaries preserve compatibility with older callers. Deletion cancels future dispatches, retains history and does not interrupt the active turn or invalidate its final outcome. Only this local management server uses `default_tools_approval_mode="approve"`; execution retains native command/file approvals. Browser routes retain cookie, origin and authorized-root checks. Neither the bridge nor the scheduler changes global Codex configuration. Both old resumed and new threads receive the tools. The bridge owns its launch configuration; the generic adapter keeps per-instance additions out of forked title workers.

Each run persists its unique native message ID before submission. Lost acknowledgements are reconciled against native history; uncertain runs are paused without replay. Restart recovery checks unfinished runs before dispatching due tasks. A run saves the foreground settings and restores them under the shared thread lock; incoming watchdog settings do not replace browser drafts. The conversation's Watchdog rail owns creation and management. Cards show saved instructions and scheduling metadata; the latest-run action opens the native conversation rather than a separate report view. SSE invalidations refresh the task list, while the editor keeps its local input on revision conflicts. Closing, changing views or switching conversations clears local busy state and invalidates old read/write callbacks; an explicit default reasoning effort remains null when editing.

## Rendering and lifecycle

MCP tool results use the same activity renderer as other tools. Native MCP form and URL elicitations use the pending-request flow; form responses are validated against the server-provided JSON Schema before delivery. The Viewer does not host embedded MCP applications or expose their resource/tool RPCs.

Vue owns component structure and stable keys. `MessageBody` owns an empty Markdown container whose descendants are managed exclusively by the existing renderer. `ActivityBlock` uses the existing highlighter on code containers; unchanged output keeps its DOM. No unsanitized message HTML enters Vue templates.

Main and subagent transcripts use TanStack Vue Virtual with whole-message rows, stable thread/turn/item keys, dynamic measurements and four overscan items per side. Each animation frame projects lightweight references; only mounted rows receive detached copies. Selection freezes this projection while canonical state advances, and pins selected rows against recycling. Focus and dialog owners are also retained. The app keeps the last eight threads' reading anchors, offsets, measurements and expanded command/file states, releasing this presentation memory on unmount. Width changes remeasure and restore the anchor. Canonical history remains in the store.

Streaming Markdown paints wait at least 100 ms between updates, with a longer gap after expensive paints. Completion flushes the latest source immediately unless selection is holding the display. Each active message block cache holds at most 2,000,000 string code units and clears on completion or unmount. A separate app-owned LRU retains completed sanitized HTML, source atoms and Mermaid descriptors, keyed by message identity and exact source, limited to 200 messages and an estimated 16 MiB of strings. It retains no DOM. Full parsing and DOM replacement within a single very large message remain the ceiling.

Consecutive reasoning and tool rows share a trace header. Active traces default open; a subsequent reply or turn completion closes them. Collapsing filters display rows without changing native items or their search keys, and expanded traces still use row virtualization. Presentation memory retains manual choices. Questions, known MCP Apps, open app instances and dialog owners stay available.

Conversation search scans the complete canonical transcript, including public activity details, raw diff text and submitted answers, regardless of mounted rows. Literal case-insensitive matches are counted per message and show an excerpt. Navigation expands the enclosing trace and matching command/file details before scrolling to the native item; large diffs retain their 500-line display batches. Ctrl/Cmd+F targets the focused main or subagent transcript and leaves open dialogs alone. Browser-native find cannot search recycled messages.

Whole-message copying reads the displayed message's original source. Selection wholly inside a code body takes the exact DOM range text, including whitespace across highlight spans, without fences or a full-transcript walk. Mixed selections retain complete code atoms as source but clip partially selected blocks to their code text. Math, inline code and links retain source-position mapping. The same handler covers main/subagent transcripts and Mermaid source views; toolbars and link previews do not enter copied text.

`FileChangeBlock` renders each native `fileChange` item as collapsed file cards and owns its native review dialog. `web/diff.ts` parses update hunks (with or without Git headers); add/delete records contain full source. Statistics and split alignment derive only from that item, without reading current files or accumulating workspace changes. Invalid, incomplete or binary records retain their raw text and unknown counts. `DiffView` mounts only for open files, adds 500 rows per batch, and reuses the bounded code highlighter. Split panes share vertical scroll position; selection copying omits gutters and keeps source whitespace. The teleported dialog separately freezes its displayed item while selected, removes its selection listener on close/unmount, and restores focus to the opener on close. Main and subagent transcripts use the same components.

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
