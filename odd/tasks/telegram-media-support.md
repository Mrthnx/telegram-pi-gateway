# Telegram media support

## Goal

Let the Telegram gateway accept images and audio from the owner, and let Pi answer with images and audio when asked. The feasibility review that produced this plan is in the Log; the short version is that images are natively supported end to end, while audio needs a transcription step in front of Pi and a speech step in front of Telegram.

## Specs

### S1

> "quisiero que acepte audio y imagenes"

The gateway must accept inbound media from the owner and hand it to Pi. Images arrive as Telegram photos or as image documents; audio arrives as Telegram voice notes or audio files.

### S2

> "También que me pueda responder audio o imágenes si le pido"

Pi must be able to deliver media back to the owner over Telegram, not only describe it in text.

### S3

> "Revisa la factibilidad"

The plan must state, per capability, whether it is feasible with the current Pi SDK, the current Telegram Bot API, the locally installed tooling, and the credentials the owner actually has.

### S4

> "Y el plan de trabajo"

The work must be decomposed into reviewable units, each with its own commit.

## Feasibility

| Capability | Verdict | Evidence |
| --- | --- | --- |
| Inbound image → Pi | Feasible, no new credentials | `PromptOptions.images?: ImageContent[]` exists in the SDK (`core/agent-session.d.ts:174`); `ImageContent` is `{type:"image", data:string(base64), mimeType:string}` (`pi-ai/dist/types.d.ts:277`); `minimax/MiniMax-M3` declares `input: ["text","image"]` |
| Inbound audio → Pi | Feasible only with a transcription step | `pi-ai` has no audio content type; the only "audio" token in the whole package is a pricing field. Voice notes are OGG/Opus, so Pi cannot consume them directly |
| Outbound image → Telegram | Feasible, no new credentials | grammy `sendPhoto`/`sendDocument` accept `InputFile` (path, Buffer, ReadStream); Bot API upload limit is 50 MB |
| Outbound audio → Telegram | Feasible with zero credentials | `sendVoice` requires OGG+OPUS, MP3 or M4A; macOS `say` produces AIFF/M4A and ffmpeg converts to mono OGG/OPUS 48 kHz (verified locally) |
| Pi-native image generation | Feasible but needs a new credential | `ModelRuntime.generateImages()` exists; 60 image models exist, all under the `openrouter` provider, and the owner is not authenticated with openrouter |

Blocked decisions, owned by the owner: the speech-to-text provider for inbound audio, the text-to-speech provider for outbound audio, and whether image generation is in scope at all.

## Owner decisions

- 2026-11-02: inbound audio is transcribed with a **local** engine (mlx-whisper or whisper.cpp). The audio never leaves the machine.
- 2026-11-02: outbound audio is synthesized with **macOS `say`**, so it needs no credentials and no network call.
- 2026-11-02: Pi-native image generation is **out of scope**. The agent delivers the files it produces; generating them is the agent's own job.

## Tasks

- [x] T1 (S1, S3) Attach inbound images natively to the Pi prompt instead of only referencing the downloaded file. Inline. Commit: `feat(telegram): attach inbound images natively to the Pi prompt`.
  - Evidence: `src/telegram/media.ts` downloads the media, detects the image mime type with the SDK `detectSupportedImageMimeTypeFromFile` and builds the inline `ImageContent` payload; `src/telegram/bot.ts` passes it to `session.prompt()` through `PromptOptions.images`. `modelSupportsImages` checks the active model before promising the owner the picture was seen. 16 new tests in `src/telegram/media.test.ts`, 26 in total, all green.
  - Commit: `feat(telegram): attach inbound images natively to the Pi prompt`.
  - Slice boundary: this unit closed at 581 authored changed lines, over the ~400-line review target. It was kept as one unit because the code, its tests and the document that describes them are the same behavior; the remaining units (T2, T3, T4, T5) each stay under the target on their own.
- [x] T2 (S1) Accept inbound voice notes and audio files: download, normalize with ffmpeg, transcribe, then prompt Pi with the transcript. Inline. Commit: `feat(telegram): transcribe inbound voice notes and audio files`.
  - Evidence: `src/telegram/audio.ts` normalizes any container to 16 kHz mono PCM WAV with ffmpeg and looks for a local engine in this order: `mlx-whisper`, `whisper.cpp`, the `openai-whisper` CLI, and finally an explicit `TELEGRAM_STT_COMMAND`. `src/telegram/bot.ts` handles `message:voice` and `message:audio`, and reports clearly when no engine is installed instead of dropping the audio.
  - Verified end to end on 2026-11-02 with `whisper.cpp` and the `ggml-base.bin` model: a Spanish note synthesized with the macOS voice Mónica, encoded as OGG/OPUS exactly like a Telegram voice note, transcribed back verbatim in 920 ms. `whisper-cli` runs with `-l auto` because its default language is English and `ggml-base.en.bin` is an English-only model.
- [x] T3 (S2) Add a `telegram_send_media` Pi tool so the agent can deliver any local file to the owner as a photo, a document or a voice note. Inline. Commit: `feat(pi): add the telegram_send_media tool`.
  - Evidence: `src/telegram/media.ts` resolves the delivery kind from the extension, enforces the Bot API upload ceilings (10 MB for a photo, 50 MB for a document or a voice note) and resolves the path through `realpath` before checking containment, so a symlink cannot escape the project. `src/telegram/interactions.ts` `sendMedia` performs the upload. `src/pi/session-manager.ts` registers the tool per session, scoped to the active project plus the gateway data directory.
- [x] T4 (S2) Turn a text answer into a voice note: synthesize, convert to OGG/OPUS, send. Inline. Commit: `feat(telegram): reply with voice notes`.
  - Evidence: `src/telegram/audio.ts` `synthesizeVoiceNote` drives macOS `say` and encodes the result as mono OGG/OPUS at 48 kHz, which is the format Telegram renders as a playable voice note. The requested voice is validated against the list macOS actually exposes, because `say` accepts an unknown voice name with exit code 0 and silently falls back to the default one. `src/pi/session-manager.ts` registers the `telegram_send_voice` tool, which reuses the path guards of `telegram_send_media`.
  - Slice boundary: the inbound transcription unit closed at 535 authored changed lines, over the ~400-line target, because the download, normalization, detection and failure handling are one behavior. The outbound unit that follows stays at 186 lines.
- [ ] T5 (S2) Generate images through a Pi image model and deliver them. Dropped on 2026-11-02 by owner decision: out of scope for this feature.

## Constraints

- Media files downloaded from Telegram stay under `DATA_DIR`; nothing is written outside it.
- Files sent to Telegram must live inside the active project, or inside `DATA_DIR`, so the tool cannot be used to exfiltrate arbitrary paths.
- The transcription and speech steps must never log raw audio or transcripts containing secrets beyond what the owner already sent in chat.
- The `telegram_ask_owner` tool stays the only path for owner decisions; `telegram_send_media` never asks for confirmation.
- Telegram download limit is 20 MB and the upload limit is 50 MB; both are enforced before transfer, not after.
- The gateway must degrade instead of failing: a photo with a non-vision model must still be saved and reported, not dropped silently.

## Log

### L1 — 2026-11-02, original request

> "ok arma commit de cada cosa porque quiero añadir cosas nuevas"

That request closed the previous unit of work (the pending commits) and is recorded in `odd/tasks/` history.

### L2 — 2026-11-02, this feature's request

> "manda a master y luego sigamos con la siguiente tarea, quisiero que acepte audio y imagenes. Tambien que me pueda responder audio o imagenes si le pido. Revisa la factibilidad. Y el plan de trabajo"

### L3 — 2026-11-02, feasibility findings

- `PromptOptions.images` accepts `ImageContent[]`; the SDK path for inbound images needs no new dependency and no new credential.
- `minimax/MiniMax-M3` declares `input: ["text","image"]`, but `minimax/MiniMax-M2.7` declares `input: ["text"]`. A gateway pinned to a text-only model must say so instead of dropping the image silently, which is what the SDK `read` tool does today.
- `pi-ai` exposes no audio content type, so inbound audio cannot reach Pi as audio. It must be transcribed before the prompt.
- The owner has Pi credentials for `minimax` and `openai-codex` only. There is no openrouter credential, so Pi-native image generation is currently blocked.
- macOS `say` plus ffmpeg covers outbound voice notes with no credential at all; verified locally that `say` writes AIFF and M4A and that ffmpeg produces mono OGG/OPUS at 48 kHz.
- Telegram constraints confirmed against the Bot API reference: `getFile` downloads up to 20 MB, uploads up to 50 MB, and `sendVoice` only renders as a playable voice note for OGG+OPUS, MP3 or M4A.
- The SDK's public `resizeImage` is unusable in this runtime: its worker path resolves Photon to null and the in-process fallback only runs when the worker throws, not when it resolves null. `resizeImageInProcess` works but is not exported by the package and the deep import is blocked by the package `exports` map. T1 therefore attaches the raw bytes under a 5 MB cap instead of resizing; the downscale path belongs with the ffmpeg work that the audio unit needs anyway.
- `sendVoice` only renders as a playable voice note for OGG+OPUS, MP3 and M4A, so the tool falls back to `sendDocument` for any other audio format instead of sending something Telegram will show as a broken attachment.
- macOS `say` accepts an unknown voice name with exit code 0 and synthesizes with the default voice, so the gateway validates the requested voice against the list `say -v ?` exposes instead of trusting the exit code.
- The macOS speech service occasionally fails to start and `say` exits non-zero with no output; the synthesis retries once before giving up.
- The `openai-whisper` CLI and the `whisper.cpp` CLI have confusingly similar names, so detection checks `whisper-cli` first for whisper.cpp and `whisper` for the openai one. The Homebrew formula is `whisper.cpp`, not `whisper-cpp`.
- `whisper-cli` defaults to the English language and needs the multilingual `ggml-base.bin`; the English-only `ggml-base.en.bin` would mistranscribe. The gateway passes `-l auto` and looks for the multilingual model first.
- `whisper-cli` fails with a bare "1 input file(s) failed" when the directory it has to write the transcript into does not exist, and it still prints the timings, so the failure looks like a decoding problem. The gateway creates the scratch directory before running the engine.
