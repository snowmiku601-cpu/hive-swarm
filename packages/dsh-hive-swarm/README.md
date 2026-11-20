# Hive Swarm for DeepSeek Harness

Native worker sessions and a bee-marked **Swarm** Start card, right tab and full panel for **DSH 0.2.2-rc.5**. The package pins the matching `hive-swarm` core. React and native SDK services are supplied by the Host.

This is an **experimental release candidate**. A passing unit suite or rendered panel does not qualify the full native worker flow. Desktop activation, theme/plugin coexistence and a real model-backed dependent-worker smoke must pass before claiming support. Publication and any paid smoke require the user's separate approval.

After registry publication and qualification, close Desktop and let DSH manage its profile:

```sh
dsh plugin --profile desktop add dsh-hive-swarm@1.8.0
```

Use the native `/hive-swarm` skill for requested teams. Opening Swarm or reading a Journal does not start a model. Select an exact team in its workspace; the four views are Overview, Board, Members and Graph. Native tool results can open their Host-verified team directly.

Workers require enforcing read-only or workspace-write services in their actual retained Agent preset. Hive never changes global model defaults or grants wider roots. It keeps one durable prompt identity, observes the matching native claim/end, and flushes the session before publishing a result. Unknown outcomes remain **Needs you** rather than automatically repeating potentially paid work.

State is isolated under the active Host's `<profileContext.dir>/.hive-swarm`. The Codex database and other plugins are not migrated. Plugin removal retains sessions, journals and Hive data. Use DSH's supported manager for updates and version-pinned rollback; do not edit its profile manifest or lockfile by hand.

[Source and full documentation](https://github.com/snowmiku601-cpu/hive-swarm) · MIT license
