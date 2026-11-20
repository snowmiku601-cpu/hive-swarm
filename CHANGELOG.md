# Changelog

## 1.9.0 — published

Published on npm as `hive-swarm@1.9.0` (`latest`, 25 files, SHA-512 `sha512-xlev8HFaXvb5j9TDsQLNYPhsTWxsmvyPn+mqI+IRG0uP3kmk7RSqlEWk3Z3tYl1ah3DDoygiabShC0KAij/uJg==`) and `dsh-hive-swarm@1.9.0` (`next`, 10 files, SHA-512 `sha512-nZnuq3fjNNrVwMhSrDoGsGi4nN8WXNPbK3Xjh7fp5pi15KIIqmCMt+yS8Zp6z3Pi+O9ehfwwRJa82z1o5+jCiQ==`). Verified across 24/24 CI checks (Windows, macOS, Linux × Node 22.19.0, 24.2.0, 24.x, LTS; 264/264 tests).

### Coordination & Engine
- Normalize `notify` and `waitFor` member targets (strip leading `@`, lowercase, preserve `#channel`) in `engine.mjs` so `@member` targets always route and unlock dependencies reliably.
- Forward `mentionsOnly` filtering in `board.readPosts()`.
- Fix live-error `recoveryRequired` deadlock: preserve unconfirmed run evidence while cleaning up active slots, block `switchModel(..., {resume: true})` while unconfirmed, and add explicit `resolve_recovery` (`action: "retry" | "dismiss"`) across core, Codex server/UI, and native DSH host/UI.
- Add optional Antigravity-style outcome `threads` (`start_team.threads` and `set_team_plan`) ordered `Blocked` → `Active` → `Queued` → `Done` in both Codex and DSH Overviews.
- Add optional opt-in quota failover (`fallbackModel` / `fallbackEffort` on team or member) for automatic recovery on quota exhaustion without silent substitution when unconfigured.
- Validate effective inherited `(model, effort)` in `core.mjs` (`start_team`, `add_member`, `set_member_model`) and reset incompatible inherited `team.effort` cleanly when switching models.

### Codex Adapter, Security & CLI
- Replace hardcoded 20-minute wall-clock turn timeout with an activity-resetting idle timeout (`HIVE_SWARM_TURN_TIMEOUT_MS`, 20m default, 60m hard cap) in `codex.mjs`.
- Launch Windows `codex.cmd` shims directly via `process.execPath` without `cmd.exe`, and preserve `listModels()` provider metadata.
- Enforce `sec-fetch-site: same-origin` on standalone `GET /board/:id/status` and `GET /board/:id/history` endpoints, inject runtime version from `package.json` instead of a stale hardcoded version in `board.js`, and expose `board_history` and coordinator `set_team_plan` to peers.
- Add explicit `--allow-unqualified-cli` flag for `hive-swarm update --host codex --after-close` so users on newer Codex CLI builds can opt in while preserving default fail-closed qualification checks.
- Retry transient Windows `EPERM`/`EBUSY`/`EACCES` locks with backoff when promoting a staged release directory (`renameDirectory`) and during staging cleanup in `installer.mjs`, while still failing closed if the target already exists.
- Normalize embedded SVG and CSS line endings in `scripts/build-dsh-client.mjs` so `npm run build:dsh` produces byte-deterministic `client/dist.js` output across Windows and Unix line-ending settings.

### Native DSH Host, Runner & UI Parity
- Preserve detailed `turn/end` failure reasons in `correlateRun`, fix `member.effort === null` resolution to use model defaults instead of falling back to `team.effort`, and prevent premature `'failed'` reconciliation while the host reports an active/queued session.
- Make `workspaceAllowed` resilient to deleted unrelated workspace entries, hide owner-only tools from active DSH workers, and publish complete nested tool schemas in `host.mjs`.
- Bring native DSH React UI to parity with Codex UI: safe React Markdown renderer, clickable `#seq` post jumps, outcome threads, progress bars, milestones, inline team Rename, live activity strip, Follow toggle, `Clean worktree`, `effort: null` + `Resume now` in MemberEditor, Graph replay controls (`First`/`Prev`/`Play`/`Next`, pacing, speed, elapsed span, selected post), and explicit `Retry fresh turn` / `Dismiss` recovery actions.
- Enrich worker prompts and skills (`skills/swarm/SKILL.md`, `packages/dsh-hive-swarm/skills/hive-swarm/SKILL.md`) with peer-to-peer handoff guidance, `@name` wakeup-doorbell discipline, and no double-posting rules.

## 1.8.0 — published

- Add a zero-dependency npm core and explicit Codex install, update, uninstall and read-only doctor commands. Registration uses verified persistent copies, preserves data, and refuses replacement while owned work is active.
- Add shared host-scoped application contracts and durable native run evidence. Accepted prompts are correlated with their actual claim, outcome and turn end; uncertain runs are preserved for recovery.
- Add the experimental `dsh-hive-swarm` bundle for DSH 0.2.2-rc.5: native worker sessions, permission-scoped tools, the bee-marked Start card, right tab, full panel, four views and Journal.
- Keep worker identity through permission waits and restart recovery. Drain cancellation before releasing native guards or closing run evidence. Reject invalid outcomes before storing immutable reports.
- Preserve the Windows source installer's selected Node runtime and paginate the GET event stream without skipping backlog posts.

The experimental DSH release passed the approved Windows Desktop two-worker smoke; Windows shell enforcement remains partial and native DSH was not qualified on other operating systems. Core `hive-swarm@1.8.0` is published with the `latest` tag, and `dsh-hive-swarm@1.8.0` is published with the `next` tag. See [qualification](docs/releases/1.8.0-qualification.md) for evidence and platform limits. No Git release tag was created.
