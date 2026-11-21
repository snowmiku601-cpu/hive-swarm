# Changelog

## 2.1.0 — release candidate

Antigravity-style **Overview & Dual-Mode Graph Dashboard**, zero-dependency **Export GIF**, core **2.1.0 plan/screenshot schema & confined image endpoints**, **B1–B7 bug fixes**, and upgraded **host-separated `SKILL.md` playbooks** across both `hive-swarm@2.1.0` (`latest`) and `dsh-hive-swarm@2.1.0` (`next`).

### Antigravity Dashboard UI Parity (DSH & Codex)
- **Compact Single-Row Header & Underlined Tabs:** Added streamlined single-row header with live dot status (`● Live` / `● Done` / `● Needs you`) and underlined tab indicators with live counts (`Overview`, `Board N`, `Members N`, `Graph`).
- **Redesigned Overview:** Added optional `team.goalLine` + collapsed `Full brief`, collapsible **`X of Y tasks done`** Task Summary accordion (smart imperative `taskLabel`, 1-line summary, clickable colored bee pills linking directly to owned worker Journals), collapsible **`Threads`** cards with inline progress bars and auto-synthesized `Tasks` grouping when `team.threads` is empty, **`Screenshots`** horizontal snap-scrolling timeline with accessible `<dialog>` lightbox, and **`The team`** Coordinator honeycomb badge card (`Needs you` alerts render only when actionable).
- **Dual-Mode Graph (`[ Hive | Mentions ]`) & Pure-JS GIF Export:** Default **`Hive`** mode (remembered per session via `sessionStorage`) renders flat-top honeycomb cluster hexes (`Working`, `Waiting`, `Needs you`, `Done`) + crowned `Coordinator` hex with muted grayscale done/retired bees and animated `Tasks done` / `Message just sent` / `Waiting on` connectors (`±8px` offset for concurrent pairs and `context-stroke` arrowheads). **`Mentions`** mode moves all nodes onto an outer ellipse of capsule pills (`[ 🐝 name • ]`) with zero center clutter, rounded-pill SDF clipping, dashed unmentioned pill borders, retired strikethrough, `Hide inactive` / `Expand @all` switches, and client-side **`Export GIF`** powered by zero-dependency `GIF89a`/LZW encoder [`hive-gif.js`](./hive-gif.js).

### Core Schema, Confined Screenshot Endpoints & B1–B7 Fixes
- **Core Plan & Screenshot Endpoints (`engine.mjs`, `core.mjs`, `server.mjs`, `packages/dsh-hive-swarm/host.mjs`, `routes.mjs`):** Added `goalLine` (`<= 140` chars), per-member `taskLabel` (`<= 96` chars), `set_team_plan({ goalLine, tasks, threads })` supporting both map objects and OpenAI strict-mode `{ member, label }[]` arrays, `Screenshot: <path> | <caption>` projection into `team.screenshots`, and strictly `team.cwd`/`dataDirectory`-confined image serving (`GET /board/:id/screenshot/:seq/:idx` and `GET /api/hive-swarm/v1/screenshot`, `.png`/`.jpg`/`.jpeg`/`.webp` `<= 10 MiB`, symlink-escape rejection, `nosniff`, `same-origin`, `404` on invalid paths, and `img-src 'self' data: blob:` CSP).
- **B1–B7 Bug Fixes:** Fixed callable `agent.model.current()` detection in DSH `sessionRoute()` (**B1**), Windows case-insensitive `realpathSync.native` comparisons across `native.mjs`/`host.mjs`/`worktrees.mjs` (**B2**), serialized per-repo `openWorktree`/`removeWorktree` mutex + transient `.git/worktrees/` lock retry (**B3**), `presentTeam().attention` & `teamPhase()` false-stall alignment between DSH and Codex (**B4**), lazy `listModels()` hydration for `this.modelProviders` in `codex.mjs` (**B5**), optional Cordis `ctx.get?.()` + synchronous `sessionTitle.rename` fallback in `native.mjs` (**B6**), and DSH Board `Author` dedup (`You (user)`) + Goal `user [done]` summary + tab counts (**B7**).
- **SKILL.md Upgrades (`skills/swarm/SKILL.md`, `packages/dsh-hive-swarm/skills/hive-swarm/SKILL.md`):** Added Overview Plan discipline (`goalLine`, `taskLabel`, `threads`), `Screenshot:` convention for UI tasks, Strict Model Lock vs opt-in `fallbackModel`, and DSH/Windows runtime guardrails while keeping host tool names strictly separated.

## 2.0.0 — published

Published on npm as `hive-swarm@2.0.0` (`latest`, 25 files, SHA-512 `sha512-TNJfBd1fKE15j4n9YX1yThkEtmsT2tZoEUDrzWblKSXVQ8xyBQHgew94BxVFzDmQ3LnslFGfx4+2kQLrc92XUQ==`) and `dsh-hive-swarm@2.0.0` (`next`, 10 files, SHA-512 `sha512-WuHgRIzwqdOuuFzVF6IBxfalOG+3qF/JU/hA+QngwQ80WEPxVybgcQO51sZJZHLfF986xpyzYI5TOnOJrG3mJQ==`), tagged `v2.0.0` ([PR #6](https://github.com/snowmiku601-cpu/hive-swarm/pull/6) `08c5ad1`). Verified across 12/12 CI checks (Windows, macOS, Linux × Node 22.19.0, 24.2.0, 24.x, LTS; 299/299 tests) plus live Chromium inspection of isolated DSH `0.2.2-rc.5` and Codex Standalone UIs.

Major release bringing Antigravity-style **Native Subagent Swarms** to DeepSeek Harness `0.2.2-rc.5`, **Attached Child Threads & Coordinator Forking** to Codex `0.171+`, aligned Native Swarm `SKILL.md` coordination discipline, and an **Exact Box-Clipped Graph & Design DNA UI Overhaul**.

### Native DeepSeek Harness Subagent Swarm (`dsh-hive-swarm@2.0.0`)
- Execute non-worktree DSH workers as hidden native child subagents via `ctx.subagents.startActivation({ provider: 'spawn' | 'fork', maxDepth: parentDepth + 1, delivery: 'caller', childId })` (`executionMode: 'subagent'`, zero workspace sidebar clutter).
- Enforce permissions synchronously inside `ctx.on('subagent/start', info)` before Turn 1 prompt enqueue — validating `fs.sandboxMode`, `shell.sandboxMode`, `sandboxPolicy.resolve({ session })`, empty `additionalWritableRoots`, strict `tools.restrict` + `tools.guard` (blocking read-only shell `sandbox_permissions` escalation), and fail-closed activation disposal on any security violation.
- Continue Turn 2+ via `ctx.agents.resume({ resumeSessionId, agentOptions, setup })` + deep-frozen `UserMessage` (`handle.agent.followup`) after awaiting `activation.result` lock release (with clean flush & disposal outside `runMaintenance`), eliminating `subagents/prompt` `delivery: 'parent'` parent-chat wakeups while keeping `subagents/prompt` as a fallback when `ctx.agents?.resume` is unavailable.
- Route subagent transcripts through `{ kind: 'subagent', parentSessionId, childSessionId, mode: 'continuable' }` in `session/events` and `uiWorkspace.openSession(...)` (falling back gracefully to `Journal`), while keeping `worktree: true` and subagent-capacity/legacy fallbacks on `session/create` with UTF-8 `<= 80`-byte `session/rename` titles (`executionMode: 'session'`).

### Codex Attached Child Threads, Coordinator Fork & Protocol Hardening (`hive-swarm@2.0.0`)
- Pass trusted `team.parentSessionId` via MCP `_meta` / `CODEX_THREAD_ID` in `stdio()` (rejecting caller-supplied `parentSessionId` arguments and never reading shared HTTP daemon env), enabling `fork: "coordinator"` on `start_team` and `add_member` (while blocking non-coordinator peer workers from forking coordinator).
- Attach workers cleanly on Codex `0.171+` paginated parents using `thread/fork({ attachToSource: true, beforeTurnId })` (`executionMode: 'attached'`, omitting `beforeTurnId` on `fork: "coordinator"`), skipping `thread/unarchive`/`thread/archive` churn on attached threads, never calling `holdThread`/`thread/archive` on `team.parentSessionId`, never combining `attachToSource` with `ephemeral`, and falling back gracefully to `thread/start` + `thread/archive` on Codex `0.169.1` or non-paginated parents.
- Pass `allowProviderModelFallback: false` on `thread/start` for explicit model selection, latching `supportsModelFallbackFlag` / `supportsAttachToSource` only on unsupported-parameter errors.
- Align both `skills/swarm/SKILL.md` and `packages/dsh-hive-swarm/skills/hive-swarm/SKILL.md` with Antigravity Native Swarm coordination discipline (lean sizing, `#seq` referencing, peer-to-peer handoffs, coordinator-stays-coordinating, `[done]`/`[stall]` conventions) while keeping host tool names strictly separated.

### Exact Box-Clipped Graph & Design DNA UI Overhaul
- Rewrite graph geometry in shared `hive-graph.js` (`nodeBox`, `roundedRectSignedDistance`, `clipEdge`, `routeEdges`) using rounded-rectangle SDF + quadratic Bézier blossom clipping against measured DOM card bounds and asymmetric Codex hex + multi-line label bounds — eliminating arrows and arrowheads hidden behind bee icons or wrapped multi-line labels.
- Add 24-point Bézier obstacle avoidance around center nodes (e.g. `coordinator`), automatic midpoint mention-count badge deconfliction, symmetric opposite-bowing bidirectional edges, interactive focus dimming, and full un-truncated `@design-research` / `@asset-research` Codex hex labels.
- Upgrade **Overview**, **Board**, **Members**, **Graph**, and **Journal** across DSH React UI and Codex standalone/MCP UI with `Subagent` / `Attached` / `Session` badges, `✓ Verified route:` journal badges, WCAG AA `light-dark()` tokens, `@media (forced-colors: active)` fallbacks, reactive `prefers-color-scheme` listeners, and scoped `prefers-reduced-motion` transitions.

## 1.9.1 — published

Hardening and bugfix release based on live end-to-end multi-worker stress testing on DeepSeek Harness `0.2.2-rc.5` (4 workers, 43 turns, 175 board posts, verified strict model lock).

### Native DSH Host, Tool Schemas & Strict-Mode Compatibility
- Wrap all 21 `hive_swarm_*` tool parameter schemas in standard JSON Schema `{type: "object", properties, required, additionalProperties: false}` objects so OpenAI Responses API (`pi-ai`) never rejects parameter names like `title` as malformed root schema keywords.
- Make optional tool fields nullable (`[type, "null"]`) with explicit range bounds (`read_board.limit` 1–20, `board_history.limit` 1–200, `wait_for_board.timeoutSec` 1–55), clear sharding descriptions on `n`/`tasks`, and strict argument normalization (`normalizeArgs`) stripping optional `null`/empty-string fields while preserving explicit `effort: null` and rejecting unknown/spoofed fields. This fixes OpenAI strict-mode tool decoders emitting both `n` and `tasks` or empty `fallbackModel` strings.
- Sanitize all 21 native tool return payloads through strict lossless JSON (`lossless(...)`), eliminating `undefined` properties (such as `defaultEffort: undefined`) rejected by DSH `0.2.2-rc.5`.
- Attach host-verified `currentSession` (`sessionId`, `cwd`, `model`, `provider`, `modelId`, `effort`) to `hive_swarm_list_models` via `native.sessionRoute(agent)` (falling back across live model selection, session state, `request/header`, and `model/selection`), and expose read-only `list_models` to active workers in both core (`workerActions`) and DSH (`workerVisible`).

### Native DSH Runner, Sandbox & Coordination Core
- Record deduplicated host-verified `Verified route: <provider>/<model> · <effort>` steps from `request/header` / `model/selection` in worker Journals (`correlateRun` + `evidence`), preserving verified route proof across multi-turn reused worker sessions.
- Clear `inputRequired` immediately whenever `native.wait()` returns a non-`input-required` state (including `timeout`) in both `run()` and `reconcile()`, and deduplicate consecutive `'Native worker remains active'` timeout heartbeats in durable Journal storage.
- Expand read-only DSH worker tool grants (`skill`, `web_search`, `web_fetch`, `todo_write`, `working_directory`, `job_list`, `job_output`) and writable grants (`job_kill`) while strictly denying write, subagent, goal, schedule, workflow, and admin capabilities — and explicitly block read-only workers from attempting shell `sandbox_permissions` escalation in the last-mile guard.
- Expand sharded group names automatically inside `validateDependencies` (`waitFor`) and `normalizeThreads` (`threads[].members`), and treat empty `channel: ""` strings as omitted across `postingChannel`, `readPosts`, `readHistory`, and `waitForBoard` in `engine.mjs`.

### Native DSH UI & Accessibility
- Fix distorted SVG arrowheads on the Message Flow Graph by switching `<marker>` to `markerUnits="userSpaceOnUse"`, offsetting start/end points cleanly outside the 100px node cards, and increasing minimum graph height to `380px`.
- Fix vertical spacing gap under `Needs you` in two-column `Overview` (`align-items: start` / `align-content: start`), improve spacing below `Find a member` in `Members`, prevent checkbox wrapping in filter bars, collapse long member briefs (>220 chars or multiline) behind `Full brief`, and sanitize `useId()` colons in `tabpanel` / `dialog` ARIA IDs.

## 1.9.0 — published

Published on npm as `hive-swarm@1.9.0` (`latest`, 25 files, SHA-512 `sha512-xlev8HFaXvb5j9TDsQLNYPhsTWxsmvyPn+mqI+IRG0uP3kmk7RSqlEWk3Z3tYl1ah3DDoygiabShC0KAij/uJg==`) and `dsh-hive-swarm@1.9.0` (`next`, 10 files, SHA-512 `sha512-nZnuq3fjNNrVwMhSrDoGsGi4nN8WXNPbK3Xjh7fp5pi15KIIqmCMt+yS8Zp6z3Pi+O9ehfwwRJa82z1o5+jCiQ==`). Verified across 24/24 CI checks (Windows, macOS, Linux × Node 22.19.0, 24.2.0, 24.x, LTS; 264/264 tests).

### Coordination & Engine
- Normalize `notify` and `waitFor` member targets (strip leading `@`, lowercase, preserve `#channel`) in `engine.mjs` so `@member` targets always route and unlock dependencies reliably.
- Forward `mentionsOnly` filtering in `board.readPosts()`.
- Fix live-error `recoveryRequired` deadlock: preserve unconfirmed run evidence while cleaning up active slots, block `switchModel(..., {resume: true})` while unconfirmed, and add explicit `resolve_recovery` (`action: "retry" | "dismiss"`) across core, Codex server/UI, and native DSH host/UI.
- Add optional Antigravity-style outcome `threads` (`start_team.threads` and `set_team_plan`) ordered `Blocked` → `Active` → `Queued` → `Done` in both Codex and DSH Overviews.
- Add optional opt-in quota failover (`fallbackModel` / `fallbackEffort` on team or member) for automatic recovery on quota exhaustion without silent substitution when unconfigured.
- Validate effective inherited `(model, effort)` in `core.mjs` (`start_team`, `add_member`, `set_member_model`) and reset incompatible inherited `team.effort` cleanly when switching models.

### Codex Adapter, Security & CLI
- Replace hardcoded 20-minute wall-clock turn timeout with an activity-resetting idle timeout (`HIVE_SWARM_TURN_TIMEOUT_MS`, 20m default, 60m hard cap) in `codex.mjs`.
- Launch Windows `codex.cmd` shims directly via `process.execPath` without `cmd.exe`, and preserve `listModels()` provider metadata.
- Enforce `sec-fetch-site: same-origin` on standalone `GET /board/:id/status` and `GET /board/:id/history` endpoints, inject runtime version from `package.json` instead of a stale hardcoded version in `board.js`, and expose `board_history` and coordinator `set_team_plan` to peers.
- Add explicit `--allow-unqualified-cli` flag for `hive-swarm update --host codex --after-close` so users on newer Codex CLI builds can opt in while preserving default fail-closed qualification checks.
- Retry transient Windows `EPERM`/`EBUSY`/`EACCES` locks with backoff when promoting a staged release directory (`renameDirectory`) and during staging cleanup in `installer.mjs`, while still failing closed if the target already exists.
- Normalize embedded SVG and CSS line endings in `scripts/build-dsh-client.mjs` so `npm run build:dsh` produces byte-deterministic `client/dist.js` output across Windows and Unix line-ending settings.

### Native DSH Host, Runner & UI Parity
- Preserve detailed `turn/end` failure reasons in `correlateRun`, fix `member.effort === null` resolution to use model defaults instead of falling back to `team.effort`, and prevent premature `'failed'` reconciliation while the host reports an active/queued session.
- Make `workspaceAllowed` resilient to deleted unrelated workspace entries, hide owner-only tools from active DSH workers, and publish complete nested tool schemas in `host.mjs`.
- Bring native DSH React UI to parity with Codex UI: safe React Markdown renderer, clickable `#seq` post jumps, outcome threads, progress bars, milestones, inline team Rename, live activity strip, Follow toggle, `Clean worktree`, `effort: null` + `Resume now` in MemberEditor, Graph replay controls (`First`/`Prev`/`Play`/`Next`, pacing, speed, elapsed span, selected post), and explicit `Retry fresh turn` / `Dismiss` recovery actions.
- Enrich worker prompts and skills (`skills/swarm/SKILL.md`, `packages/dsh-hive-swarm/skills/hive-swarm/SKILL.md`) with peer-to-peer handoff guidance, `@name` wakeup-doorbell discipline, and no double-posting rules.

## 1.8.0 — published

- Add a zero-dependency npm core and explicit Codex install, update, uninstall and read-only doctor commands. Registration uses verified persistent copies, preserves data, and refuses replacement while owned work is active.
- Add shared host-scoped application contracts and durable native run evidence. Accepted prompts are correlated with their actual claim, outcome and turn end; uncertain runs are preserved for recovery.
- Add the experimental `dsh-hive-swarm` bundle for DSH 0.2.2-rc.5: native worker sessions, permission-scoped tools, the bee-marked Start card, right tab, full panel, four views and Journal.
- Keep worker identity through permission waits and restart recovery. Drain cancellation before releasing native guards or closing run evidence. Reject invalid outcomes before storing immutable reports.
- Preserve the Windows source installer's selected Node runtime and paginate the GET event stream without skipping backlog posts.

The experimental DSH release passed the approved Windows Desktop two-worker smoke; Windows shell enforcement remains partial and native DSH was not qualified on other operating systems. Core `hive-swarm@1.8.0` is published with the `latest` tag, and `dsh-hive-swarm@1.8.0` is published with the `next` tag. See [qualification](docs/releases/1.8.0-qualification.md) for evidence and platform limits. No Git release tag was created.
