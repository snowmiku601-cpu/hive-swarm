<div align="center">
  <img src="./assets/hive-swarm-banner.svg" alt="Hive Swarm — multi-agent coordination for AI agents" width="100%" />

  <p><strong>One goal. A team of agents. A shared board for every handoff.</strong></p>

  <p>
    <a href="https://github.com/snowmiku601-cpu/hive-swarm/actions/workflows/ci.yml"><img src="https://github.com/snowmiku601-cpu/hive-swarm/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
    <a href="https://www.npmjs.com/package/hive-swarm"><img src="https://img.shields.io/badge/npm-hive--swarm%401.9.0-f6bc55?style=flat-square" alt="npm hive-swarm 1.9.0" /></a>
    <a href="https://www.npmjs.com/package/dsh-hive-swarm"><img src="https://img.shields.io/badge/DSH%20(next)-dsh--hive--swarm%401.9.0-9a7138?style=flat-square" alt="npm dsh-hive-swarm 1.9.0 next" /></a>
    <img src="https://img.shields.io/badge/runtime-Node.js%2022.19%20%7C%2024.2%2B-75baef?style=flat-square" alt="Node.js 22.19 or 24.2 and newer" />
    <img src="https://img.shields.io/badge/core_runtime_dependencies-0-55cbb2?style=flat-square" alt="Zero core runtime dependencies" />
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-b3ce64?style=flat-square" alt="MIT license" /></a>
  </p>

  <p>
    <a href="#quick-start">🚀 Quick Start</a> ·
    <a href="#see-it-in-action">🖼️ See It in Action</a> ·
    <a href="#how-the-hive-moves-work">🧭 How It Works</a> ·
    <a href="#key-features">💡 Features</a> ·
    <a href="#usage">💬 Usage</a> ·
    <a href="#development-and-tests">✅ Tests</a> ·
    <a href="./CHANGELOG.md">📋 Changelog</a>
  </p>
</div>

---

Hive Swarm is a lightweight **multi-agent coordination engine and UI** for AI coding assistants. Split a goal across focused workers, let builders and verifiers hand work directly to each other on a shared board, track outcomes and live steps, and trace every result back to its handoff.

The coordination core (`engine.mjs`, `core.mjs`, `run-store.mjs`) is harness-agnostic:

- **Codex Desktop & Codex CLI (`hive-swarm@1.9.0`, npm `latest`)** — full MCP server, per-member Codex `app-server` sessions, inline MCP App, and standalone four-tab board UI.
- **DeepSeek Harness Desktop `0.2.2-rc.5` (`dsh-hive-swarm@1.9.0`, npm `next`, experimental)** — native DSH sessions, permission-scoped tools, bee-marked **Swarm** Start card, right-dock tab, and full React panel.

The core runtime uses **Node.js ESM**, built-in `node:sqlite`, and **zero third-party runtime dependencies**. Pinned `devDependencies` are only used to build and test the DSH client bundle (React is supplied by DSH at runtime).

## Quick Start

Requires **Node.js `^22.19.0 || >=24.2.0`** and either **Codex Desktop / Codex CLI** or **DeepSeek Harness Desktop `0.2.2-rc.5`**.

| Host | Published package | Status | Worker & UI model |
| --- | --- | --- | --- |
| **Codex Desktop / CLI** | `hive-swarm@1.9.0` (`latest`) | Production adapter; lifecycle qualified on CLI `0.169.1` | Per-member Codex sessions, inline MCP App & standalone 4-tab board |
| **DeepSeek Harness `0.2.2-rc.5`** | `dsh-hive-swarm@1.9.0` (`next`) | Experimental; built on `1.8.0` Windows Desktop smoke qualification + full UI parity | Native DSH sessions, Start card, right tab & full React panel |

### 1. Codex Desktop / CLI (via npm — recommended)

`npm install` has **no install hooks** and never modifies your Codex profile automatically. Use the explicit `hive-swarm` CLI commands:

```sh
# Read-only environment check (does not launch Codex or call models)
npx hive-swarm@latest doctor --host codex

# Install persistent verified plugin copy and register with Codex
npx hive-swarm@latest install --host codex
```

Lifecycle commands:

```sh
# Stage an update safely while Codex may be running
npx hive-swarm@latest update --host codex

# Apply staged update after active turns finish and Codex is closed
npx hive-swarm@latest update --host codex --after-close

# Remove plugin registration (retains SQLite boards, journals, and verified releases)
npx hive-swarm@latest uninstall --host codex
```

> **Note on Codex CLI versions:** Local version switching and rollback are verified against Codex CLI `0.169.1`. On newer Codex CLI versions, `update --host codex --after-close` keeps the verified candidate staged by default unless you pass `--allow-unqualified-cli`. Installation copies verified files into `<CODEX_HOME>/hive-swarm/versions/<version>/marketplace` (never pointing Codex at a transient `npx` cache) and refuses to overwrite existing unmanaged installations without migration guidance.

After installing or updating, open a **new Codex Desktop chat** so the fresh MCP session loads the installed version.

### 2. DeepSeek Harness Desktop `0.2.2-rc.5` (Experimental)

DSH manages plugins through its own profile manager. Close DSH Desktop, then run:

```sh
dsh plugin --profile desktop add dsh-hive-swarm@1.9.0
```

- `npx hive-swarm@latest install --host dsh` prints this command and never edits a DSH profile directly.
- Native DSH state lives under `<profileContext.dir>/.hive-swarm` (completely separate from Codex).
- Read-only and workspace-write workers enforce permissions through DSH's native Agent presets. On Windows, DSH reports shell confinement as **partial**; see the [1.8.0 qualification report](docs/releases/1.8.0-qualification.md) for verified probes and platform limits.

### 3. Install from source (Codex)

<details>
<summary><strong>Windows (PowerShell)</strong></summary>

```powershell
git clone https://github.com/snowmiku601-cpu/hive-swarm.git
cd hive-swarm
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Options:
- `-RunTests` — run the mocked test suite before installing
- `-NodePath "C:\path\to\node.exe"` — pin a compatible Node 22.19 or 24.2+ binary (the wrapper also checks Codex Desktop's bundled Node runtime)
- `-CodexPath "C:\path\to\codex.exe"` — select a specific Codex CLI binary

</details>

<details>
<summary><strong>macOS / Linux</strong></summary>

```bash
git clone https://github.com/snowmiku601-cpu/hive-swarm.git
cd hive-swarm
chmod +x ./install.sh
./install.sh
```

Pass `--test` to run the test suite first (`./install.sh --test`).

</details>

## See it in action

See what is running, which outcome threads are blocked or done, and where each result came from. The captures below use representative local demo data exported as lossless 2× PNGs. Click **Light PNG / Dark PNG** to view originals at full resolution.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/overview-dark.png" />
    <img src="./assets/overview-light.png" alt="Hive Swarm Overview with a concise goal, ranked alerts, worker progress, and post links" width="100%" />
  </picture>
</p>

<p align="center"><a href="./assets/overview-light.png">Light PNG</a> · <a href="./assets/overview-dark.png">Dark PNG</a></p>

### Four views of the same swarm

<table>
  <tr>
    <td align="center" width="50%"><a href="./assets/overview-light.png"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/overview-dark.png" /><img src="./assets/overview-light.png" alt="Overview with goal progress and ranked alerts" width="100%" /></picture></a><br/><sub><strong>Overview</strong> · goal, outcome threads, progress, ranked alerts, and next actions<br/><a href="./assets/overview-light.png">Light PNG</a> · <a href="./assets/overview-dark.png">Dark PNG</a></sub></td>
    <td align="center" width="50%"><a href="./assets/board-light.png"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/board-dark.png" /><img src="./assets/board-light.png" alt="Board with channel filters, messages and stall diagnostics" width="100%" /></picture></a><br/><sub><strong>Board</strong> · searchable Markdown feed, channels, mentions, and `#seq` jumps<br/><a href="./assets/board-light.png">Light PNG</a> · <a href="./assets/board-dark.png">Dark PNG</a></sub></td>
  </tr>
  <tr>
    <td align="center" width="50%"><a href="./assets/members-light.png"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/members-dark.png" /><img src="./assets/members-light.png" alt="Members with a crowned coordinator, worker status and journal controls" width="100%" /></picture></a><br/><sub><strong>Members</strong> · live steps, Journals, model switching, recovery, and worktrees<br/><a href="./assets/members-light.png">Light PNG</a> · <a href="./assets/members-dark.png">Dark PNG</a></sub></td>
    <td align="center" width="50%"><a href="./assets/graph-light.png"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/graph-dark.png" /><img src="./assets/graph-light.png" alt="Graph replay with elapsed time and directed mention counts" width="100%" /></picture></a><br/><sub><strong>Graph</strong> · replay message flow, timing, and spot silent handoffs<br/><a href="./assets/graph-light.png">Light PNG</a> · <a href="./assets/graph-dark.png">Dark PNG</a></sub></td>
  </tr>
</table>

<details>
<summary><strong>Look inside a worker journal</strong></summary>

Follow saved turns and live activity without opening or interrupting the worker's chat.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/journal-dark.png" />
    <img src="./assets/journal-light.png" alt="Journal modal with two saved worker turns, step labels and verified reports" width="100%" />
  </picture>
</p>
<p align="center"><a href="./assets/journal-light.png">Light PNG</a> · <a href="./assets/journal-dark.png">Dark PNG</a></p>
</details>

## How the hive moves work

<p align="center"><img src="./assets/hive-swarm-flow.svg" alt="Goal to coordinator to workers to verified board handoff flow" width="100%" /></p>

- **Direct peer-to-peer handoffs:** workers can wake each other directly via `@member`, `@group`, `@#channel`, or `@all` — a `@builder` can hand straight to `@reviewer`, and `@reviewer` can request fixes from `@builder` without bouncing every turn through `@coordinator`.
- **Wakeup doorbell discipline:** `@name` wakes a teammate (and writes plain names in prose when only referencing them), preventing accidental wasted turns.
- **Explicit dependencies & zero-token waits:** workers with `waitFor` stay queued until every upstream member reports `[done]`, and coordinators block on `wait_for_board` without burning model tokens.

## Key features

| What you need | What Hive Swarm provides |
| --- | --- |
| Coordinate parallel & dependent work | Up to 12 active workers, `waitFor` dependencies, sharding (`n`/`tasks`), groups, channels, and per-member sessions |
| Direct peer collaboration | `@member`, `@group`, `@#channel`, and `@all` routing with normalized target matching |
| Track outcomes, not just logs | Progress bars, milestones, coordinator summaries, and optional outcome `threads` (`Blocked` → `Active` → `Queued` → `Done`) |
| Understand a stalled or uncertain run | Zero-token `[stall]` root-cause diagnostics, ranked alerts with `#seq` links, and explicit `Retry fresh turn` / `Dismiss` recovery for unconfirmed runs |
| Flexible model routing | Per-member `model` and `effort`, runtime model switching with warm forks, and optional `fallbackModel` quota failover |
| Safe isolation & cleanup | Read-only default workers, optional detached Git `worktree` per writable worker, and uncommitted-safe worktree removal |

<details>
<summary><strong>Runtime and implementation details</strong></summary>

- **Cross-harness core (`engine.mjs`, `core.mjs`, `run-store.mjs`):** SQLite WAL scheduler, `@mention` / `@group` / `@all` / `@#channel` routing, dependency tracking (`waitFor`), outcome `threads` (`set_team_plan`), opt-in quota failover (`fallbackModel` / `fallbackEffort`), durable run admission/settlement evidence, explicit recovery (`resolve_recovery`), shared-checkout write locking, and bounded turn budgets.
- **Codex adapter (`codex.mjs`, `server.mjs`):** runs each member in its own Codex `app-server` chat with thread persistence, activity-resetting idle turn timeouts (`HIVE_SWARM_TURN_TIMEOUT_MS`), warm forks for provider/model changes, automatic archival, and live SSE activity.
- **Native DSH adapter (`packages/dsh-hive-swarm/`):** Cordis plugin for DSH `0.2.2-rc.5` with host-minted Gateway peers, per-session preset sandbox verification, worker-scoped tool visibility, Start launcher card, right-dock tab, full React panel, safe Markdown rendering, `#seq` jump links, progress bars, outcome threads, Graph playback, and owned Journals.
- **Root-cause stall diagnostics:** one `[stall]` system post per stalled episode identifies unaddressed results by `#seq`, unanswered mentions, quota/failure/recovery stops, dependency roots, and circular waits without starting a diagnostic model turn.
- **Windows portability:** handles `.cmd` Node shims directly without `cmd.exe`, strips inherited MSIX/session markers via `childEnvironment()`, sets `features.prefer_mxc=false` on Windows, keeps portable `.mcp.json` `cwd: "."`, and preserves legacy `CodexTeamBoard` / port `17943` compatibility.

</details>

## Usage

### In Codex Desktop / CLI

1. Start a team from a local project chat with `/swarm` or `$hive-swarm:swarm`:

   ```text
   $hive-swarm:swarm Review this repository, fix edge-case bugs, and run verification tests.
   ```

2. Specify a model when needed (`Use <model> ...`), or let the launcher pick from `list_models` (or inherit the runtime default).
3. In a **Goal**, use `coordinator: false` so your main Goal chat stays the sole coordinator polling with zero-token `wait_for_board`. In a single-turn chat, set `coordinator: true` when you want `@coordinator` to synthesize worker rounds in the background.
4. Click **🐝 Open Swarm UI** to follow live steps, inspect Journals, switch models, resolve unconfirmed runs, clean worktrees, or steer workers directly with `@mentions`.

### In DeepSeek Harness Desktop

1. Run `/hive-swarm` in an authorized workspace chat to start or inspect a native team.
2. Open the bee-marked **Swarm** card in Start (or click **Open Swarm** on a verified tool result) to inspect **Overview**, **Board**, **Members**, **Graph**, and owned **Journals** — opening the UI never starts a model turn.

<details>
<summary><strong>Advanced workflow example (peer-to-peer handoffs, worktrees, outcome threads &amp; quota failover)</strong></summary>

```text
$hive-swarm:swarm Split this feature into two isolated worktree builders (@api and @ui) and one read-only @reviewer who waits for both.
- Have @api and @ui hand off directly to @reviewer (and @reviewer request fixes directly from @api/@ui), notifying @coordinator only when verified or blocked.
- Group Overview into two outcome threads: "API contract" and "UI integration".
- Use a fallback model if the primary model hits quota limits.
```

</details>

## Repository layout

- `.agents/plugins/marketplace.json`, `.codex-plugin/plugin.json`, `.mcp.json` — Codex plugin metadata & portable MCP config
- `engine.mjs`, `core.mjs`, `run-store.mjs`, `worktrees.mjs` — harness-agnostic scheduler, host application layer, durable run store, and Git worktree manager
- `codex.mjs`, `server.mjs`, `cli.mjs`, `installer.mjs` — Codex `app-server` adapter, MCP/HTTP/SSE server, and npm lifecycle CLI
- `board.html`, `board.css`, `board.js`, `hive-bees.js`, `hive-graph.js` — standalone & inline MCP App UI
- `skills/swarm/` — Codex `/swarm` skill and agent metadata
- `packages/dsh-hive-swarm/` — native DeepSeek Harness plugin (`host.mjs`, `native.mjs`, `runner.mjs`, `routes.mjs`, `client/`, `skills/hive-swarm/`)
- `scripts/` — verified core/DSH packagers (`pack-core.mjs`, `pack-dsh.mjs`) and DSH client builder (`build-dsh-client.mjs`)
- `docs/releases/` — release qualification evidence and artifact manifests
- `install.ps1`, `install.sh` — cross-platform source installers
- `assets/` — banner, coordination diagram, icons, and lossless light/dark UI captures
- `*.test.mjs`, `packages/dsh-hive-swarm/*.test.mjs` — full `node:test` test suite

## Development and tests

```sh
# Run the complete core, Codex, CLI, packaging, and native DSH test suite
npm test

# Rebuild the native DSH React client bundle
npm run build:dsh

# Pack and cryptographically verify both npm tarballs locally
npm run pack:core
npm run pack:dsh
```

The test suite uses mocked runners and makes **no paid API calls**. Opening views, reading Journals, running `doctor`, and computing `[stall]` diagnostics never start a model turn.

## Troubleshooting notes

- **Codex CLI update qualification gate:** `hive-swarm update --host codex --after-close` defaults to verifying Codex CLI `0.169.1`. Pass `--allow-unqualified-cli` to apply a staged update on a newer Codex CLI build.
- **Long-running worker turns:** Codex worker turns use an activity-resetting idle timeout (default 20 minutes of inactivity, 60-minute hard cap, configurable via `HIVE_SWARM_TURN_TIMEOUT_MS`).
- **Windows sandbox process errors:** the installer and runtime strip inherited MSIX/session markers and set `features.prefer_mxc=false` on Windows so workers can run shell commands cleanly.
- **Vitest `spawn EPERM` in Windows worker sandboxes:** pass `--configLoader native --pool threads` to avoid child-process pool restrictions.
- **Opening a live worker chat:** Codex Desktop may hold one writer lock per active thread. Use **View journal** in the Hive UI to inspect progress without interrupting the turn.
- **State locations & ports:**
  - **Codex:** SQLite WAL under `%LOCALAPPDATA%\CodexTeamBoard` (Windows) or `~/CodexTeamBoard` (macOS/Linux); override with `HIVE_SWARM_DATA` / `TEAM_BOARD_DATA`. Default loopback port: `17943` (`HIVE_SWARM_PORT` / `TEAM_BOARD_PORT`).
  - **DSH:** isolated under `<profileContext.dir>/.hive-swarm`.

## License

Licensed under the [MIT License](./LICENSE). Copyright © 2026 snowmiku601-cpu.
