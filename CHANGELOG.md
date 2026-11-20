# Changelog

## 1.8.0 — release candidate

- Add a zero-dependency npm core and explicit Codex install, update, uninstall and read-only doctor commands. Registration uses verified persistent copies, preserves data, and refuses replacement while owned work is active.
- Add shared host-scoped application contracts and durable native run evidence. Accepted prompts are correlated with their actual claim, outcome and turn end; uncertain runs are preserved for recovery.
- Add the experimental `dsh-hive-swarm` bundle for DSH 0.2.2-rc.5: native worker sessions, permission-scoped tools, the bee-marked Start card, right tab, full panel, four views and Journal.
- Keep worker identity through permission waits and restart recovery. Drain cancellation before releasing native guards or closing run evidence. Reject invalid outcomes before storing immutable reports.
- Preserve the Windows source installer's selected Node runtime and paginate the GET event stream without skipping backlog posts.

The experimental DSH candidate passed the approved Windows Desktop two-worker smoke; Windows shell enforcement remains partial and DSH has not been qualified on other operating systems. The packages are published: core `1.8.0` is tagged `latest`, and `dsh-hive-swarm@1.8.0` is tagged `next`. See [qualification](docs/releases/1.8.0-qualification.md) for evidence and platform limits. No Git release tag was created.
