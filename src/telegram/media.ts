import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";

/**
 * The Telegram Bot API refuses to download files larger than 20 MB, so the
 * gateway rejects them before spending bandwidth on them.
 */
export const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Largest raw image the gateway attaches inline without re-encoding it.
 *
 * Telegram photos are already compressed and capped at 2560px, so most of them
 * fit. Bigger ones are kept on disk instead of being silently attached.
 */
export const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Inline image payload accepted by `AgentSession.prompt()`. */
export type ImageAttachment = {
  type: "image";
  data: string;
  mimeType: string;
};

export type PreparedImage =
  | { ok: true; image: ImageAttachment; note?: string | undefined }
  | { ok: false; message: string };

export type TelegramFileApi = {
  getFile(fileId: string): Promise<{ file_path?: string | undefined }>;
};

export type MediaKind = "photo" | "document" | "voice";

/** Upload ceilings enforced by the Telegram Bot API. */
export const TELEGRAM_UPLOAD_LIMITS: Record<MediaKind, number> = {
  photo: 10 * 1024 * 1024,
  document: 50 * 1024 * 1024,
  voice: 50 * 1024 * 1024,
};

const VOICE_EXTENSIONS = new Set([".ogg", ".oga", ".mp3", ".m4a"]);
const PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

/**
 * Picks how a file should be delivered.
 *
 * `sendVoice` only renders as a playable voice note for OGG+OPUS, MP3 and
 * M4A, so anything else is delivered as a document instead of failing.
 */
export function resolveMediaKind(filePath: string, requested?: MediaKind | undefined): MediaKind {
  if (requested) return requested;
  const extension = extname(filePath).toLowerCase();
  if (VOICE_EXTENSIONS.has(extension)) return "voice";
  if (PHOTO_EXTENSIONS.has(extension)) return "photo";
  return "document";
}

export function assertWithinUploadLimit(kind: MediaKind, bytes: number): void {
  const limit = TELEGRAM_UPLOAD_LIMITS[kind];
  if (bytes > limit) {
    throw new Error(`El archivo supera el límite de ${Math.floor(limit / 1024 / 1024)} MB para ${kind}.`);
  }
}

/**
 * Resolves a file the agent wants to send and refuses anything outside the
 * roots the gateway is allowed to expose.
 *
 * Symlinks are resolved before the containment check, so a link pointing
 * outside the project does not become an escape hatch.
 */
export async function assertSendablePath(filePath: string, baseDir: string, allowedRoots: string[]): Promise<string> {
  const absolute = isAbsolute(filePath) ? filePath : resolve(baseDir, filePath);
  const actual = await realpath(absolute);

  const roots: string[] = [];
  for (const root of allowedRoots) {
    try {
      roots.push(await realpath(root));
    } catch {
      // A missing root simply cannot contain the file.
    }
  }

  const inside = roots.some((root) => {
    const relativePath = relative(root, actual);
    return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
  });
  if (!inside) {
    throw new Error("El archivo está fuera del proyecto y de los datos del gateway.");
  }

  const stats = await stat(actual);
  if (!stats.isFile()) {
    throw new Error("La ruta no apunta a un archivo.");
  }
  return actual;
}

export type DownloadedFile = {
  path: string;
  bytes: Uint8Array;
};

/**
 * Downloads a Telegram file to disk and returns where it landed.
 *
 * The size guard runs after the transfer because the Bot API does not report
 * the size of a photo up front; the alternative is rejecting files that would
 * have fit.
 */
export async function downloadTelegramFile(args: {
  api: TelegramFileApi;
  token: string;
  fileId: string;
  uniqueId: string;
  dir: string;
  fallbackExtension?: string | undefined;
  maxBytes?: number | undefined;
}): Promise<DownloadedFile> {
  const file = await args.api.getFile(args.fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not return a file path for this media.");
  }

  const response = await fetch(`https://api.telegram.org/file/bot${args.token}/${file.file_path}`);
  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const limit = args.maxBytes ?? TELEGRAM_MAX_DOWNLOAD_BYTES;
  if (bytes.byteLength > limit) {
    const limitMb = Math.floor(limit / 1024 / 1024);
    throw new Error(`El archivo supera el límite de descarga de Telegram (${limitMb} MB).`);
  }

  await mkdir(args.dir, { recursive: true });
  const path = join(args.dir, `${Date.now()}-${sanitizeSegment(args.uniqueId)}${safeExtension(file.file_path, args.fallbackExtension)}`);
  await writeFile(path, bytes);

  return { path, bytes };
}

/**
 * Turns raw image bytes into the inline payload the Pi SDK expects.
 *
 * The image is resized first, the same way the SDK `read` tool does it, so a
 * large photo cannot blow past the provider's inline size limit.
 */
export async function prepareImageAttachment(bytes: Uint8Array, path: string): Promise<PreparedImage> {
  const mimeType = await detectSupportedImageMimeTypeFromFile(path);
  if (!mimeType) {
    return { ok: false, message: "[Image omitted: unsupported image format.]" };
  }

  if (bytes.byteLength > INLINE_IMAGE_MAX_BYTES) {
    return { ok: false, message: "[Image omitted: too large to attach inline.]" };
  }

  return {
    ok: true,
    image: { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType },
  };
}

/**
 * Whether the active model can actually look at an image.
 *
 * Text-only models silently drop image attachments, so the gateway has to
 * know before it promises the owner that the picture was seen.
 */
export function modelSupportsImages(model: { input?: readonly string[] } | undefined): boolean {
  return Array.isArray(model?.input) && model.input.includes("image");
}

export function buildImagePrompt(args: {
  path: string;
  caption?: string | undefined;
  attached: boolean;
}): string {
  const lines = ["El usuario envió una imagen desde Telegram.", `Ruta local descargada: ${args.path}`];
  if (args.caption) {
    lines.push(`Caption del usuario: ${args.caption}`);
  }
  lines.push(
    args.attached
      ? "La imagen está adjunta a este mensaje: mirala y respondé sobre lo que ves."
      : "La imagen no pudo adjuntarse a este mensaje. Si las herramientas disponibles no pueden leer imágenes, explicá esa limitación y pedí una descripción textual.",
  );
  return lines.join("\n");
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/gu, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "file";
}

function safeExtension(filePath: string, fallbackExtension?: string | undefined): string {
  const extension = extname(filePath).toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (extension.length > 0 && extension.length <= 10) {
    return `.${extension}`;
  }
  return fallbackExtension ?? ".bin";
}
