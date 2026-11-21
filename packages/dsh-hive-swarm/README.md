# Hive Swarm for DeepSeek Harness

Native worker sessions and a bee-marked **Swarm** Start card, right tab, and full panel for **DSH 0.2.2-rc.5**. The package pins the matching `hive-swarm` core. React and native SDK services are supplied by the Host.

This is the **experimental `2.0.0` release** for DSH `0.2.2-rc.5` (native hidden child subagents via `ctx.subagents.startActivation` and `ctx.agents.resume` Turn 2+ continuations with zero workspace sidebar clutter, synchronous fail-closed sandbox & tool-restriction locks, `fork: "coordinator"`, exact box-clipped Graph arrows, and Design DNA UI overhaul). The core/build/native test suite passes on Windows, macOS, and Linux; live DSH Desktop qualification is Windows-specific.

Close Desktop and let DSH manage its profile:

```sh
dsh plugin --profile desktop add dsh-hive-swarm@2.0.0
```

Use the native `/hive-swarm` skill for requested teams (pass `fork: "coordinator"` when a worker should inherit the active parent chat). Opening Swarm or reading a Journal does not start a model. Select an exact team in its workspace; the four views are **Overview** (progress, outcome threads, milestones, alerts), **Board** (safe Markdown, `#seq` jumps, channels, live activity), **Members** (`Subagent`/`Session` badges, model controls, recovery, worktree cleanup, `SubagentAddress` **Open session** with **Journal** fallback), and **Graph** (exact box-clipped flow inspection and replay). Worker Journals render host-verified `✓ Verified route:` pills, and native tool results can open their Host-verified team directly.

Non-worktree workers run as hidden native DSH child subagents (`ctx.subagents.startActivation`, zero workspace sidebar clutter) and enforce read-only or workspace-write sandboxing synchronously inside `subagent/start` before Turn 1 executes (failing closed on any violation). Turn 2+ resumes quietly via `ctx.agents.resume` + `followup` without waking the parent user chat, while `worktree: true` and fallback workers use `session/create` with clean pinned titles. Hive never changes global model defaults or grants wider roots; unknown outcomes remain **Needs you** with explicit **Retry fresh turn** and **Dismiss** recovery controls rather than automatically repeating potentially paid work.

Windows DSH reports shell enforcement as `partial`. Real probes verified allowed reads, denied read-only file/shell writes, and workspace file boundaries. Workspace-write follows DSH's policy, including its platform temporary directories; this package does not claim stronger confinement than the Host supplies.

State is isolated under the active Host's `<profileContext.dir>/.hive-swarm`. The Codex database and other plugins are not migrated. Plugin removal retains sessions, journals, and Hive data. Use DSH's supported manager for updates and version-pinned rollback; do not edit its profile manifest or lockfile by hand.

[Source and full documentation](https://github.com/snowmiku601-cpu/hive-swarm) · MIT license
