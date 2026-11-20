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

- Shipped 1.8.0 npm packages (merged into `main` at `7330345`): `hive-swarm@1.8.0` (`latest`, zero third-party runtime dependencies, Node `^22.19.0 || >=24.2.0`, Codex adapter & lifecycle CLI) and `dsh-hive-swarm@1.8.0` (`next`, experimental native DeepSeek Harness `0.2.2-rc.5` plugin).
- Prepared `1.9.0` release on `main` (building on PR #2 `5115617`): hardens live error recovery (`resolve_recovery`), peer-to-peer coordination, outcome threads (`set_team_plan`), opt-in quota failover (`fallbackModel`), idle turn timeouts, Windows installer rename retries, security headers, deterministic DSH client builds, and full native DSH UI parity — ready for maintainer-approved npm publication under `1.9.0` (never republished under `1.8.0`).
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

- `README.md`, `README.npm.md`, `CHANGELOG.md`, runtime sources, 20 `node:test` test files, Codex plugin/marketplace manifests, and `packages/dsh-hive-swarm/` native bundle.
- `assets/hive-swarm-icon.png`, `assets/hive-swarm-icon.svg`, README banner/flow artwork, and lossless light/dark demo captures.
- `docs/releases/1.8.0-qualification.md`, `docs/releases/1.8.0-artifacts.json`, `docs/releases/1.8.0-validation.json`, and `docs/releases/1.8.0-publication.json` recording published 1.8.0 verification across Windows/macOS/Linux CI and installed Windows Codex CLI `0.169.1` / DeepSeek Harness Desktop `0.2.2-rc.5`.

## Product Principles

1. Show actionable evidence and precise blockers.
2. Reuse coordination behavior across hosts while keeping host ownership explicit.
3. Make installation and removal predictable and preserve user data.
4. Keep existing host navigation, themes, permissions, and companion plugins working.
5. State capability limits honestly; never replace missing native support with an undisclosed fallback.
