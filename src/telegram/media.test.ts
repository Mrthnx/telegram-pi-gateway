import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSendablePath,
  assertWithinUploadLimit,
  buildImagePrompt,
  downloadTelegramFile,
  INLINE_IMAGE_MAX_BYTES,
  modelSupportsImages,
  prepareImageAttachment,
  resolveMediaKind,
  TELEGRAM_MAX_DOWNLOAD_BYTES,
  TELEGRAM_UPLOAD_LIMITS,
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

describe("resolveMediaKind", () => {
  test("sends images as photos", () => {
    expect(resolveMediaKind("/tmp/a.png")).toBe("photo");
    expect(resolveMediaKind("/tmp/a.JPG")).toBe("photo");
    expect(resolveMediaKind("/tmp/a.webp")).toBe("photo");
  });

  test("sends playable audio formats as voice notes", () => {
    expect(resolveMediaKind("/tmp/a.ogg")).toBe("voice");
    expect(resolveMediaKind("/tmp/a.oga")).toBe("voice");
    expect(resolveMediaKind("/tmp/a.mp3")).toBe("voice");
    expect(resolveMediaKind("/tmp/a.m4a")).toBe("voice");
  });

  test("sends anything else as a document", () => {
    expect(resolveMediaKind("/tmp/a.pdf")).toBe("document");
    expect(resolveMediaKind("/tmp/a.wav")).toBe("document");
    expect(resolveMediaKind("/tmp/a")).toBe("document");
  });

  test("honours an explicit kind", () => {
    expect(resolveMediaKind("/tmp/a.png", "document")).toBe("document");
    expect(resolveMediaKind("/tmp/a.pdf", "voice")).toBe("voice");
  });
});

describe("assertWithinUploadLimit", () => {
  test("accepts a file inside the limit", () => {
    expect(() => assertWithinUploadLimit("photo", 1024)).not.toThrow();
  });

  test("rejects a photo over the 10 MB photo limit", () => {
    expect(() => assertWithinUploadLimit("photo", TELEGRAM_UPLOAD_LIMITS.photo + 1)).toThrow(
      "supera el límite de 10 MB para photo",
    );
  });

  test("rejects a document over the 50 MB upload limit", () => {
    expect(() => assertWithinUploadLimit("document", TELEGRAM_UPLOAD_LIMITS.document + 1)).toThrow(
      "supera el límite de 50 MB para document",
    );
  });

  test("exposes the Bot API upload limits", () => {
    expect(TELEGRAM_UPLOAD_LIMITS.photo).toBe(10 * 1024 * 1024);
    expect(TELEGRAM_UPLOAD_LIMITS.document).toBe(50 * 1024 * 1024);
    expect(TELEGRAM_UPLOAD_LIMITS.voice).toBe(50 * 1024 * 1024);
  });
});

describe("assertSendablePath", () => {
  test("accepts a file inside the project", async () => {
    const project = await mkdtemp(join(tmpdir(), "telegram-project-"));
    const file = join(project, "diagram.png");
    await writeFile(file, "x");

    const resolved = await assertSendablePath(file, project, [project]);

    expect(resolved.endsWith("diagram.png")).toBe(true);
  });

  test("resolves a relative path against the project root", async () => {
    const project = await mkdtemp(join(tmpdir(), "telegram-project-"));
    await writeFile(join(project, "diagram.png"), "x");

    const resolved = await assertSendablePath("diagram.png", project, [project]);

    expect(resolved.endsWith("diagram.png")).toBe(true);
  });

  test("refuses a file outside the allowed roots", async () => {
    const project = await mkdtemp(join(tmpdir(), "telegram-project-"));
    const outside = await mkdtemp(join(tmpdir(), "telegram-outside-"));
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "x");

    await expect(assertSendablePath(secret, project, [project])).rejects.toThrow(
      "está fuera del proyecto y de los datos del gateway",
    );
  });

  test("refuses a symlink that points outside the allowed roots", async () => {
    const project = await mkdtemp(join(tmpdir(), "telegram-project-"));
    const outside = await mkdtemp(join(tmpdir(), "telegram-outside-"));
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "x");
    const link = join(project, "link.txt");
    await symlink(secret, link);

    await expect(assertSendablePath(link, project, [project])).rejects.toThrow(
      "está fuera del proyecto y de los datos del gateway",
    );
  });

  test("refuses a directory", async () => {
    const project = await mkdtemp(join(tmpdir(), "telegram-project-"));
    const subdir = join(project, "sub");
    await mkdir(subdir, { recursive: true });

    await expect(assertSendablePath(subdir, project, [project])).rejects.toThrow("no apunta a un archivo");
  });
});
