import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectTranscriber,
  listSayVoices,
  normalizeAudioToWav,
  resetTranscriberCache,
  runCommand,
  synthesizeVoiceNote,
} from "./audio";

const hasFfmpeg = Boolean(Bun.which("ffmpeg"));
const hasSay = Boolean(Bun.which("say"));

/** A minimal silent 16 kHz mono PCM WAV header plus a few samples. */
function silentWav(): Uint8Array {
  const samples = 16;
  const dataSize = samples * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (const [index, char] of [...value].entries()) view.setUint8(offset + index, char.charCodeAt(0));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  return bytes;
}

describe("runCommand", () => {
  test("returns the exit code and the output of a command", async () => {
    const outcome = await runCommand("/bin/sh", ["-c", "printf 'hola'"]);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("hola");
  });

  test("reports a failing command without throwing", async () => {
    const outcome = await runCommand("/bin/sh", ["-c", "printf 'boom' >&2; exit 3"]);

    expect(outcome.exitCode).toBe(3);
    expect(outcome.stderr).toContain("boom");
  });
});

describe("detectTranscriber", () => {
  test("uses the configured command and substitutes the placeholders", async () => {
    resetTranscriberCache();
    const previous = process.env.TELEGRAM_STT_COMMAND;
    process.env.TELEGRAM_STT_COMMAND = JSON.stringify([
      "/bin/sh",
      "-c",
      "printf 'hola %s' \"$(basename {audio})\" > \"{workdir}/transcript.txt\"",
    ]);

    try {
      const transcriber = await detectTranscriber();
      expect(transcriber?.id).toBe("configured");
      if (!transcriber) return;

      const workDir = await mkdtemp(join(tmpdir(), "telegram-stt-"));
      const transcript = await transcriber.transcribe({ audioPath: join(workDir, "nota.wav"), workDir });

      expect(transcript).toBe("hola nota.wav");
    } finally {
      if (previous === undefined) delete process.env.TELEGRAM_STT_COMMAND;
      else process.env.TELEGRAM_STT_COMMAND = previous;
      resetTranscriberCache();
    }
  });

  test("reads the transcript from the file the command wrote", async () => {
    resetTranscriberCache();
    const previous = process.env.TELEGRAM_STT_COMMAND;
    process.env.TELEGRAM_STT_COMMAND = JSON.stringify([
      "/bin/sh",
      "-c",
      "printf 'texto transcripto' > \"{workdir}/transcript.txt\"",
    ]);

    try {
      const transcriber = await detectTranscriber();
      if (!transcriber) throw new Error("the configured transcriber was not detected");

      const workDir = await mkdtemp(join(tmpdir(), "telegram-stt-"));
      const transcript = await transcriber.transcribe({ audioPath: join(workDir, "nota.wav"), workDir });

      expect(transcript).toBe("texto transcripto");
    } finally {
      if (previous === undefined) delete process.env.TELEGRAM_STT_COMMAND;
      else process.env.TELEGRAM_STT_COMMAND = previous;
      resetTranscriberCache();
    }
  });

  test("falls back to the command output when no transcript file is written", async () => {
    resetTranscriberCache();
    const previous = process.env.TELEGRAM_STT_COMMAND;
    process.env.TELEGRAM_STT_COMMAND = JSON.stringify(["/bin/sh", "-c", "printf 'salida directa'"]);

    try {
      const transcriber = await detectTranscriber();
      if (!transcriber) throw new Error("the configured transcriber was not detected");

      const workDir = await mkdtemp(join(tmpdir(), "telegram-stt-"));
      const transcript = await transcriber.transcribe({ audioPath: join(workDir, "nota.wav"), workDir });

      expect(transcript).toBe("salida directa");
    } finally {
      if (previous === undefined) delete process.env.TELEGRAM_STT_COMMAND;
      else process.env.TELEGRAM_STT_COMMAND = previous;
      resetTranscriberCache();
    }
  });

  test("creates the scratch directory before the engine runs", async () => {
    resetTranscriberCache();
    const previous = process.env.TELEGRAM_STT_COMMAND;
    process.env.TELEGRAM_STT_COMMAND = JSON.stringify([
      "/bin/sh",
      "-c",
      "printf 'con directorio' > \"{workdir}/transcript.txt\"",
    ]);

    try {
      const transcriber = await detectTranscriber();
      if (!transcriber) throw new Error("the configured transcriber was not detected");

      const parent = await mkdtemp(join(tmpdir(), "telegram-stt-"));
      const workDir = join(parent, "no-existe-aun");
      const transcript = await transcriber.transcribe({ audioPath: join(parent, "nota.wav"), workDir });

      expect(transcript).toBe("con directorio");
      await expect(readFile(join(workDir, "transcript.txt"), "utf8")).resolves.toBe("con directorio");
    } finally {
      if (previous === undefined) delete process.env.TELEGRAM_STT_COMMAND;
      else process.env.TELEGRAM_STT_COMMAND = previous;
      resetTranscriberCache();
    }
  });

  test("rejects a malformed configured command", async () => {
    resetTranscriberCache();
    const previous = process.env.TELEGRAM_STT_COMMAND;
    process.env.TELEGRAM_STT_COMMAND = "not json";

    try {
      await expect(detectTranscriber()).rejects.toThrow("TELEGRAM_STT_COMMAND is invalid");
    } finally {
      if (previous === undefined) delete process.env.TELEGRAM_STT_COMMAND;
      else process.env.TELEGRAM_STT_COMMAND = previous;
      resetTranscriberCache();
    }
  });

  test("surfaces the failure of a failing configured command", async () => {
    resetTranscriberCache();
    const previous = process.env.TELEGRAM_STT_COMMAND;
    process.env.TELEGRAM_STT_COMMAND = JSON.stringify(["/bin/sh", "-c", "printf 'error' >&2; exit 1"]);

    try {
      const transcriber = await detectTranscriber();
      if (!transcriber) throw new Error("the configured transcriber was not detected");

      const workDir = await mkdtemp(join(tmpdir(), "telegram-stt-"));
      await expect(transcriber.transcribe({ audioPath: join(workDir, "nota.wav"), workDir })).rejects.toThrow(
        "El comando de transcripción falló",
      );
    } finally {
      if (previous === undefined) delete process.env.TELEGRAM_STT_COMMAND;
      else process.env.TELEGRAM_STT_COMMAND = previous;
      resetTranscriberCache();
    }
  });
});

describe("normalizeAudioToWav", () => {
  test.skipIf(!hasFfmpeg)("converts any input into a 16 kHz mono WAV", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-audio-"));
    const input = join(dir, "entrada.ogg");
    const output = join(dir, "salida.wav");
    await writeFile(input, silentWav());

    await normalizeAudioToWav(input, output);

    const bytes = await readFile(output);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
  });

  test.skipIf(!hasFfmpeg)("reports a failure when the input is not audio", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-audio-"));
    const input = join(dir, "roto.ogg");
    const output = join(dir, "salida.wav");
    await writeFile(input, "esto no es audio");

    await expect(normalizeAudioToWav(input, output)).rejects.toThrow("ffmpeg falló");
  });
});

describe("synthesizeVoiceNote", () => {
  test.skipIf(!hasSay || !hasFfmpeg)("writes a playable OGG voice note", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-voice-"));
    const output = join(dir, "voice.ogg");

    await synthesizeVoiceNote("Hola, esto es una prueba de voz.", output);

    const bytes = await readFile(output);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("OggS");
  });

  test.skipIf(!hasSay || !hasFfmpeg)("cleans up the intermediate files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-voice-"));
    const output = join(dir, "voice.ogg");

    await synthesizeVoiceNote("otra prueba", output);

    await expect(readFile(join(dir, "voice.ogg.txt"))).rejects.toThrow();
    await expect(readFile(join(dir, "voice.aiff"))).rejects.toThrow();
  });

  test.skipIf(!hasSay || !hasFfmpeg)("reports an unknown voice instead of silently using the default one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-voice-"));
    const output = join(dir, "voice.ogg");

    await expect(synthesizeVoiceNote("prueba", output, "Voz Que No Existe")).rejects.toThrow("no existe");
  });

  test.skipIf(!hasSay)("lists the available macOS voices", async () => {
    const voices = await listSayVoices();

    expect(voices.length).toBeGreaterThan(0);
    expect(voices.some((name) => name.includes("Mónica") || name.includes("Alex"))).toBe(true);
  });
});
