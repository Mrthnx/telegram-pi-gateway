# Telegram media support — Engram mirror

Source of truth: `odd/tasks/telegram-media-support.md`

## Status
in_progress

## Tasks
- [x] T1 (S1, S3) Attach inbound images natively to the Pi prompt. Commit: feat(telegram): attach inbound images natively to the Pi prompt.
- [x] T2 (S1) Transcribe inbound voice notes and audio files with a local engine. Commit: feat(telegram): transcribe inbound voice notes and audio files.
- [x] T3 (S2) Add the `telegram_send_media` Pi tool. Commit: feat(pi): add the telegram_send_media tool.
- [x] T4 (S2) Reply with voice notes using macOS say. Commit: feat(telegram): reply with voice notes.
- [ ] T5 (S2) Generate images through a Pi image model. Dropped by owner decision: out of scope.

## Owner decisions
- Inbound audio: local engine (mlx-whisper or whisper.cpp). The audio never leaves the machine.
- Outbound audio: local neural engine (Piper), with macOS `say` as the fallback that always works.
- Pi-native image generation: out of scope.

## Notes
- Images are natively supported end to end: `PromptOptions.images` takes `ImageContent[]` and `minimax/MiniMax-M3` declares `input: ["text","image"]`.
- Audio cannot reach Pi as audio: `pi-ai` has no audio content type. Inbound audio needs a transcription step in front of Pi.
- Outbound voice notes need no credential: macOS `say` plus ffmpeg produces the OGG/OPUS that `sendVoice` requires.
- Pi-native image generation is blocked: all 60 image models live under the `openrouter` provider and the owner has no openrouter credential.
- The owner decides the STT provider, the TTS provider, and whether image generation is in scope.
- The tool is scoped to the active project plus the gateway data directory, and paths are resolved through `realpath` before the containment check so a symlink cannot escape.
- `sendVoice` only renders for OGG+OPUS, MP3 and M4A; any other audio format is delivered as a document.
