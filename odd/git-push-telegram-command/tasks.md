# Telegram /push command — Engram mirror

Source of truth: `odd/tasks/git-push-telegram-command.md`

## Status
completed

## Tasks
- [x] Create `src/telegram/commands/push.ts` that registers the `/push` command and its `pi:push:*` callbacks.
- [x] Wire the command into `createTelegramBot` in `src/telegram/bot.ts`.
- [x] Document the new command in the `helpText()` output.
- [x] Verify TypeScript compilation with `bun run typecheck`.
- [x] Verify the git helper and preview logic end-to-end with a Bun smoke script.

## Notes
- No git commit step: this directory is not a Git repository. ODD work-unit commit is N/A; verification is `bun run typecheck` plus a Bun smoke test against a local bare remote.
- `git push` is dispatched by the gateway with `Bun.spawn`, not as a Pi tool call, so the `gentle-pi` shell guard does not see it.
- The ahead/behind delta uses cached upstream tracking refs. After someone else pushed, the local must `git fetch` first to see the new commits, otherwise the preview is stale and the push will fail.
