# npm and DSH Native Implementation Plan

> **For agentic workers:** Use the user's selected Hive Swarm execution method. Keep implementation ownership explicit, test behavior before code, and obtain one fresh whole-branch review. Do not ask for a second design/implementation approval: the user approved on November 20, 2026.

**Goal:** Deliver installable npm packages, preserve Codex, and add real DSH-native workers and a bee-marked Swarm Start card directly above More tools.

**Architecture:** One TeamBoard engine and shared presentation/action contracts; Codex retains its current adapter/transport. A separate DSH bundle uses the installed DSH session Gateway and authenticated Connection Fetch registry, with native React tab/main views.

**Tech Stack:** Node ESM and built-in SQLite for core; DSH 0.2.2-rc.5 Cordis/Connection/Session APIs and host React for its native package. Core has no third-party npm runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-npm-deepseek-harness-design.md` (approved).

## Global Constraints

- English product copy; Vietnamese user communication.
- Preserve Codex marketplace/plugin identities, state directory, service key, port 17943, MCP UI and Windows environment fixes.
- Candidate version 1.8.0; Node range `^22.19.0 || >=24.2.0`; verify actual executable startup, not SQLite import alone.
- Proposed packages `hive-swarm` and `dsh-hive-swarm`; publisher/name ownership and real publishing are separate gates.
- Native DSH Desktop sessions, not an ACP subprocess/iframe fallback. Fail closed when native ownership, scope, permission, or transport cannot be established.
- Swarm Start guide card uses canonical bee SVG and standard DSH renderer, immediately above More tools; native right tab and full panel share state/actions.
- No personal profile/credential/chat edits, paid DSH model calls or app termination during implementation/tests. Use isolated homes and no-model fixtures.
- User authorized implementation via Swarm. Work in existing checkout on `codex/npm-dsh-native`; writers own disjoint paths and run in coordinated phases. No unrequested worktree is required.
- No plain-npm postinstall registration, data purge, anonymous DSH endpoint or credential-bearing URL.

## Review Focus

1. Acceptance-versus-completion and restart gaps must not duplicate a prompt or wake peers twice (Task 2).
2. A browser/model-supplied session/team/workspace identity must not reach another user's/host's session (Task 2).
3. DSH Desktop `file://` IPC must reach the same authenticated exact routes as Web; HTTP-only mocks are insufficient (Tasks 2–3).
4. Tarballs must contain hidden manifests/built client files while excluding gallery/private data; npx cache must not be the registered install (Task 1/4).
5. Activating/reloading/disabling Hive must not duplicate its card, change other guide cards or override Task Board/Git Graph/Wallpaper theme behavior (Task 3).

## Task 1: npm core package and durable Codex CLI installation

**Files:** Create `package.json`, `cli.mjs`, `installer.mjs`, `cli.test.mjs`, `package.test.mjs`, release helpers/CI as necessary. Modify installer wrappers, version metadata, README and `.gitignore` only for this scope.

**Interfaces:** CLI exports `main(argv, options)` with injectable host-command execution/home/package directory for tests, returning an exit code. Commands are `install`, `update`, `uninstall`, `doctor`, `--help`, `--version`; `--host codex` is implemented, `--host dsh` explains DSH-owned bundle installation without mutating its profile. A versioned persistent copy retains exact Codex manifest/skill/icon paths. Runtime library exports in package.json initially expose engine/worktrees and will add Task 2's shared contract once it exists.

- [ ] Write failing behavioral tests: help/version/unknown command exit codes, correct persistent installation paths, no mutation on doctor, refusal on foreign-owned target, staged update/rollback on host failure, data retained on uninstall, and argv/path safety with spaces/non-ASCII.
- [ ] Run `node --test cli.test.mjs package.test.mjs`; confirm missing CLI/package behavior causes failures before implementation.
- [ ] Implement the manifest/bin and native CLI wrapper. Use supported installed Codex CLI marketplace/plugin commands with a fake command runner first; preserve old shell entry points. Keep mutable npm cache/global package locations out of host registration.
- [ ] Run full `node --test ./*.test.mjs`; pack/extract the real core tgz and run its CLI + MCP initialization/tools/resources from a path containing spaces. Assert allow/deny archive contents, hidden paths, a bounded byte size and valid README assets.
- [ ] Commit scoped work and report exact commands/results, base/head and limitations; no npm publish or personal host registration.

## Task 2: shared host application and native DSH worker lifecycle

**Files:** Create `core.mjs`, `core.test.mjs`, host-neutral projection helpers as needed; modify `engine.mjs` and its tests narrowly. Create `packages/dsh-hive-swarm/package.json`, `cordis.patch.yml`, `host.mjs`, `runner.mjs`, `routes.mjs`, host/protocol tests and build inputs. Task 3 owns client files and final client bundle wiring.

**Interfaces:** `createSwarmApplication({dataDirectory, runner, host, workspaceAllowed})` owns one TeamBoard and exposes `snapshot`, `command`, `subscribe`, `close`. `runner.run` consumes existing team/member/remember/declaredOutcome/onActivity plus cancellation; normalized models/journal are host-neutral. `presentTeam` emits existing board fields with host/capabilities/session identity and host-specific navigation. Legacy records default to Codex; DSH has separate storage.

DSH Host `apply(ctx)` registers an application, scoped native tools and three exact Connection Fetch routes:
`GET /api/hive-swarm/v1/snapshot`, `POST /api/hive-swarm/v1/command`, `GET /api/hive-swarm/v1/events`.
Use `ctx.connection.fetch.register(ConnectionFetchRoute)` and its owner-only carrier; no separate listener. Validate schema/actions, canonical workspace and Hive ownership after carrier admission. Limit request bodies to 128 KiB and release streams on abort/dispose.

DSH runner uses in-process Session Controller/Gateway and a Context-owned Peer; it never accepts a wire-supplied principal. Persist one run identity `(team, member, turn, requestId)` before prompt. Native scoped `set_turn_outcome` provides a pending result; claim/turn-end and host quiescence establish settlement. Unknown outcome after restart is Needs you and never an automatic re-prompt. Map only verified host permission policies to read-only/workspace-write; do not infer sandbox guarantees from approval presets.

- [ ] Write failing tests for real TeamBoard/application behavior with strict fake external services: isolated host state; malformed/unauthorized requests; member identity spoofing; permission refusal before prompt; acceptance without completion; wrong-turn/duplicate/reordered updates; crash after acceptance/terminal-before-save; cancellation and no late settle; preserved Codex restore behavior; restart-safe journal; no model calls from read paths.
- [ ] Run new tests and record expected RED. Inspect the pinned/native DSH public types used by each adapter; fixtures must mirror the actual shape and ordering.
- [ ] Implement the shared application and native runner/Host routes. Add DSH `/hive-swarm` guidance and prefixed tools; retain Codex `/swarm`/peer APIs. Qualify a no-model native host fixture before considering the live profile.
- [ ] Run all core tests plus DSH Host tests. Test Connection carrier route registration and owner rejection using the real installed/pinned SDK when feasible, not only an invented router fake. Report an unsupported contract as a gate failure, never substitute ACP/MCP.
- [ ] Commit and report interface details, test evidence and precise outstanding real-host gates.

## Task 3: native bee launcher, Swarm views and DSH built package

**Files:** Create `packages/dsh-hive-swarm/client/` React entry/views/scoped CSS, client registration tests, built package configuration and generated outputs through a reproducible build. Coordinate package.json/build changes with Task 2 ownership transfer. Reuse shared core/view-model, graph/bee algorithms and canonical SVG.

**Interfaces:** Register definition id `dsh-hive-swarm`, kind `hive-swarm`, title `Swarm`, and `guide: [{id:'open',order:900,title,icon}]` using `ctx.sidebarRightTabs.register`. Mount the body under `sidebar.right.pane.tab` keyed by the definition id. Default native guide renderer owns capsule alignment; no injected DOM, iframe, whole-guide replacement or `conversation.input.dock` takeover. Register a distinct global main panel/sidebar entry and share one view/controller with the right tab. Client uses Connection's Fetch carrier for Task 2 routes.

- [ ] Write failing tests for a registration-driven card with real bee icon; default guide metadata/order; one registration across reload; cleanup; correct team/workspace/session mapping; no launch on open; snapshot/reconnect cursor; actionable errors; the four views, Journal and shared native navigation.
- [ ] Run client tests and observe RED before implementation. Read Impeccable's craft floor before UI edits; preserve native UI conventions and existing Hive identity.
- [ ] Implement the native React views and lifecycle. Follow DSH semantic tokens/font/theme; test installed enhancement compatibility. Build browser client in DSH's actual loader format, with host-shared React/SDK peers; do not ship raw JSX/TS as if runnable.
- [ ] Run core + Host + client tests. Pack real DSH tgz; inspect manifest/patch/exports/built assets, install into an isolated initialized DSH profile, dump configuration/load without model calls, and test version-pinned update/remove/rollback without editing a personal profile.
- [ ] Commit and report reproducible package paths, test outputs, screenshots if available, remaining qualification limits and dependency/version linkage to the core package.

## Task 4: integration, independent review and release qualification

**Files:** Final verification scripts/fixtures, CI, README compatibility/install instructions, changelog and evidence ledger. No new product behavior without a test reproducing the need.

- [ ] Verify the real artifacts from a clean consumer directory, installed Node minimum/current supported LTS, and OS CI matrix; run packaged CLI and MCP handshake. Link the unpublished core artifact in a controlled fixture/registry rather than silently fetching an unrelated npm package.
- [ ] Validate native DSH load, Start card alignment, open tab/main navigation, four views/Journal, enable/reload/dispose and theme/plugin coexistence on installed rc.5. Any live app activation follows DSH's supported lifecycle and preserves existing work/settings. Obtain concrete approval for app disruption or a model-backed smoke when needed.
- [ ] Generate a full branch diff package from `cdbf204`, with reports/ledger and exact test evidence. Ask a fresh Swarm reviewer for spec and quality findings; inspect findings and fix material defects with RED→GREEN tests. Do not hide failed/unverified gates behind a green unit suite.
- [ ] Update honest compatibility status. Core can release before DSH; DSH cannot be called supported before G5. Show exact tgzs/publisher/name/version and evidence before any account/publish approval. No credential collection in chat.
- [ ] Finish only when all approved deliverables and release gates are proved, or retain the active goal with the specific external input required.

## Execution record

Use `.tmp/npm-dsh-native-progress.md` (ignored) for base/head, ownership, RED/GREEN results, rulings, review findings and gate status. It is the source of continuity after compaction; do not re-dispatch completed work.
