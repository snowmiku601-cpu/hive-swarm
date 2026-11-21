# Hive Swarm

Version **__HIVE_SWARM_VERSION__**. Coordinate dependent agent tasks with a shared board, outcome threads, live activity, owned journals, and message-flow graphs.

The core and Codex runtime use Node.js ESM, built-in SQLite, and **zero third-party runtime dependencies**. Required Node range: `^22.19.0 || >=24.2.0`.

Hive Swarm **__HIVE_SWARM_VERSION__** pairs `hive-swarm@__HIVE_SWARM_VERSION__` (core + Codex) with `dsh-hive-swarm@__HIVE_SWARM_VERSION__` (experimental native DeepSeek Harness `0.2.2-rc.5` bundle). Both tarballs are verified against their source artifacts before publication.

## Codex lifecycle

```sh
npx hive-swarm@latest doctor --host codex
npx hive-swarm@latest install --host codex
npx hive-swarm@latest update --host codex
# Finish active work and close Codex before applying a staged update:
npx hive-swarm@latest update --host codex --after-close
npx hive-swarm@latest uninstall --host codex
```

`npm install` only installs package files; it does not register a plugin. The explicit CLI creates an immutable persistent marketplace copy and delegates host changes to supported Codex CLI commands. Local switching/rollback is qualified for CLI `0.169.1`; other versions retain the stage unless `--allow-unqualified-cli` is explicitly passed. Active owned turns block replacement. Uninstall preserves databases, journals, and verified release copies. Doctor does not execute Codex by default or call models.

DSH uses the separate `dsh-hive-swarm` bundle and its own profile manager. Install the matching experimental `0.2.2-rc.5` bundle with `dsh plugin --profile desktop add dsh-hive-swarm@__HIVE_SWARM_VERSION__` (or `@next`). Release `__HIVE_SWARM_VERSION__` brings an Antigravity-style Overview (task summary accordion, `goalLine`, `taskLabel`, outcome `threads` progress bars, and `Screenshots` timeline), Dual-Mode **Graph** (**`Hive`** honeycomb + **`Mentions`** capsule ring + zero-dependency **Export GIF**), hidden native DSH subagents (`executionMode: 'subagent'`), and attached Codex `0.171+` child threads (`executionMode: 'attached'`). Its Windows shell retains the Host's partial confinement limits. `--host dsh` prints guidance without editing a DSH profile.

[Full documentation and high-resolution screenshots](https://github.com/snowmiku601-cpu/hive-swarm#see-it-in-action) · [Source and issue tracker](https://github.com/snowmiku601-cpu/hive-swarm) · MIT license
