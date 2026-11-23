# Hive Swarm for DeepSeek Harness

Native hidden subagent swarms and a bee-marked **Swarm** Start card, right-dock tab, and full React dashboard for **DSH `0.2.2-rc.5`**. Pins the matching `hive-swarm@2.2.0` core; React and native SDK services are supplied by the Host.

## Highlights in `2.2.0` (experimental)

- **Hidden Native Subagents & Sandbox Parity:** Non-worktree workers run as hidden native DSH child subagents (`ctx.subagents.startActivation`, zero workspace sidebar clutter) and resume quietly via `ctx.agents.resume` + `followup`. Writable workers inherit `'danger-full-access'` when the parent session is `'danger-full-access'` (preventing Windows `workspace-write` `spawn EPERM`) while locking `writable: false` strictly to `'read-only'`, filtering non-restrictable tools before `tools.restrict`, and denying `sandbox_permissions` escalation.
- **`parallelWriters` vs `worktreeMode: "local"`:** Use `worktreeMode: "local"` (`worktree: true`) for isolated branches under `<repoRoot>/.hive-swarm-worktrees/<teamId>/<member>`, or `parallelWriters: true` (`concurrency` `1..8`) when concurrent writers own disjoint paths in the shared checkout. Queued workers surface explicit `blockedReason` badges (`Waiting for shared writer`, `Concurrency limit`, `Waiting on deps`).
- **`900s` `wait_for_board` & `RunStore.abandon()`:** Long-poll up to `900s` without 45s polling loops (`inputRequired` wakes immediately via `wokeBy: "input"`, compact timeout payloads, `kind: "status"` wake exclusion). `cancel_turn` and `resolve_recovery(action: "dismiss")` settle pending runs cleanly in `runs.sqlite`, and Turn-1 subagent tool visibility + `session/fork-unavailable` fallback handle early-turn starts smoothly.
- **Specialized Honeycomb React UI:** Groups **Overview** `Threads` and **Graph · Hive** hex cells exclusively by outcome (`threads` → `group`/`channels` → status) with Ring-2 support, wrapped titles, curved Bézier connectors, self-loops, focus dimming, `blockedReason` pills, **Board** Markdown/`#seq` jumps, **Members** (`Subagent`/`Session` badges, `Open session`, **Journal** with `✓ Verified route:` proof), **Mentions** ring, and pure-JS **Export GIF** — bundled minified under `205 KB` (`client/dist.js`).

## Install & Usage

Close DeepSeek Harness Desktop and let DSH manage its profile:

```sh
dsh plugin --profile desktop add dsh-hive-swarm@2.2.0
```

Run `/hive-swarm` in an authorized workspace chat to launch a team (use `hive_swarm_read_board({ seqs })` to inspect cited posts and `hive_swarm_retire_member({ dropDependency: true })` to unblock retired upstream dependencies). Opening Swarm or reading a Journal never starts a model turn.

- **Windows confinement note:** Windows DSH reports shell enforcement as `partial` (read-only writes denied; `workspace-write` follows DSH's policy and NTFS ACL limits).
- **State isolation:** Stored under `<profileContext.dir>/.hive-swarm`, completely separate from Codex. Removal keeps sessions, journals, and Hive data intact.

[Source and full documentation](https://github.com/snowmiku601-cpu/hive-swarm) · MIT license
