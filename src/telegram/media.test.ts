import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildImagePrompt,
  downloadTelegramFile,
  INLINE_IMAGE_MAX_BYTES,
  modelSupportsImages,
  prepareImageAttachment,
  TELEGRAM_MAX_DOWNLOAD_BYTES,
} from "./media";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAARklEQVR4nJ2OwQ3AMAwCOSmDZbR0s3YyYvyo+smn98BY2BJIsoRb8euHGmNKTbRdgrrL8gEYOvAjqAJ6WBmTqjN1ped9/Ng1wBgbksVjTgAAAABJRU5ErkJggg==";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("downloadTelegramFile", () => {
  test("saves the downloaded bytes under the downloads directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-media-"));
    const payload = new Uint8Array([1, 2, 3, 4]);
    globalThis.fetch = mock(async () => new Response(payload)) as unknown as typeof fetch;

    const result = await downloadTelegramFile({
      api: { getFile: async () => ({ file_path: "photos/file_1.png" }) },
      token: "test-token",
      fileId: "file-id",
      uniqueId: "unique-1",
      dir,
    });

    expect(Array.from(result.bytes)).toEqual(Array.from(payload));
    expect(result.path.startsWith(dir)).toBe(true);
    expect(result.path.endsWith(".png")).toBe(true);
    expect(Array.from(await readFile(result.path))).toEqual(Array.from(payload));
  });

  test("keeps the extension of the original file and sanitizes the identifier", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-media-"));
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1]))) as unknown as typeof fetch;

    const result = await downloadTelegramFile({
      api: { getFile: async () => ({ file_path: "voice/file_2.oga" }) },
      token: "test-token",
      fileId: "file-id",
      uniqueId: "uni/que id",
      dir,
    });

    expect(result.path.endsWith(".oga")).toBe(true);
    expect(result.path.includes("uni_que_id")).toBe(true);
    expect(result.path).not.toContain("/uni");
  });

  test("falls back to the given extension when the original file has none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-media-"));
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1]))) as unknown as typeof fetch;

    const result = await downloadTelegramFile({
      api: { getFile: async () => ({ file_path: "voice/file_3" }) },
      token: "test-token",
      fileId: "file-id",
      uniqueId: "unique-3",
      dir,
      fallbackExtension: ".ogg",
    });

    expect(result.path.endsWith(".ogg")).toBe(true);
  });

  test("rejects a file larger than the download limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-media-"));
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;

    await expect(
      downloadTelegramFile({
        api: { getFile: async () => ({ file_path: "photos/file_4.png" }) },
        token: "test-token",
        fileId: "file-id",
        uniqueId: "unique-4",
        dir,
        maxBytes: 2,
      }),
    ).rejects.toThrow("supera el límite de descarga");
  });

  test("fails when Telegram does not return a file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-media-"));

    await expect(
      downloadTelegramFile({
        api: { getFile: async () => ({ file_path: undefined }) },
        token: "test-token",
        fileId: "file-id",
        uniqueId: "unique-5",
        dir,
      }),
    ).rejects.toThrow("did not return a file path");
  });

  test("fails when the download itself fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-media-"));
    globalThis.fetch = mock(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;

    await expect(
      downloadTelegramFile({
        api: { getFile: async () => ({ file_path: "photos/file_6.png" }) },
        token: "test-token",
        fileId: "file-id",
        uniqueId: "unique-6",
        dir,
      }),
    ).rejects.toThrow("download failed: 404");
  });

  test("exposes the Bot API download limit", () => {
    expect(TELEGRAM_MAX_DOWNLOAD_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe("prepareImageAttachment", () => {
  test("builds an inline image payload from a real image file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-media-"));
    const path = join(dir, "image.png");
    await writeFile(path, Buffer.from(TINY_PNG_BASE64, "base64"));

    const prepared = await prepareImageAttachment(new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64")), path);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.image.type).toBe("image");
    expect(prepared.image.mimeType).toBe("image/png");
    expect(prepared.image.data.length).toBeGreaterThan(0);
    expect(Buffer.from(prepared.image.data, "base64").length).toBeGreaterThan(0);
  });

  test("reports an unsupported format instead of attaching garbage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-media-"));
    const path = join(dir, "not-an-image.bin");
    await writeFile(path, "esto no es una imagen");

    const prepared = await prepareImageAttachment(new Uint8Array([1, 2, 3]), path);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.message).toContain("unsupported image format");
  });

  test("keeps an oversized image on disk instead of attaching it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-media-"));
    const path = join(dir, "image.png");
    await writeFile(path, Buffer.from(TINY_PNG_BASE64, "base64"));

    const prepared = await prepareImageAttachment(new Uint8Array(1024), path);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.image.mimeType).toBe("image/png");
  });

  test("refuses to attach an image over the inline limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-media-"));
    const path = join(dir, "image.png");
    await writeFile(path, Buffer.from(TINY_PNG_BASE64, "base64"));

    const oversized = new Uint8Array(INLINE_IMAGE_MAX_BYTES + 1);
    const prepared = await prepareImageAttachment(oversized, path);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.message).toContain("too large to attach inline");
  });
});

describe("modelSupportsImages", () => {
  test("is true for a model that declares image input", () => {
    expect(modelSupportsImages({ input: ["text", "image"] })).toBe(true);
  });

  test("is false for a text-only model", () => {
    expect(modelSupportsImages({ input: ["text"] })).toBe(false);
  });

  test("is false when the model is missing or has no declared input", () => {
    expect(modelSupportsImages(undefined)).toBe(false);
    expect(modelSupportsImages({})).toBe(false);
  });
});

describe("buildImagePrompt", () => {
  test("tells the model the image is attached when it is", () => {
    const prompt = buildImagePrompt({ path: "/tmp/a.png", caption: "mirá esto", attached: true });

    expect(prompt).toContain("/tmp/a.png");
    expect(prompt).toContain("mirá esto");
    expect(prompt).toContain("está adjunta");
  });

  test("asks for a textual description when the image could not be attached", () => {
    const prompt = buildImagePrompt({ path: "/tmp/a.png", attached: false });

    expect(prompt).toContain("no pudo adjuntarse");
    expect(prompt).toContain("descripción textual");
    expect(prompt).not.toContain("Caption del usuario");
  });
});
