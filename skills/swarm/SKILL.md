---
name: swarm
description: "Start one coordinated Hive Swarm run from a task. Use for the swarm slash-menu entry, $hive-swarm:swarm, or an explicit request to launch a Swarm."
---

Use the task after this skill mention as the team goal. If the user supplied a task, start the team directly.

With no task, or with `board` or a request to show the board, use `open_swarm_panel`. Use the specified team ID. If the user gives a title, find its ID with `list_teams` and ask which group they mean if several match. With no specified team, use the team already opened in this chat, or pass the current project's absolute `cwd` to find its latest team. If the project has no teams, open the returned empty panel and say that it is ready for a task.

1. Use the current local project's absolute path. Preserve the user's file scope, deliverables, and limits in the team goal and member briefs. Use the requested model or the current chat's model if known. Otherwise omit the model for the runtime default. Resolve explicitly requested member models and efforts through `list_models`.
2. Choose member names and assignments yourself. Split independent work across workers and give each clear file ownership and an expected result. Use one worker for a tightly coupled change. Give a verifier whose work needs a completed diff a `waitFor` list of the responsible workers and an explicit check to run. The verifier can ask a worker for a correction on the board and wait for the revised report. Use `group` for several members sharing one role. Give write access only to assignments that need edits.
3. Call Hive Swarm's `start_team` once with that goal and member plan. In a Goal, set `coordinator: false` so the current chat is the sole coordinator. In a regular one-turn chat, set `coordinator: true` only when you want `@coordinator` to summarize completed worker rounds in the background. Respect the user's turn cap. Set a team `effort` or per-member `model` and `effort` when requested. When the user requests separate Git worktrees, use `worktree: true` for the selected members and explain they start from the committed Git revision. Keep changes in their respective worktrees until the user asks for integration.
4. After creating or locating the group, use the Codex app tool `open_in_codex` with the exact `openInCodex` arguments returned by Hive Swarm. This opens the live browser tab on the right of the calling chat. Pass no `threadId` unless the user explicitly asks for another chat. If the host has no panel tool or it reports an error, use `open_board` as the inline MCP App for a team. In either case give the user a clickable Markdown link labeled `🐝 Open Swarm UI` to the returned `url` so they can reopen that exact group. Give the work split and actual team status after starting.

For an explicit request to inspect, message, pause, or resume an existing team, use the corresponding Hive Swarm tool instead of creating a second team.

In a Goal, use `wait_for_board` with the last seen `since` cursor. Read reports, post next assignments and continue until the goal is done. When `hasMore` is true, continue from the last returned post. A stopped phase can be returned immediately. Act on it before issuing the next wait. Respect the user's turn limit and inspect blockers when the team stalls.

Use `manage_channel` to split discussion by workstream and subscribe the relevant workers. Main is always visible. Post with `channel` and use `@#channel` to reach its subscribers. Use `n` for identical shards and `tasks` for distinct slices. Keep at most 12 workers active and use a shard group name to retire the group when its dependencies are complete.

Use `set_team_title` for a requested rename. The Overview uses board data and the latest `@coordinator` summary when present. Standalone Swarm also supports model changes, two-step retirement, title changes and clean worktree removal.

Post coordination messages to the board. Ask workers to start finished reports with `[done]` and cite earlier posts with `#seq`, such as `#12`. Use `board_history` with a cursor to read earlier posts.

For roster changes, look up the team first. Use `add_member` to invite a worker and `replaces` to transfer an idle worker's dependencies. The main chat, coordinator and workers can pass `fork` with a teammate's name to reuse their saved chat. A fork inherits the complete source chat. Read-only workers can invite read-only helpers. Use `retire_member` to stop scheduling a member.

Use `set_member_model` for a model or effort change. Pass `effort: null` when the user asks for the selected model's default. Set `resume: true` when the user asks for an idle worker to continue now. Mention that the runtime can create a history-preserving fork for a provider change.

Use `remove_worktree` when the user asks to clean a checkout after its member retires or its team completes. Set `force: true` only when the user explicitly asks to discard uncommitted changes. The user can add eight turns from the board when the team is out of turns.
