# Telegram /push command

## Goal

Let the owner trigger `git push` from Telegram without going through the Pi agent, so the shell guard in `gentle-pi` (which blocks `git push` because the SDK session has no interactive `ctx.ui`) does not interfere with delivery.

## Problem recap

- `gentle-pi` classifies `git push` as a guarded shell command and requires a fresh confirmation.
- When the Pi session is created via the SDK (`createAgentSession` from the gateway), the runner starts with `noOpUIContext`, so `ctx.hasUI === false`.
- The guard returns `block: true` with reason `"Gentle AI safety policy requires interactive confirmation before this command."` instead of calling `ctx.ui.confirm(...)`.
- The `telegram_ask_owner` custom tool is optional for the LLM, not the guard, so it does not satisfy the guard.
- The `/gentle:yolo enable` permission is only available from the interactive TUI, not from the gateway.

## Solution

Add a native Telegram command `/push` that runs `git push` **outside the Pi agent** through the gateway. This sidesteps the guard because the command is dispatched by the gateway itself, not as a tool call from the model.

Scope of the command (Option 1, simple):
- Plain `git push` only (no flags, no remote/branch arguments, no `--force`).
- Requires an active project selected via `/use`.
- Requires a confirmation step with inline buttons before execution.
- Runs in the active project's `cwd`.
- Uses `Bun.spawn(["git", "push"], { cwd })` to avoid shell injection.

Out of scope:
- `--force`, `--force-with-lease`, `-u`, custom remote/branch arguments, `git pull`, or any other git operation.
- A bridge that pretends to be UI for the Pi guard (would require a custom extension that runs before the guard; deferred).
- Activating YOLO mode from Telegram (not supported by `gentle-pi`).

## Tasks

- [x] Create `src/telegram/commands/push.ts` that registers the `/push` command and its `pi:push:*` callbacks.
  - Evidence: `src/telegram/commands/push.ts` exports `registerPushCommand(bot, store)`. It builds a preview with `readPushPreview` (is-inside-work-tree, current branch, `remote.origin.url`, ahead/behind via `rev-list ... @{u}...HEAD` with a no-upstream fallback to local `rev-list --count HEAD`), shows inline confirm/cancel buttons, and runs the push through `git()` which wraps `Bun.spawn`. Stdout/stderr are split via `splitTelegramMessage`.
- [x] Wire the command into `createTelegramBot` in `src/telegram/bot.ts`.
  - Evidence: `src/telegram/bot.ts` imports `registerPushCommand` and calls it inside `createTelegramBot` after the `reset`, `sessions`, `resume` commands.
- [x] Document the new command in the `helpText()` output.
  - Evidence: `src/telegram/bot.ts` `helpText()` now includes `"/push — hace \`git push\` del proyecto activo (con confirmación)"`.
- [x] Verify TypeScript compilation with `bun run typecheck`.
  - Evidence: `bun run typecheck` exits 0 from the gateway directory.
- [x] Verify the git helper and preview logic end-to-end.
  - Evidence: ran an out-of-tree Bun smoke script against a local bare remote covering 9 cases (no origin → throw, origin without upstream → ahead 1, push `-u origin main` to set upstream, plain `git push` reports "Everything up-to-date", commit + preview shows ahead 1, fetch + remote-ahead shows behind 1, non-git dir → throw). All assertions passed; the script was deleted after the run.

## Constraints

- Do not expose hidden reasoning, raw tool arguments/results, credentials, or full console transcripts to Telegram.
- Use `Bun.spawn` (no shell), and the command only ever calls `git push` with no extra arguments. The handler in `bot.ts` only ever calls `git(cwd, ["push"], timeout)`; there is no path that passes `--force`, `-u`, or any other flag.
- Bypass the Pi agent entirely; this command is owner-controlled delivery, not part of an ODD task.
- No git commit in this repo: the current working directory is not a Git repository, so the work-unit commit step of ODD is N/A. The change is verified by `bun run typecheck` and a Bun smoke test against a local bare remote.

## Verification

- `bun run typecheck` exits 0.
- Manual smoke test against the running gateway with a small throwaway repo:
  1. `/use <repo>` selects the project.
  2. A commit is created locally by the agent.
  3. `/push` shows the preview with branch name, remote URL, and number of commits ahead.
  4. "Cancelar" discards the push.
  5. "Push" runs `git push` and reports stdout/stderr split across Telegram messages.

## Caveats surfaced during implementation

- First push to a fresh remote needs `git push -u origin <branch>`. The plain `git push` command returns exit 128 with `fatal: The current branch ... has no upstream branch`. The stderr is forwarded to Telegram so the user sees the exact instruction; an explicit `/push -u` is out of scope.
- The ahead/behind delta is computed against the **cached upstream tracking refs**, not against the live remote. If someone else pushed since your last `git fetch`, the preview can be stale and the push itself will fail. The preview already warns about the "behind" case; the same caveat applies to the symmetric "remote has new commits you haven't fetched" case.
