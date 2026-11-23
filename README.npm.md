# Hive Swarm

Version **__HIVE_SWARM_VERSION__**. Coordinate dependent AI-agent tasks across Codex Desktop/CLI and DeepSeek Harness with a shared board, outcome threads, specialized honeycomb graphs, owned journals, and deterministic run settlement.

The core and Codex runtime use Node.js ESM, built-in `node:sqlite`, and **zero third-party runtime dependencies**. Required Node range: `^22.19.0 || >=24.2.0`.

Hive Swarm **__HIVE_SWARM_VERSION__** pairs `hive-swarm@__HIVE_SWARM_VERSION__` (core + Codex, `latest`) with `dsh-hive-swarm@__HIVE_SWARM_VERSION__` (experimental native DeepSeek Harness `0.2.2-rc.5` bundle, `next`). Both tarballs are cryptographically verified against their source artifacts before publication.

## What's new in __HIVE_SWARM_VERSION__

- **Specialized Honeycomb Cells & Replay Parity:** `projectHive` groups workers exclusively by `threads` → `group`/`channels` → status (`Working`, `Waiting`, `Needs you`, `Done`), supporting Ring-1/Ring-2 layouts up to 18 outer hexes, wrapped multi-line titles, curved Bézier outer connectors, cubic intra-hex self-loops, interactive focus dimming, `blockedReason` pills, and 1:1 pure-JS `GIF89a` export.
- **Parallel Writers & Local Worktrees:** Pass `parallelWriters: true` for disjoint shared-checkout writers (`concurrency` up to `8`) or `worktreeMode: "local"` to place isolated branches under `<repoRoot>/.hive-swarm-worktrees/<teamId>/<member>` with automatic `.git/info/exclude` registration.
- **Clean Cancellation & Durable Settlement:** `RunStore.abandon()` + automatic SQLite WAL `runs` migration settle cancelled and dismissed runs cleanly (`settled = 1`), and `CodexRunner.run({ signal })` wires `AbortSignal` directly to `turn/interrupt`.
- **Board & Dependency Controls:** Fetch cited `#seq` posts directly via `read_board({ seqs })`, unblock downstream chains cleanly with `retire_member({ dropDependency })`, and suppress spurious wakes from `kind: "status"` internal posts.
- **DSH Sandbox & Turn-1 Hardening (`dsh-hive-swarm`):** Writable DSH subagents inherit parent `danger-full-access` on Windows (while `writable: false` remains strictly `read-only`), `wait_for_board` supports up to `900s` with `inputRequired` wakes, and Turn-1 subagent/fork races are eliminated.

## Codex lifecycle

```sh
npx hive-swarm@latest doctor --host codex
npx hive-swarm@latest install --host codex
npx hive-swarm@latest update --host codex
# Finish active work and close Codex before applying a staged update:
npx hive-swarm@latest update --host codex --after-close
npx hive-swarm@latest uninstall --host codex
```

`npm install` has no install scripts and never registers a plugin automatically. The explicit CLI copies verified package files into `<CODEX_HOME>/hive-swarm/versions/<version>/marketplace` and delegates registration to Codex CLI (`0.169.1` qualified by default; pass `--allow-unqualified-cli` on newer CLI builds). Uninstall retains databases, journals, and verified releases; `doctor` is read-only and never invokes models.

For DeepSeek Harness `0.2.2-rc.5`, close Desktop and run `dsh plugin --profile desktop add dsh-hive-swarm@__HIVE_SWARM_VERSION__` (or `@next`). Windows DSH keeps the Host's partial shell confinement limits.

[Full documentation and 2× Retina screenshots](https://github.com/snowmiku601-cpu/hive-swarm#see-it-in-action) · [Source and issue tracker](https://github.com/snowmiku601-cpu/hive-swarm) · MIT license
