import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Sample rate the whisper models expect. */
const WHISPER_SAMPLE_RATE = "16000";

const DEFAULT_TIMEOUT_MS = 120_000;

export type CommandOutcome = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string | undefined; timeoutMs?: number | undefined; stdin?: string | undefined },
): Promise<CommandOutcome> {
  const proc = Bun.spawn([command, ...args], {
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    ...(options?.stdin !== undefined ? { stdin: new TextEncoder().encode(options.stdin) } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });

  const killTimer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(killTimer);
  }
}

export async function runFfmpeg(args: string[]): Promise<void> {
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) {
    throw new Error("ffmpeg no está instalado. Es necesario para normalizar y codificar el audio.");
  }
  const outcome = await runCommand(ffmpeg, ["-y", "-loglevel", "error", ...args]);
  if (outcome.exitCode !== 0) {
    const detail = outcome.stderr.trim() || outcome.stdout.trim() || `código de salida ${outcome.exitCode}`;
    throw new Error(`ffmpeg falló: ${detail}`);
  }
}

/**
 * Converts any audio container into the 16 kHz mono PCM WAV that whisper
 * models expect.
 */
export async function normalizeAudioToWav(inputPath: string, outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await runFfmpeg(["-i", inputPath, "-ar", WHISPER_SAMPLE_RATE, "-ac", "1", "-c:a", "pcm_s16le", outputPath]);
}

export type Transcriber = {
  id: string;
  transcribe(args: { audioPath: string; workDir: string }): Promise<string>;
};

let cachedTranscriber: Transcriber | null | undefined;

/**
 * Finds a local speech-to-text engine.
 *
 * The audio never leaves the machine: the gateway looks for mlx-whisper,
 * whisper.cpp or the openai-whisper CLI, in that order, and falls back to an
 * explicit command when one is configured.
 */
export async function detectTranscriber(): Promise<Transcriber | null> {
  if (cachedTranscriber !== undefined) return cachedTranscriber;

  const configured = process.env.TELEGRAM_STT_COMMAND?.trim();
  if (configured) {
    cachedTranscriber = withWorkDir(configuredTranscriber(configured));
    return cachedTranscriber;
  }

  for (const candidate of [mlxWhisperTranscriber, whisperCppTranscriber, openAiWhisperTranscriber]) {
    const found = await candidate();
    if (found) {
      cachedTranscriber = withWorkDir(found);
      return cachedTranscriber;
    }
  }

  cachedTranscriber = null;
  return null;
}

/**
 * Makes sure the scratch directory exists before the engine runs.
 *
 * whisper.cpp needs it to write the transcript file and fails with a bare
 * "1 input file(s) failed" when the directory is missing.
 */
function withWorkDir(transcriber: Transcriber): Transcriber {
  return {
    id: transcriber.id,
    transcribe: async ({ audioPath, workDir }) => {
      await mkdir(workDir, { recursive: true });
      return transcriber.transcribe({ audioPath, workDir });
    },
  };
}

/** Only used by the tests, to drop the cached detection result. */
export function resetTranscriberCache(): void {
  cachedTranscriber = undefined;
}

function configuredTranscriber(command: string): Transcriber {
  let argv: string[];
  try {
    const parsed = JSON.parse(command) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((part) => typeof part !== "string")) {
      throw new Error("the command has to be a JSON array of strings");
    }
    argv = parsed as string[];
  } catch (error) {
    throw new Error(`TELEGRAM_STT_COMMAND is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    id: "configured",
    transcribe: async ({ audioPath, workDir }) => {
      const args = argv.map((part) =>
        part.replaceAll("{audio}", audioPath).replaceAll("{workdir}", workDir),
      );
      const outcome = await runCommand(args[0]!, args.slice(1), { cwd: workDir });
      if (outcome.exitCode !== 0) {
        const detail = outcome.stderr.trim() || outcome.stdout.trim() || "sin detalle";
        throw new Error(`El comando de transcripción falló: ${detail}`);
      }
      const fromFile = await readTranscriptFile(workDir, basename(audioPath, ".wav"));
      const transcript = fromFile ?? outcome.stdout.trim();
      if (!transcript) throw new Error("El comando de transcripción no devolvió texto.");
      return transcript;
    },
  };
}

async function mlxWhisperTranscriber(): Promise<Transcriber | null> {
  const python = Bun.which("python3");
  if (!python) return null;
  if (!(await pythonModuleAvailable(python, "mlx_whisper"))) return null;

  return {
    id: "mlx-whisper",
    transcribe: async ({ audioPath, workDir }) => {
      // mlx-whisper writes "<audio basename>.txt" next to the audio file and
      // detects the language on its own.
      const outcome = await runCommand(python, ["-m", "mlx_whisper", audioPath], { cwd: workDir });
      if (outcome.exitCode !== 0) {
        const detail = outcome.stderr.trim() || outcome.stdout.trim() || "sin detalle";
        throw new Error(`mlx-whisper falló: ${detail}`);
      }
      const transcript = await readTranscriptFile(workDir, basename(audioPath, ".wav"));
      if (!transcript) throw new Error("mlx-whisper no dejó un archivo de transcripción.");
      return transcript;
    },
  };
}

async function whisperCppTranscriber(): Promise<Transcriber | null> {
  const binary = Bun.which("whisper-cli") ?? Bun.which("whisper-cpp");
  if (!binary) return null;
  const model = await resolveWhisperCppModel();
  if (!model) return null;
  // whisper-cli defaults to English, which would mistranscribe a Spanish note.
  const language = process.env.TELEGRAM_STT_LANGUAGE?.trim() || "auto";

  return {
    id: "whisper.cpp",
    transcribe: async ({ audioPath, workDir }) => {
      const outputBase = join(workDir, "transcript");
      const outcome = await runCommand(binary, [
        "-m",
        model,
        "-f",
        audioPath,
        "-l",
        language,
        "-otxt",
        "-of",
        outputBase,
      ]);
      if (outcome.exitCode !== 0) {
        const detail = outcome.stderr.trim() || outcome.stdout.trim() || "sin detalle";
        throw new Error(`whisper.cpp falló: ${detail}`);
      }
      const transcript = await readTranscriptFile(workDir, "transcript");
      if (!transcript) throw new Error("whisper.cpp no dejó un archivo de transcripción.");
      return transcript;
    },
  };
}

async function openAiWhisperTranscriber(): Promise<Transcriber | null> {
  const binary = Bun.which("whisper");
  if (!binary) return null;
  const model = process.env.TELEGRAM_STT_MODEL?.trim() || "base";

  return {
    id: "openai-whisper",
    transcribe: async ({ audioPath, workDir }) => {
      const outcome = await runCommand(binary, [audioPath, "--model", model, "--output_format", "txt", "--output_dir", workDir]);
      if (outcome.exitCode !== 0) {
        const detail = outcome.stderr.trim() || outcome.stdout.trim() || "sin detalle";
        throw new Error(`whisper falló: ${detail}`);
      }
      const transcript = await readTranscriptFile(workDir, basename(audioPath, ".wav"));
      if (!transcript) throw new Error("whisper no dejó un archivo de transcripción.");
      return transcript;
    },
  };
}

async function pythonModuleAvailable(python: string, module: string): Promise<boolean> {
  const outcome = await runCommand(python, ["-c", `import ${module}`], { timeoutMs: 20_000 });
  return outcome.exitCode === 0;
}

async function resolveWhisperCppModel(): Promise<string | null> {
  const configured = process.env.TELEGRAM_WHISPER_MODEL?.trim();
  const candidates = configured
    ? [configured]
    : [
        join(process.env.HOME ?? "", ".cache", "whisper", "ggml-base.bin"),
        join(process.env.HOME ?? "", ".cache", "whisper", "ggml-base.en.bin"),
        join(process.env.HOME ?? "", ".cache", "whisper", "ggml-small.bin"),
      ];

  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function readTranscriptFile(workDir: string, baseName: string): Promise<string | null> {
  const candidates = [join(workDir, `${baseName}.txt`), join(workDir, "transcript.txt")];
  for (const candidate of candidates) {
    try {
      const content = (await readFile(candidate, "utf8")).trim();
      if (content.length > 0) return content;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

let cachedVoices: string[] | undefined;

/** The voices macOS exposes to `say`. */
export async function listSayVoices(): Promise<string[]> {
  if (cachedVoices) return cachedVoices;
  const say = Bun.which("say");
  if (!say) {
    cachedVoices = [];
    return cachedVoices;
  }
  const outcome = await runCommand(say, ["-v", "?"], { timeoutMs: 20_000 });
  if (outcome.exitCode !== 0) {
    cachedVoices = [];
    return cachedVoices;
  }
  cachedVoices = outcome.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s{2,}/u)[0] ?? "")
    .filter((name) => name.length > 0);
  return cachedVoices;
}

export type VoiceSynthesizer = {
  id: string;
  /** Produces an intermediate audio file at `outputPath`. */
  synthesize(args: { text: string; outputPath: string; voice?: string | undefined }): Promise<void>;
};

let cachedSynthesizer: VoiceSynthesizer | null | undefined;

/**
 * Picks the engine that turns text into speech.
 *
 * macOS `say` is the fallback because it needs no credentials, but its voices
 * are the classic non-neural ones and they sound robotic. A neural engine
 * (Piper) or an explicit command wins when one is available.
 */
export async function detectSynthesizer(): Promise<VoiceSynthesizer | null> {
  if (cachedSynthesizer !== undefined) return cachedSynthesizer;

  const configured = process.env.TELEGRAM_TTS_COMMAND?.trim();
  if (configured) {
    cachedSynthesizer = configuredSynthesizer(configured);
    return cachedSynthesizer;
  }

  cachedSynthesizer = (await piperSynthesizer()) ?? (await saySynthesizer());
  return cachedSynthesizer;
}

/** Only used by the tests, to drop the cached detection result. */
export function resetSynthesizerCache(): void {
  cachedSynthesizer = undefined;
}

function configuredSynthesizer(command: string): VoiceSynthesizer {
  let argv: string[];
  try {
    const parsed = JSON.parse(command) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((part) => typeof part !== "string")) {
      throw new Error("the command has to be a JSON array of strings");
    }
    argv = parsed as string[];
  } catch (error) {
    throw new Error(`TELEGRAM_TTS_COMMAND is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    id: "configured",
    synthesize: async ({ text, outputPath }) => {
      const args = argv.map((part) =>
        part.replaceAll("{text}", text).replaceAll("{output}", outputPath),
      );
      const outcome = await runCommand(args[0]!, args.slice(1), { stdin: text, timeoutMs: 120_000 });
      if (outcome.exitCode !== 0) {
        const detail = outcome.stderr.trim() || outcome.stdout.trim() || `código de salida ${outcome.exitCode}`;
        throw new Error(`El comando de síntesis falló: ${detail}`);
      }
    },
  };
}

/**
 * Piper is a local neural engine: natural sounding, no credentials, and it
 * has Spanish voices. It needs a downloaded model, so it is only used when
 * both the binary and a model are present.
 */
async function piperSynthesizer(): Promise<VoiceSynthesizer | null> {
  const binary = Bun.which("piper");
  if (!binary) return null;
  const model = resolvePiperModel();
  if (!model) return null;

  return {
    id: "piper",
    synthesize: async ({ text, outputPath }) => {
      const outcome = await runCommand(binary, ["--model", model, "--output_file", outputPath], {
        stdin: text,
        timeoutMs: 120_000,
      });
      if (outcome.exitCode !== 0) {
        const detail = outcome.stderr.trim() || outcome.stdout.trim() || `código de salida ${outcome.exitCode}`;
        throw new Error(`piper falló: ${detail}`);
      }
    },
  };
}

async function saySynthesizer(): Promise<VoiceSynthesizer | null> {
  const binary = Bun.which("say");
  if (!binary) return null;

  return {
    id: "say",
    synthesize: async ({ text, outputPath, voice }) => {
      const textFile = `${outputPath}.txt`;
      await writeFile(textFile, text, "utf8");
      try {
        let lastError = "sin detalle";
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const outcome = await runCommand(
            binary,
            [...(voice ? ["-v", voice] : []), "-f", textFile, "-o", outputPath],
            { timeoutMs: 60_000 },
          );
          if (outcome.exitCode === 0) {
            lastError = "";
            break;
          }
          lastError = outcome.stderr.trim() || outcome.stdout.trim() || `código de salida ${outcome.exitCode}`;
          // The macOS speech service occasionally fails to start; one retry is
          // enough to hide that without hiding a real error.
          await Bun.sleep(500);
        }
        if (lastError) {
          throw new Error(`say falló: ${lastError}`);
        }
      } finally {
        await rm(textFile, { force: true }).catch(() => undefined);
      }
    },
  };
}

function resolvePiperModel(): string | null {
  const configured = process.env.TELEGRAM_TTS_MODEL?.trim();
  const candidates = configured
    ? [configured]
    : [
        join(process.env.HOME ?? "", ".local", "share", "piper", "es_ES-sharvard-medium.onnx"),
        join(process.env.HOME ?? "", ".cache", "piper", "es_ES-sharvard-medium.onnx"),
      ];
  for (const candidate of candidates) {
    if (candidate.endsWith(".onnx") && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Turns text into a playable Telegram voice note.
 *
 * The engine writes an intermediate audio file and ffmpeg encodes it as mono
 * OGG/OPUS, which is the format Telegram renders as a voice message.
 */
export async function synthesizeVoiceNote(text: string, outputPath: string, voice?: string | undefined): Promise<void> {
  const synthesizer = await detectSynthesizer();
  if (!synthesizer) {
    throw new Error("No hay ningún motor de síntesis de voz disponible.");
  }

  if (synthesizer.id === "say" && voice) {
    const voices = await listSayVoices();
    const requested = voice.trim().toLowerCase();
    if (voices.length > 0 && !voices.some((name) => name.toLowerCase() === requested)) {
      const preview = voices.slice(0, 10).join(", ");
      throw new Error(`La voz "${voice}" no existe. Voces disponibles: ${preview}`);
    }
  }

  await mkdir(dirname(outputPath), { recursive: true });
  const intermediate = outputPath.replace(/\.ogg$/u, synthesizer.id === "say" ? ".aiff" : ".wav");
  await synthesizer.synthesize({ text, outputPath: intermediate, voice });

  try {
    await runFfmpeg(["-i", intermediate, "-c:a", "libopus", "-b:a", "48k", "-ac", "1", "-ar", "48000", outputPath]);
  } finally {
    await rm(intermediate, { force: true }).catch(() => undefined);
  }
}

/** The voice used when the caller does not ask for a specific one. */
export function defaultVoice(): string | undefined {
  return process.env.TELEGRAM_VOICE?.trim() || undefined;
}

