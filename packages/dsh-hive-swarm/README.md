# Hive Swarm for DeepSeek Harness

Native worker sessions and a bee-marked **Swarm** Start card, right tab, and full panel for **DSH 0.2.2-rc.5**. The package pins the matching `hive-swarm` core. React and native SDK services are supplied by the Host.

This is the **experimental 1.8.0 release** on the npm `next` dist-tag. The installed rc.5 Windows Desktop passed a real River DeepSeek two-worker smoke: one verified report woke its dependent, both settled once, and Journal/session navigation retained the owned identities. Start card and native views were checked with Task Board, Git Graph, and Wallpaper Engine. The core/build suite passed on Windows, macOS, and Linux; live DSH qualification is Windows-specific.

Close Desktop and let DSH manage its profile:

```sh
dsh plugin --profile desktop add dsh-hive-swarm@1.8.0
```

Use the native `/hive-swarm` skill for requested teams. Opening Swarm or reading a Journal does not start a model. Select an exact team in its workspace; the four views are **Overview** (progress, outcome threads, milestones, alerts), **Board** (safe Markdown, `#seq` jumps, channels, live activity), **Members** (model controls, recovery, worktree cleanup), and **Graph** (animated replay and flow inspection). Native tool results can open their Host-verified team directly.

Workers require enforcing read-only or workspace-write services in their actual retained Agent preset. Hive never changes global model defaults or grants wider roots. It keeps one durable prompt identity, observes the matching native claim/end, and flushes the session before publishing a result. Unknown outcomes remain **Needs you** with explicit **Retry fresh turn** and **Dismiss** recovery controls rather than automatically repeating potentially paid work.

Windows DSH reports shell enforcement as `partial`. Real probes verified allowed reads, denied read-only file/shell writes, and workspace file boundaries. Workspace-write follows DSH's policy, including its platform temporary directories; this package does not claim stronger confinement than the Host supplies.

State is isolated under the active Host's `<profileContext.dir>/.hive-swarm`. The Codex database and other plugins are not migrated. Plugin removal retains sessions, journals, and Hive data. Use DSH's supported manager for updates and version-pinned rollback; do not edit its profile manifest or lockfile by hand.

[Source and full documentation](https://github.com/snowmiku601-cpu/hive-swarm) · MIT license
