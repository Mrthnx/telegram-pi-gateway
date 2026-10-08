# Telegram inline interactions

## Goal
Let Pi sessions initiated through Telegram ask the owner bounded questions with inline buttons or free-text replies.

## Tasks
- [x] Design and wire a Telegram interaction bridge for Pi custom tools.
  - Evidence: `src/telegram/interactions.ts` owns pending owner questions and `src/index.ts` shares it between bot and Pi sessions.
- [x] Expose a Pi custom tool that asks the Telegram owner a question with optional choices and free-text.
  - Evidence: `src/pi/session-manager.ts` registers `telegram_ask_owner` via `customTools`.
- [x] Route Telegram inline callbacks and free-text replies back to pending Pi questions.
  - Evidence: `src/telegram/bot.ts` handles `pi:answer`, `pi:free-text`, and calls `tryResolveText` before normal prompts.
- [x] Capture final assistant text from SDK events before falling back to session state.
  - Evidence: `src/telegram/bot.ts` collects `message_update`, `message_end`, and `agent_end` text before using `getLastAssistantText()`.
- [x] Verify TypeScript compilation.
  - Evidence: `bun run typecheck` passed.

## Constraints
- Do not expose hidden reasoning, raw tool arguments/results, credentials, or full console transcripts to Telegram.
- Inline button approval is authenticated by the configured owner, but tool success is not global permission outside the exact answered prompt.
- No git commit unless explicitly requested by the user.
