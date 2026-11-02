# Telegram media support — Engram mirror

Source of truth: `odd/tasks/telegram-media-support.md`

## Status
in_progress

## Tasks
- [x] T1 (S1, S3) Attach inbound images natively to the Pi prompt. Commit: feat(telegram): attach inbound images natively to the Pi prompt.
- [ ] T2 (S1) Transcribe inbound voice notes and audio files. Blocked on the STT decision.
- [x] T3 (S2) Add the `telegram_send_media` Pi tool. Commit: feat(pi): add the telegram_send_media tool.
- [ ] T4 (S2) Reply with voice notes. Blocked on the TTS decision.
- [ ] T5 (S2) Generate images through a Pi image model. Blocked on the image-provider credential.

## Notes
- Images are natively supported end to end: `PromptOptions.images` takes `ImageContent[]` and `minimax/MiniMax-M3` declares `input: ["text","image"]`.
- Audio cannot reach Pi as audio: `pi-ai` has no audio content type. Inbound audio needs a transcription step in front of Pi.
- Outbound voice notes need no credential: macOS `say` plus ffmpeg produces the OGG/OPUS that `sendVoice` requires.
- Pi-native image generation is blocked: all 60 image models live under the `openrouter` provider and the owner has no openrouter credential.
- The owner decides the STT provider, the TTS provider, and whether image generation is in scope.
- The tool is scoped to the active project plus the gateway data directory, and paths are resolved through `realpath` before the containment check so a symlink cannot escape.
- `sendVoice` only renders for OGG+OPUS, MP3 and M4A; any other audio format is delivered as a document.
