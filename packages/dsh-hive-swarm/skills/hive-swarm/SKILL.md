---
name: hive-swarm
description: Coordinate a user-requested native DeepSeek Harness worker team and open its Swarm views.
---

Use this skill when the user asks for a Hive Swarm or to inspect an existing native team. Read operations and opening the panel never start a model.

Use the current chat as coordinator. Call `hive_swarm_list_models` before choosing a requested model or effort; never silently substitute another model. Preserve the user's scope, limits, permissions, and preferred model in the team and member briefs. Optionally configure `fallbackModel` / `fallbackEffort` on the team or member when the user explicitly wants automatic quota failover.

To start requested work, call `hive_swarm_start_team` with the current chat's actual workspace, a clear goal, bounded turn limit, optional outcome `threads` (`[{id, title, goal, members}]`), and members with disjoint file ownership (`writable`, `worktree`, `waitFor`, `group`, `channels`, `n`, `tasks`). Set `coordinator:false` when the current chat or goal coordinates the work. Workers default to read-only; request workspace-write only for user-authorized edits. Encourage direct peer-to-peer handoffs (`@builder` <-> `@verifier`) in briefs rather than routing every intermediate check through `@coordinator`. Update outcome threads at any time via `hive_swarm_set_team_plan`. This host uses ordinary native DSH sessions; do not launch an external MCP board or a second scheduler.

Use `hive_swarm_board_status`, `hive_swarm_read_board`, and `hive_swarm_board_history` to inspect a known team. Use `hive_swarm_open_swarm_panel` for its exact team identity, or open the bee-marked Swarm card in Start and explicitly select the team. Never pick the latest team globally or claim another session's history. Keep the native DSH theme and workspace context.

Post handoffs with `hive_swarm_post_message`; treat `@name` as a wakeup doorbell, not a CC (write plain names in prose and use `@name` only for members who need to act next). Scope member, channel, and model changes to the existing goal. Pause stops new dispatch; it does not cancel a running worker. A timeout or missing response is not proof that native work stopped. Inspect the saved owned run/Journal before acting, then resolve it explicitly with `hive_swarm_resolve_recovery` (`action: "retry"` or `"dismiss"`).

As a worker, finish by calling `hive_swarm_set_turn_outcome` for the assigned Hive turn with `state`, a concise `message`, `notify`, and `waitFor`. Start finished reports with `[done]` and cite earlier posts with `#seq`. Do not double-post the same final report via `hive_swarm_post_message` before calling `hive_swarm_set_turn_outcome`. The Host publishes the report only after matching durable claim/end, host quiescence, and a successful persistence flush. Other workers cannot impersonate your identity or outcome.

Use the native Overview, Board, Members, Graph, and owned Journal to explain progress. Preserve existing sessions, user data, and unrelated plugins. Do not publish packages, expose credentials, change global model defaults, or broaden permissions as part of coordination.
