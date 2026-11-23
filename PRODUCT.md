# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People coordinating AI-agent work in a local software workspace. The maintainer uses Codex Desktop and DeepSeek Harness Desktop and wants other users to install Hive Swarm conveniently.

## Product Purpose

Turn one user-requested goal into bounded worker assignments, coordinate dependencies and peer-to-peer mentions, and make progress, outcome threads, blockers, and evidence inspectable through one shared board.

## Positioning

Hive Swarm combines a persistent coordination engine, per-member host sessions, explicit wakeups, outcome threads, turn budgets, saved journals, and replayable message flow. The coordination engine is distinct from its worker-harness adapter.

## Operating Context

- Candidate `2.2.0` (`hive-swarm@2.2.0` `latest` & `dsh-hive-swarm@2.2.0` `next`, verified across `392/392` tests and `206,670 B` minified `client/dist.js`): upgrades **Graph · Hive** and **Export GIF** to **Specialized Honeycomb Cells** (3-tier `threads` → `group`/`channels` → status grouping, Ring-2 axial layout up to 18 outer hexes, wrapped multi-line titles, clockwise hexagonal `done/total` progress-ring borders via `hexProgressRing`, curved quadratic Bézier outer connectors, cubic self-loops, focus dimming, and `blockedReason` pills across Codex & DSH), adds `parallelWriters: true` + `worktreeMode: 'local'` (`.hive-swarm-worktrees/<teamId>/<member>`), durable `RunStore.abandon()` SQLite WAL migration + Codex `AbortSignal -> turn/interrupt`, DSH parent `danger-full-access` inheritance for writable workers on Windows, decoupled `900s` DSH `wait_for_board` (`inputRequired` wakes, compact timeouts, `kind: 'status'` exclusion), `read_board({ seqs })`, `retire_member({ dropDependency })`, and Turn-1 subagent/fork hardening.
- Published `2.1.0` ([PR #8](https://github.com/snowmiku601-cpu/hive-swarm/pull/8) `0956c27`, [PR #9](https://github.com/snowmiku601-cpu/hive-swarm/pull/9) `cb2c80f`, tag `v2.1.0`; `hive-swarm@2.1.0` `latest` & `dsh-hive-swarm@2.1.0` `next`): upgrades both DSH and Codex UIs to full Antigravity Swarm Dashboard parity (compact single-row header with live dot + underlined tabs with live counts `Board N` / `Members N`, collapsible `X of Y tasks done` accordion with smart `taskLabel`s & clickable bee pills, `Threads` progress bars + auto-synthesized `Tasks`, strictly workspace/data-confined `Screenshots` strip + `<dialog>` lightbox, `The team` Coordinator honeycomb tile, Dual-Mode `Graph` defaulting to `Hive` honeycomb + outer-ring capsule pill `Mentions` + zero-dependency pure-JS `Export GIF` in `hive-gif.js`), resolves B1–B7 backend/Windows/UI bugs, fixes prior-release Codex upgrade verification in `installer.mjs`, and aligns both host `SKILL.md` playbooks.
- Published `2.0.0` npm packages ([PR #6](https://github.com/snowmiku601-cpu/hive-swarm/pull/6) `08c5ad1`, tag `v2.0.0`, verified across 12/12 CI checks and 299/299 tests): `hive-swarm@2.0.0` (`latest`, SHA-512 matching source tarball) and `dsh-hive-swarm@2.0.0` (`next`, experimental). Upgrades both adapters to Native Subagent Swarm execution with an Overhauled Graph/Design DNA UI: hidden native DSH child subagents via `ctx.subagents.startActivation` + synchronous fail-closed `subagent/start` locks + `ctx.agents.resume` Turn 2+ continuations (zero parent-chat wakeups, zero sidebar clutter), Codex `0.171+` attached child threads (`thread/fork({ attachToSource: true, beforeTurnId })`, `fork: "coordinator"`, `allowProviderModelFallback: false`) with `0.169.1` fallback, Native Swarm `SKILL.md` alignment, exact box-clipped Bézier Graph geometry eliminating arrow-behind-card overlap, and `Subagent`/`Attached`/`Session` + `✓ Verified route:` UI clarity.
- Release `1.9.1` builds on published `1.9.0` (`hive-swarm@1.9.0` `latest` and `dsh-hive-swarm@1.9.0` `next`, merged via PR #2 `5115617` and PR #3 `eccccc3`) with live end-to-end DSH `0.2.2-rc.5` stress-test hardening (4 workers, 43 turns, 175 board posts): OpenAI Responses strict-mode nullable JSON Schemas and lossless JSON tool outputs, host-verified `currentSession` and multi-turn Journal route evidence, safe worker `skill`/`web_search`/`web_fetch`/`list_models` grants with read-only shell-escalation guard, `inputRequired` timeout clearing, heartbeat deduplication, shard-group dependency expansion, and Graph/Overview/Members UI polish.
- `1.9.0` builds on the `1.8.0` baseline qualification (`7330345`), hardening live error recovery (`resolve_recovery`), peer-to-peer coordination, outcome threads (`set_team_plan`), opt-in quota failover (`fallbackModel`), idle turn timeouts, Windows installer rename retries, security headers, deterministic DSH client builds, and full native DSH UI parity.
- Shared four-tab UI across both Codex and native DSH: Overview, Board, Members, Graph, and owned worker Journal; representative demo screenshots in `README.md` remain labeled as demo evidence, separate from the live Windows DSH Desktop qualification.
- Native DSH entry points: bee-marked `Swarm` Start card immediately above `More tools`, right-dock tab, and full React panel, all sharing one controller store without starting model turns on read/open.

## Capabilities and Constraints

- Preserve existing Codex workflows, stored teams, identities, and Windows portability fixes.
- Agents start only on user-authorized work. Looking at the board must not start a model turn.
- Keep host credentials and private conversations under their host's control.
- Packaging, native UI integration, and native worker execution require separate evidence; one does not prove the others.
- Never silently substitute an unconfigured model or automatically re-prompt an unconfirmed possibly-paid turn.

## Brand Commitments

Hive Swarm name, crowned coordinator bee, distinct worker bees, existing restrained gold identity, and English product copy. Conversation with this maintainer is Vietnamese. Host integration should respect the surrounding application's conventions.

## Evidence on Hand

- `README.md`, `README.npm.md`, `packages/dsh-hive-swarm/README.md`, `CHANGELOG.md`, runtime sources, 20 `node:test` test files (`392/392` tests), Codex plugin/marketplace manifests, and `packages/dsh-hive-swarm/` native bundle (`client/dist.js` `206,670 B`).
- `assets/hive-swarm-icon.png`, `assets/hive-swarm-icon.svg`, README banner/flow artwork, 2.2.0 2× Retina light/dark demo captures (`overview`, `board`, `members`, `graph`, `graph-mentions`, `journal`), and animated walkthrough (`assets/hive-swarm-demo.gif`).
- `docs/releases/1.8.0-qualification.md`, `docs/releases/1.8.0-artifacts.json`, `docs/releases/1.8.0-validation.json`, and `docs/releases/1.8.0-publication.json` recording published 1.8.0 verification across Windows/macOS/Linux CI and installed Windows Codex CLI `0.169.1` / DeepSeek Harness Desktop `0.2.2-rc.5`.

## Product Principles

1. Show actionable evidence and precise blockers.
2. Reuse coordination behavior across hosts while keeping host ownership explicit.
3. Make installation and removal predictable and preserve user data.
4. Keep existing host navigation, themes, permissions, and companion plugins working.
5. State capability limits honestly; never replace missing native support with an undisclosed fallback.
