# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People coordinating AI-agent work in a local software workspace. The maintainer uses Codex Desktop and DeepSeek Harness Desktop and wants other users to install Hive Swarm conveniently.

## Product Purpose

Turn one user-requested goal into bounded worker assignments, coordinate dependencies and mentions, and make progress, blockers and evidence inspectable through one shared board.

## Positioning

Hive Swarm combines a persistent coordination engine, per-member host sessions, explicit wakeups, turn budgets, saved journals and replayable message flow. The coordination engine is distinct from its worker-harness adapter.

## Operating Context

- Current shipped repository: Node.js ESM, built-in SQLite, zero third-party runtime dependencies, Codex adapter, standalone/MCP App UI and local installers.
- Current UI: Overview, Board, Members, Graph and worker Journal; representative demo screenshots are labeled as demo evidence.
- Requested next capabilities: npm distribution and a native DeepSeek Harness integration, with compatible existing UI enhancements. These are requested work, not shipped functionality.
- The user identified the DSH right-side Start launcher list as a required entry point: a native `Swarm` card with the existing bee icon, registered when the DSH npm bundle activates.
- On November 20, 2026, the user approved placing that native card immediately above More tools, aligned with the existing cards.
- The maintainer explicitly requested a design for approval before implementation on November 19, 2026.
- On November 20, 2026, the maintainer approved the full design and implementation using the already selected Hive Swarm workflow. Publication and model-backed qualification remain separate release gates.

## Capabilities and Constraints

- Preserve existing Codex workflows, stored teams, identities and Windows portability fixes.
- Agents start only on user-authorized work. Looking at the board must not start a model turn.
- Keep host credentials and private conversations under their host's control.
- Packaging, native UI integration and native worker execution require separate evidence; one does not prove the others.
- Existing Node minimum and future compatibility ranges require correction and executable verification during the planned release work.

## Brand Commitments

Hive Swarm name, crowned coordinator bee, distinct worker bees, existing restrained gold identity and English product copy. Conversation with this maintainer is Vietnamese. Host integration should respect the surrounding application's conventions.

## Evidence on Hand

- `README.md`, runtime sources, six test files and Codex plugin/marketplace manifests.
- `assets/hive-swarm-icon.png`, `assets/hive-swarm-icon.svg`, README banner/flow artwork and lossless light/dark demo captures.
- Installed DeepSeek Harness Desktop 0.2.2-rc.5; its plugin manifests and version-pinned upstream extension contracts were inspected read-only.
- No claim that a Hive Swarm npm package or DSH-native plugin has already been published or qualified.

## Product Principles

1. Show actionable evidence and precise blockers.
2. Reuse coordination behavior across hosts while keeping host ownership explicit.
3. Make installation and removal predictable and preserve user data.
4. Keep existing host navigation, themes, permissions and companion plugins working.
5. State capability limits honestly; never replace missing native support with an undisclosed fallback.
