// Multipart upload management, magic-byte format sniffing, and storage coordination.
import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";

export const MB = 1024 * 1024;
export const MAX_TOTAL_SIZE = 50 * MB;
export const MAX_IMAGE_SIZE = 10 * MB;
export const MAX_FILES = 2;

export const IMAGE_TYPES = Object.freeze({
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
});

export const VIDEO_TYPES = Object.freeze({
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
});

/**
 * Safely deletes one or more temporary files from disk.
 * Silently ignores missing files, null entries, or deletion errors.
 */
export const discard = (...files) =>
  Promise.all(files.filter(Boolean).map((f) => unlink(f.path).catch(() => {})));

/**
 * Inspects the leading 16 bytes of an uploaded file to determine its true media type.
 * Returns "image", "video", or null if the magic bytes do not match an allowed format.
 * Never trusts client-reported Content-Type or file extensions.
 */
export async function sniff(file) {
  if (!file || !file.path) return null;
  let handle;
  try {
    handle = await open(file.path);
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(16), 0, 16, 0);
    const b = buffer.subarray(0, bytesRead);
    const at = (start, end) => b.subarray(start, end).toString("latin1");

    // Standard image magic numbers
    if ((b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || // JPEG
        at(0, 4) === "\x89PNG" ||                            // PNG
        at(0, 4) === "GIF8" ||                               // GIF
        (at(0, 4) === "RIFF" && at(8, 12) === "WEBP")) {     // WebP
      return "image";
    }

    // ISO Base Media File Format (MP4 / AVIF / HEIC / MOV)
    if (at(4, 8) === "ftyp") {
      const brand = at(8, 12);
      if (["avif", "avis", "heic", "heix", "mif1"].includes(brand)) return "image";
      return "video";
    }

    // Matroska / WebM video container
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
      return "video";
    }

    return null;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Validates an upload by examining its actual byte content, enforcing size constraints,
 * and persisting it to the backing storage provider via `storeImage`.
 * Returns `{ kind, url }` on success, or `{ error }` on failure (and unlinks invalid files).
 */
export async function takeUpload(req, { allowVideo, storeImage }) {
  if (req.uploadError) return { error: req.uploadError };
  const file = req.media;
  if (!file) {
    return { error: allowVideo ? "Choose a photo or a video." : "Choose a photo (JPEG, PNG, GIF, WebP or AVIF)." };
  }

  const kind = await sniff(file);
  const claimed = (file.mimetype || "").startsWith("video/") ? "video" : "image";

  if (kind !== claimed || (kind === "video" && !allowVideo)) {
    await discard(file);
    return {
      error: allowVideo
        ? "That file isn't a photo or a video. Choose a JPEG, PNG, WebP, MP4, WebM or MOV file."
        : "That file isn't a photo. Choose a JPEG, PNG, GIF, WebP or AVIF image.",
    };
  }

  if (kind === "image" && file.size > MAX_IMAGE_SIZE) {
    await discard(file);
    return { error: "Photos can be up to 10 MB." };
  }

  if (typeof storeImage !== "function") {
    throw new Error("takeUpload requires a valid storeImage function");
  }

  return { kind, url: await storeImage(file) };
}

/**
 * Creates the Multer multipart upload middleware for photos, videos, and reel posters.
 * Uses strict UUID filenames to prevent path traversal and arbitrary file execution.
 */
export function createUploadMiddleware(uploadDir) {
  const safeUploadDir = path.resolve(uploadDir);

  const upload = multer({
    storage: multer.diskStorage({
      destination: safeUploadDir,
      filename: (req, file, cb) => {
        const ext = IMAGE_TYPES[file.mimetype] || VIDEO_TYPES[file.mimetype] || "";
        cb(null, randomUUID() + ext);
      },
    }),
    limits: { fileSize: MAX_TOTAL_SIZE, files: MAX_FILES },
    fileFilter: (req, file, cb) => {
      const isAllowed = file.mimetype in IMAGE_TYPES || (file.fieldname === "media" && file.mimetype in VIDEO_TYPES);
      cb(null, isAllowed);
    },
  });

  const media = (req, res, next) =>
    upload.fields([{ name: "media", maxCount: 1 }, { name: "poster", maxCount: 1 }])(req, res, (err) => {
      if (err) {
        req.uploadError =
          err.code === "LIMIT_FILE_SIZE"
            ? "Videos can be up to 50 MB and photos up to 10 MB."
            : "That file couldn't be uploaded. Try another one.";
      }
      req.media = req.files?.media?.[0];
      req.poster = req.files?.poster?.[0];
      next();
    });

  return { upload, media };
}

