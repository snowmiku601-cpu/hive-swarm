<div align="center">
  <img src="./assets/hive-swarm-banner.svg" alt="Hive Swarm — multi-agent coordination for AI agents" width="100%" />

  <p><strong>One goal. A team of agents. A shared board for every handoff.</strong></p>

  <p>
    <img src="https://img.shields.io/badge/runtime-Node.js%20%E2%89%A522.5-75baef?style=flat-square" alt="Node.js 22.5 or newer" />
    <img src="https://img.shields.io/badge/dependencies-0-55cbb2?style=flat-square" alt="Zero dependencies" />
    <img src="https://img.shields.io/badge/tests-121%20passing-91d4a2?style=flat-square" alt="121 tests passing" />
    <img src="https://img.shields.io/badge/version-1.7.4-f6bc55?style=flat-square" alt="Version 1.7.4" />
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-b3ce64?style=flat-square" alt="MIT license" /></a>
  </p>

  <p>
    <a href="#quick-start">🚀 Quick Start</a> ·
    <a href="#see-it-in-action">🖼️ See It in Action</a> ·
    <a href="#how-the-hive-moves-work">🧭 How It Works</a> ·
    <a href="#key-features">💡 Features</a> ·
    <a href="#running-tests">✅ Tests</a>
  </p>
</div>

---

Hive Swarm is a lightweight, single-folder **coordination engine and UI for AI agents**. Split a goal across workers, coordinate dependencies, inspect live activity, and trace each result back to its handoff on a shared board.

The MCP core is independent of the worker harness. **The current runtime adapter supports Codex Desktop and Codex CLI.** Future adapters can connect the same board to Claude Code, DeepSeek Harness, OpenCode, Pi, ZCode, Kimi Code, and other agent harnesses.

The runtime stays deliberately small: pure Node.js ESM, built-in `node:sqlite`, and no third-party packages or `npm install` step.

## Quick Start

Requires **Codex Desktop or Codex CLI** and **Node.js >= 22.5** with built-in `node:sqlite`. The Windows installer can also find the Node runtime bundled with Codex Desktop.

### Windows (PowerShell)

```powershell
git clone https://github.com/snowmiku601-cpu/hive-swarm.git
cd hive-swarm
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Useful options:

- `-RunTests` runs the complete unit/integration suite with mocked runners before installing.
- `-NodePath "C:\path\to\node.exe"` selects a specific Node 22.5+ binary.

### macOS / Linux

```bash
git clone https://github.com/snowmiku601-cpu/hive-swarm.git
cd hive-swarm
chmod +x ./install.sh
./install.sh
```

Pass `--test` to run the suite first: `./install.sh --test`.

After installing, open a new Codex Desktop chat so the fresh MCP session loads `v1.7.4`. An older daemon with active turns refuses shutdown; let those turns finish before upgrading.

## See it in action

See what is running, what needs your attention, and where each result came from. The captures below use representative local demo data.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/overview-dark.jpg" />
    <img src="./assets/overview-light.jpg" alt="Hive Swarm Overview with a concise goal, ranked alerts, worker progress, and post links" width="100%" />
  </picture>
</p>

### Four views of the same swarm

<table>
  <tr>
    <td align="center" width="50%"><a href="./assets/overview-light.jpg"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/overview-dark.jpg" /><img src="./assets/overview-light.jpg" alt="Overview with goal progress and ranked alerts" width="100%" /></picture></a><br/><sub><strong>Overview</strong> · goal, progress, alerts, and the next action</sub></td>
    <td align="center" width="50%"><a href="./assets/board-light.jpg"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/board-dark.jpg" /><img src="./assets/board-light.jpg" alt="Board with channel filters, messages and stall diagnostics" width="100%" /></picture></a><br/><sub><strong>Board</strong> · searchable messages, mentions, and evidence</sub></td>
  </tr>
  <tr>
    <td align="center" width="50%"><a href="./assets/members-light.jpg"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/members-dark.jpg" /><img src="./assets/members-light.jpg" alt="Members with a crowned coordinator, worker status and journal controls" width="100%" /></picture></a><br/><sub><strong>Members</strong> · live status, journals, and Needs you state</sub></td>
    <td align="center" width="50%"><a href="./assets/graph-light.jpg"><picture><source media="(prefers-color-scheme: dark)" srcset="./assets/graph-dark.jpg" /><img src="./assets/graph-light.jpg" alt="Graph replay with elapsed time and directed mention counts" width="100%" /></picture></a><br/><sub><strong>Graph</strong> · replay the message flow and find silent handoffs</sub></td>
  </tr>
</table>

<details>
<summary><strong>Look inside a worker journal</strong></summary>

Follow saved turns and live activity without opening or interrupting the worker's chat.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/journal-dark.jpg" />
    <img src="./assets/journal-light.jpg" alt="Journal modal with two saved worker turns, step labels and verified reports" width="100%" />
  </picture>
</p>
</details>

## How the hive moves work

<p align="center"><img src="./assets/hive-swarm-flow.svg" alt="Goal to coordinator to workers to verified board handoff flow" width="100%" /></p>

## Key features

| What you need | What Hive Swarm provides |
| --- | --- |
| Coordinate independent work | Roles, dependencies, up to 12 workers, and per-member chats |
| Keep handoffs moving | Direct, group, channel and broadcast mentions |
| Understand a stalled run | Ranked alerts with post references and root blockers |
| Follow progress | Live steps, saved journals, Overview and graph replay |
| Control the run | Turn budgets, model selection, pause, retire and worktree cleanup |

<details>
<summary><strong>Runtime and implementation details</strong></summary>

- **Cross-harness MCP core:** `engine.mjs` provides the SQLite WAL scheduler, `@mention` / `@group` / `@all` / `@#channel` routing, dependency tracking through `waitFor`, zero-token `wait_for_board`, shared-checkout locking, and turn budgets.
- **Swappable runtime:** `codex.mjs` runs each member in its own Codex `app-server` chat with thread persistence, warm forks for model changes, automatic archival, and live SSE activity.
- **Actionable Overview:** a concise goal header, expandable full brief, one-line “now” summaries, ranked attention items, post links, mention shortcuts, budget actions, milestones, and coordinator summary.
- **Root-cause stall diagnostics:** one `[stall]` system post per stalled episode identifies unaddressed results by `#seq`, unanswered mentions, quota/failure stops, dependency roots, and circular waits without starting a diagnostic model turn.
- **Four-tab Hive UI:** Overview, Board, Members, and Graph share the same saved events, with safe Markdown, channels, journals, model controls, worktree actions, and responsive light/dark themes.
- **Graph replay:** elapsed span, direct/group mentions, collapsed or expanded broadcasts, dashed rings for members who posted without outgoing mentions, and layouts tuned for small teams and dense swarms.
- **Isolated Git worktrees:** writable workers can work in separate detached checkouts from a shared committed base, with cleanup that protects uncommitted changes.
- **Pixel bee roster:** a gold crowned coordinator, tinted workers, and crisp sleeping `Zzz` poses make responsibility and state readable at a glance.
- **Windows portability:** preserves the v1.7.3 MSIX fixes, including `childEnvironment()`, Windows `features.prefer_mxc=false`, portable `.mcp.json` `cwd: "."`, legacy `CodexTeamBoard` / `codex-team-board` identity, port `17943`, `/ready`, `/shutdown`, and both installers.

</details>

## Usage

In a local project chat in Codex Desktop:

1. Type `/swarm` or `$hive-swarm:swarm` followed by the task:

   ```text
   $hive-swarm:swarm Review this repository, fix edge-case bugs, and run verification tests.
   ```

2. Specify a model when needed (`Use <model> ...`), or omit it for the runtime default.
3. In a Goal run, use `coordinator: false` so the main Goal chat remains the sole coordinator polling with zero-token `wait_for_board`.
4. In a regular single-turn chat, set `coordinator: true` when a background `@coordinator` should summarize completed worker rounds.
5. Open **🐝 Open Swarm UI** to watch live steps, inspect member Journals, switch models, clean completed worktrees, or steer directly with `@mentions`.

## Repository layout

The plugin stays in one unified repository root:

- `.agents/plugins/marketplace.json` and `.codex-plugin/plugin.json` — plugin metadata
- `.mcp.json` — portable MCP configuration (`node ./server.mjs`)
- `engine.mjs`, `server.mjs`, `codex.mjs`, `worktrees.mjs` — board engine and runtime adapter
- `board.html`, `board.css`, `board.js`, `hive-bees.js`, `hive-graph.js` — standalone and MCP App UI
- `assets/` — README banner, coordination diagram, and verified UI captures
- `LICENSE` — MIT license
- `skills/swarm/` — `/swarm` skill prompt and agent metadata
- `install.ps1`, `install.sh` — cross-platform installers
- `*.test.mjs` — the complete `node:test` suite

## Running tests

```bash
node --test ./*.test.mjs
```

The suite uses mocked runners and makes no paid API calls. The UI, graph, transcript reader, and stall monitor do not schedule diagnostic model turns. Adding turns or sending an `@mention` remains an explicit user action.

## Troubleshooting notes

- **Windows sandbox process errors:** the installer and runtime strip inherited MSIX/session markers and set `features.prefer_mxc=false` on Windows so workers can run shell commands and `node_repl` cleanly.
- **Vitest `spawn EPERM` in Windows worker sandboxes:** for Vitest projects, use `--configLoader native --pool threads` to avoid child-process pool restrictions.
- **Opening a live worker chat:** Codex Desktop may hold one writer lock per active thread. Use **View journal** in the Hive UI to follow progress without interrupting the turn.
- **State and upgrades:** board state lives in SQLite WAL under `%LOCALAPPDATA%\CodexTeamBoard` on Windows or `~/CodexTeamBoard` on macOS/Linux. Override with `HIVE_SWARM_DATA` or `TEAM_BOARD_DATA`. The default loopback port is `17943` (`HIVE_SWARM_PORT` / `TEAM_BOARD_PORT`). Older compatible daemons shut down for upgrade only after active turns settle.

## License

Licensed under the [MIT License](./LICENSE). Copyright © 2026 snowmiku601-cpu.
