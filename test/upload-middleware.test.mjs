import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  sniff,
  discard,
  takeUpload,
  createUploadMiddleware,
  IMAGE_TYPES,
  VIDEO_TYPES,
  MAX_IMAGE_SIZE,
} from "../middleware/upload.mjs";

let testDir;

before(async () => {
  testDir = await mkdtemp(path.join(tmpdir(), "insta-upload-test-"));
});

after(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true }).catch(() => {});
});

test("sniff detects genuine JPEG images by magic bytes", async () => {
  const filePath = path.join(testDir, "test.jpg");
  // JPEG magic: 0xFF, 0xD8, 0xFF
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]);
  await writeFile(filePath, buf);

  const kind = await sniff({ path: filePath });
  assert.equal(kind, "image");
});

test("sniff detects genuine PNG images by magic bytes", async () => {
  const filePath = path.join(testDir, "test.png");
  // PNG magic: \x89PNG
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  await writeFile(filePath, buf);

  const kind = await sniff({ path: filePath });
  assert.equal(kind, "image");
});

test("sniff detects genuine WebP images by magic bytes", async () => {
  const filePath = path.join(testDir, "test.webp");
  // RIFF....WEBP
  const buf = Buffer.from("RIFF\x20\x00\x00\x00WEBPVP8 ");
  await writeFile(filePath, buf);

  const kind = await sniff({ path: filePath });
  assert.equal(kind, "image");
});

test("sniff detects genuine MP4 videos by ftyp magic bytes", async () => {
  const filePath = path.join(testDir, "test.mp4");
  // ....ftypisom
  const buf = Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2");
  await writeFile(filePath, buf);

  const kind = await sniff({ path: filePath });
  assert.equal(kind, "video");
});

test("sniff detects genuine WebM videos by Matroska magic bytes", async () => {
  const filePath = path.join(testDir, "test.webm");
  // 0x1A, 0x45, 0xDF, 0xA3
  const buf = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81]);
  await writeFile(filePath, buf);

  const kind = await sniff({ path: filePath });
  assert.equal(kind, "video");
});

test("sniff returns null for fake / spoofed files (e.g. text/html pretending to be jpg)", async () => {
  const filePath = path.join(testDir, "fake.jpg");
  await writeFile(filePath, Buffer.from("<html><script>alert(1)</script></html>"));

  const kind = await sniff({ path: filePath });
  assert.equal(kind, null);
});

test("discard cleans up temporary files and safely ignores missing files", async () => {
  const file1 = path.join(testDir, "discard-1.tmp");
  const file2 = path.join(testDir, "discard-2.tmp");
  await writeFile(file1, "temp1");
  await writeFile(file2, "temp2");

  await discard({ path: file1 }, null, undefined, { path: file2 }, { path: path.join(testDir, "nonexistent.tmp") });

  const exists1 = await stat(file1).then(() => true, () => false);
  const exists2 = await stat(file2).then(() => true, () => false);
  assert.equal(exists1, false);
  assert.equal(exists2, false);
});

test("takeUpload catches MIME type spoofing and deletes the invalid file", async () => {
  const filePath = path.join(testDir, "spoofed.jpg");
  await writeFile(filePath, Buffer.from("fake image text content"));

  const req = {
    media: {
      path: filePath,
      mimetype: "image/jpeg",
      size: 50,
    },
  };

  const stored = [];
  const storeImage = async (f) => {
    stored.push(f);
    return "/uploads/stored.jpg";
  };

  const result = await takeUpload(req, { allowVideo: false, storeImage });
  assert.match(result.error, /That file isn't a photo/);
  assert.equal(stored.length, 0);

  // File should have been discarded
  const stillExists = await stat(filePath).then(() => true, () => false);
  assert.equal(stillExists, false, "Invalid spoofed file must be discarded from disk");
});

test("takeUpload refuses video when allowVideo is false and discards it", async () => {
  const filePath = path.join(testDir, "video-as-photo.mp4");
  const buf = Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2");
  await writeFile(filePath, buf);

  const req = {
    media: {
      path: filePath,
      mimetype: "video/mp4",
      size: 1000,
    },
  };

  const result = await takeUpload(req, { allowVideo: false, storeImage: async () => "/uploads/v.mp4" });
  assert.match(result.error, /That file isn't a photo/);

  const stillExists = await stat(filePath).then(() => true, () => false);
  assert.equal(stillExists, false, "Video uploaded to photo-only endpoint must be discarded");
});

test("takeUpload enforces 10 MB limit for images and discards oversized image", async () => {
  const filePath = path.join(testDir, "huge.jpg");
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]);
  await writeFile(filePath, buf);

  const req = {
    media: {
      path: filePath,
      mimetype: "image/jpeg",
      size: MAX_IMAGE_SIZE + 100, // exceeds 10 MB
    },
  };

  const result = await takeUpload(req, { allowVideo: false, storeImage: async () => "/uploads/huge.jpg" });
  assert.match(result.error, /Photos can be up to 10 MB/);

  const stillExists = await stat(filePath).then(() => true, () => false);
  assert.equal(stillExists, false, "Oversized image must be discarded from disk");
});

test("takeUpload succeeds for genuine image and delegates to storeImage", async () => {
  const filePath = path.join(testDir, "valid.jpg");
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]);
  await writeFile(filePath, buf);

  const req = {
    media: {
      path: filePath,
      mimetype: "image/jpeg",
      size: 1024,
    },
  };

  const result = await takeUpload(req, {
    allowVideo: false,
    storeImage: async (f) => `/uploads/${path.basename(f.path)}`,
  });

  assert.equal(result.kind, "image");
  assert.equal(result.url, `/uploads/valid.jpg`);
});

test("createUploadMiddleware rejects path traversal filenames by assigning secure UUID names", (t, done) => {
  const { upload } = createUploadMiddleware(testDir);
  const storage = upload.storage;

  const fakeFile = {
    originalname: "../../../../../etc/passwd",
    mimetype: "image/jpeg",
  };

  storage.getFilename({}, fakeFile, (err, filename) => {
    assert.equal(err, null);
    // Filename must end with .jpg and match UUID regex, not contain any traversal characters
    assert.match(filename, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/);
    assert.equal(filename.includes("passwd"), false);
    assert.equal(filename.includes(".."), false);
    done();
  });
});
