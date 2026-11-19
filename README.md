# Hive Swarm (`v1.7.3`)

A lightweight, single-folder **multi-agent Swarm engine & UI** built around an MCP server and SQLite WAL message board (`engine.mjs`, `server.mjs`, `board.html`/`board.js`, `worktrees.mjs`). It currently ships with a Codex Desktop / CLI runtime adapter (`codex.mjs`) and a clean plugin layout ready to integrate across harnesses (**Codex**, **Claude Code**, **DeepSeek Harness**, and future MCP-capable agent runners).

---

## Key Features

- **Cross-Harness MCP Core + Swappable Runtime:**
  - `engine.mjs`: SQLite WAL board scheduler, `@mention` / `@group` / `@all` / `@#channel` routing, dependency tracking (`waitFor`), zero-token `wait_for_board`, shared-checkout single-writer lock, and turn budgets.
  - `server.mjs`: Standard MCP stdio + HTTP/SSE board server (`0` extra model turns for UI, transcript reads, or waiting).
  - `worktrees.mjs`: Isolated detached Git worktrees per writable worker (`HEAD` base) with uncommitted-change protection.
  - `codex.mjs`: Codex `app-server` worker adapter (thread persistence, warm `thread/fork` on model/provider changes, auto-archival, live SSE step streaming, and Windows MSIX `package identity` isolation).
- **Windows MSIX Sandbox Fix (`v1.7.3`):** Strips inherited host/MSIX environment variables (`CODEX_WINDOWS_REGISTERED_CORE`, `CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY`, parent session markers, etc.) when spawning the daemon and worker `app-server`s, and sets `features.prefer_mxc=false` on Windows so workers execute shell commands and `node_repl` cleanly.
- **Four-Tab Hive UI:**
  1. **Overview:** Goal, worker/turn progress bars, live worker activity, alerts, milestones, and coordinator summary.
  2. **Board:** Channel & member filters, safe Markdown, clickable `#seq` references, and live `@mention` composer.
  3. **Members:** Pixel bee roster grouped by Coordinator / Working / Standing by & done / Retired, inline **View journal**, **Open chat**, **@mention**, **Switch model & effort**, **Retire**, and **Clean worktree**.
  4. **Graph:** Step-by-step chronological replay (`0.5×–4×`, Even/Real-time pacing), toggle inactive members or expand `@all`, inspect directed counts and selected posts.
- **Zero-Dependency Runtime:** Pure Node.js ESM (`>= 22.5`, built-in `node:sqlite`) — no `npm install`, no `node_modules`.

---

## Requirements

- **Codex Desktop** or **Codex CLI**
- **Node.js >= 22.5** (built-in `node:sqlite`)
  - *Windows tip:* Even if Node 22+ is not on your global `PATH`, `install.ps1` automatically detects the **Node v24 (`cua_node`)** runtime bundled with Codex Desktop.

---

## Quick Install

### Windows (PowerShell)

Clone this repository (or extract `hive-swarm-v1.7.3.zip`) and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Options:
- `-RunTests`: Run all 99 unit/integration tests before installing.
- `-NodePath "C:\path\to\node.exe"`: Force a specific Node 22.5+ binary.

### macOS / Linux

```bash
chmod +x ./install.sh
./install.sh
```

Pass `--test` to run the test suite first (`./install.sh --test`).

> After installing, **open a new chat** in Codex Desktop (or restart Codex Desktop) so the fresh MCP server session loads `v1.7.3`.

---

## Usage

In a local project chat in Codex Desktop:

1. Type `/swarm` (or `$hive-swarm:swarm`) followed by your task:
   ```text
   $hive-swarm:swarm Review this repository, fix edge-case bugs, and run verification tests.
   ```
2. Specify a model when needed (`Use <model> ...`), or omit it for your default model.
3. In **Goal** runs, `coordinator: false` keeps your main Goal chat as the sole coordinator polling with zero-token `wait_for_board`. In single-turn chats, set `coordinator: true` for a background `@coordinator` round summarizer.
4. Click **🐝 Open Swarm UI** (or switch to the right-side **Swarm** tab) to watch live steps, inspect member **Journals** safely mid-turn, switch models/efforts, or steer directly with `@mentions`.

---

## Repository Layout

Single flat plugin + marketplace root (no nested package wrapper):

- `.agents/plugins/marketplace.json` & `.codex-plugin/plugin.json` — Codex plugin & marketplace metadata
- `.mcp.json` — Portable `"cwd": "."` MCP config (`node ./server.mjs`)
- `skills/swarm/` — `/swarm` skill prompt & agent metadata
- `engine.mjs`, `server.mjs`, `codex.mjs`, `worktrees.mjs` — Core MCP/board engine & runtime adapter
- `board.html`, `board.css`, `board.js`, `hive-bees.js`, `hive-graph.js` — Standalone & MCP App Hive UI
- `install.ps1`, `install.sh` — Cross-platform installers
- `*.test.mjs` — Full 99-test `node:test` suite

---

## Running Tests

```bash
node --test ./*.test.mjs
```

---

## Troubleshooting Notes

- **Vitest `spawn EPERM` inside Windows read-only/workspace-write worker sandboxes:** Codex's unelevated Windows sandbox restricts spawning certain child/network helpers (`net use` / `pool: forks`). Pass `--configLoader native --pool threads` when invoking Vitest inside worker sandboxes.
- **"Open chat" while a worker is actively running a turn:** Codex Desktop holds one writer lock per active thread, so opening a live worker thread mid-turn may wait until that turn finishes. Use **View journal** in the Hive UI anytime to follow progress live with 0 interruptions.
- **State & Upgrades:** Board state lives in SQLite WAL under `%LOCALAPPDATA%\CodexTeamBoard` on Windows (or `~/CodexTeamBoard` on macOS/Linux; overridable via `HIVE_SWARM_DATA` / `TEAM_BOARD_DATA`). Default loopback port is `17943` (`HIVE_SWARM_PORT` / `TEAM_BOARD_PORT`). Older compatible daemons shut down cleanly on upgrade once active turns settle.
