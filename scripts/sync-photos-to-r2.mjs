#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import "dotenv/config";
import sharp from "sharp";

const SOURCE_DIR = process.env.PHOTO_SOURCE_DIR;
const OUTPUT_JSON = process.env.PHOTO_OUTPUT_JSON ?? "data/photos.json";
const PHOTO_R2_PREFIX = "photos";
const IMAGE_R2_PREFIX = "images";
const R2_BUCKET = process.env.R2_BUCKET;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_PUBLIC_BASE_URL = normalizeBaseUrl(process.env.R2_PUBLIC_BASE_URL ?? "");
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const UPLOAD_CONCURRENCY = parsePositiveInteger(process.env.R2_UPLOAD_CONCURRENCY ?? "6", "R2_UPLOAD_CONCURRENCY");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif", ".tif", ".tiff"]);
const OUTPUT_EXTENSION = ".avif";
const OUTPUT_CONTENT_TYPE = "image/avif";
const AVIF_QUALITY = 70;
const AVIF_EFFORT = 6;
const VARIANTS = [
  ["thumb", 480],
  ["grid", 960],
  ["large", 2048],
];

function usage() {
  console.error(`Sync images to Cloudflare R2.

Usage:
  node scripts/sync-photos-to-r2.mjs
  node scripts/sync-photos-to-r2.mjs image <source-file>

Commands:
  photos               Sync exported photos and write data/photos.json. This is the default.
  image <source-file>  Upload one image as AVIF without resizing and print its public URL.

Required environment:
  R2_BUCKET             Cloudflare R2 bucket name
  R2_ACCOUNT_ID         Cloudflare account ID
  R2_ACCESS_KEY_ID      R2 S3 API access key ID
  R2_SECRET_ACCESS_KEY  R2 S3 API secret access key
  R2_PUBLIC_BASE_URL    Public base URL for the bucket/custom domain

Required for photo sync:
  PHOTO_SOURCE_DIR      Source hierarchy to walk when syncing photos

Optional environment:
  PHOTO_OUTPUT_JSON     Output JSON path
  R2_UPLOAD_CONCURRENCY Number of simultaneous S3 uploads, default 6

Photo example:
  R2_BUCKET=my-bucket \\
  R2_ACCOUNT_ID=abc123 \\
  R2_ACCESS_KEY_ID=... \\
  R2_SECRET_ACCESS_KEY=... \\
  R2_PUBLIC_BASE_URL=https://photos.example.com \\
  PHOTO_SOURCE_DIR=~/Pictures/darktable_exported \\
  node scripts/sync-photos-to-r2.mjs

Image example:
  R2_BUCKET=my-bucket \\
  R2_ACCOUNT_ID=abc123 \\
  R2_ACCESS_KEY_ID=... \\
  R2_SECRET_ACCESS_KEY=... \\
  R2_PUBLIC_BASE_URL=https://photos.example.com \\
  node scripts/sync-photos-to-r2.mjs image ./avatar.jpg`);
}

function log(message) {
  console.error(message);
}

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function encodeObjectKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function parsePositiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    die(`${name} must be a positive integer`);
  }

  return Number(value);
}

function run(command, args, options = {}) {
  const { inherit = false, input } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    });

    const stdout = [];
    const stderr = [];

    if (!inherit) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
    }

    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };

      if (code === 0) {
        resolve(result);
        return;
      }

      const rendered = [command, ...args].map(String).join(" ");
      const err = new Error(`command failed (${code}): ${rendered}\n${result.stderr}`.trim());
      Object.assign(err, result);
      reject(err);
    });

    if (input) {
      child.stdin.end(input);
    } else if (!inherit) {
      child.stdin.end();
    }
  });
}

async function requireCommand(command) {
  try {
    await run("/bin/sh", ["-lc", `command -v ${shellQuote(command)}`]);
  } catch {
    die(`required command not found: ${command}`);
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function hashFile(filePath) {
  const hash = createHash("sha256");

  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  return hash.digest("hex");
}

async function walkImages(root) {
  const files = [];

  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(entryPath);
      }
    }
  }

  await visit(root);
  return files;
}

async function exifJson(filePath, tags) {
  const { stdout } = await run("exiftool", ["-json", ...tags, filePath]);
  const parsed = JSON.parse(stdout);
  return parsed[0] ?? {};
}

async function imageSize(filePath) {
  const data = await exifJson(filePath, ["-ImageWidth", "-ImageHeight"]);
  return {
    width: numberOrNull(data.ImageWidth),
    height: numberOrNull(data.ImageHeight),
  };
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstPresent(source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") {
      return source[key];
    }
  }

  return null;
}

function subjectValue(source, prefix) {
  const subject = Array.isArray(source.Subject)
    ? source.Subject
    : source.Subject
      ? [source.Subject]
      : [];

  const value = subject.find((item) => typeof item === "string" && item.startsWith(prefix));
  return value ? value.replace(new RegExp(`^${prefix}\\s*`), "") : null;
}

function rollIdFromFolder(folder) {
  return folder.trim().split(/\s+/, 1)[0] || folder;
}

function rollCameraFallback(folder) {
  const [, afterDash] = folder.split(" - ");
  if (!afterDash) {
    return null;
  }

  const [camera] = afterDash.split(",");
  return camera.trim() || null;
}

function rollFilmFallback(folder) {
  const commaIndex = folder.indexOf(",");
  if (commaIndex === -1) {
    return null;
  }

  return folder.slice(commaIndex + 1).trim() || null;
}

async function metadataForSource(sourcePath, roll, rollFolder, filename) {
  const data = await exifJson(sourcePath, [
    "-DateTimeOriginal",
    "-CreateDate",
    "-ModifyDate",
    "-FileModifyDate",
    "-Aperture",
    "-FNumber",
    "-ExposureTime",
    "-ShutterSpeed",
    "-ISO",
    "-Subject",
    "-CameraModelName",
    "-Model",
    "-LensModel",
    "-Lens",
    "-FocalLength",
  ]);

  return {
    filename,
    roll,
    metadata: {
      date: firstPresent(data, ["DateTimeOriginal", "CreateDate", "ModifyDate", "FileModifyDate"]),
      aperture: firstPresent(data, ["Aperture", "FNumber"]),
      shutterSpeed: firstPresent(data, ["ExposureTime", "ShutterSpeed"]),
      iso: data.ISO ?? null,
      film: subjectValue(data, "Film:") ?? rollFilmFallback(rollFolder),
      cameraModel:
        firstPresent(data, ["CameraModelName", "Model"]) ??
        subjectValue(data, "Camera:") ??
        rollCameraFallback(rollFolder),
      lensModel: firstPresent(data, ["LensModel", "Lens"]),
      focalLength: firstPresent(data, ["FocalLength"]),
    },
  };
}

async function stripSensitiveMetadata(filePath) {
  await run("exiftool", [
    "-overwrite_original",
    "-all=",
    "-tagsFromFile",
    "@",
    "-icc_profile:all",
    "-Orientation",
    filePath,
  ]);
}

async function sanitizeOriginal(sourcePath, destinationPath) {
  await fs.copyFile(sourcePath, destinationPath);
  await stripSensitiveMetadata(destinationPath);
}

async function makeVariant(sourcePath, destinationPath, targetWidth) {
  await sharp(sourcePath)
    .rotate()
    .resize({ width: targetWidth, withoutEnlargement: true })
    .keepIccProfile()
    .avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT })
    .toFile(destinationPath);
}

async function makeUploadedImage(sourcePath, destinationPath) {
  await sharp(sourcePath)
    .rotate()
    .keepIccProfile()
    .avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT })
    .toFile(destinationPath);
}

function createR2Client() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

async function listExistingObjectKeys(client, prefix) {
  const keys = new Set();
  let continuationToken;

  log(`list existing R2 objects: ${prefix}/`);

  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: `${prefix}/`,
      ContinuationToken: continuationToken,
    }));

    for (const object of response.Contents ?? []) {
      if (object.Key) {
        keys.add(object.Key);
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  log(`found existing R2 objects: ${keys.size}`);
  return keys;
}

async function uploadObject(client, objectKey, filePath, contentType) {
  log(`upload: ${objectKey}`);

  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: objectKey,
    Body: createReadStream(filePath),
    ContentType: contentType,
    CacheControl: CACHE_CONTROL,
  }));
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

function scaledSize(originalSize, targetWidth) {
  if (originalSize.width === null || originalSize.height === null) {
    return { width: null, height: null };
  }

  if (!targetWidth || originalSize.width <= targetWidth) {
    return originalSize;
  }

  return {
    width: targetWidth,
    height: Math.round((originalSize.height * targetWidth) / originalSize.width),
  };
}

function publicUrlForObjectKey(objectKey) {
  return `${R2_PUBLIC_BASE_URL}/${encodeObjectKey(objectKey)}`;
}

function imageJsonForVariant(variant, sourceHash, size) {
  const objectKey = `${PHOTO_R2_PREFIX}/${sourceHash}-${variant}${OUTPUT_EXTENSION}`;
  const url = publicUrlForObjectKey(objectKey);

  return {
    url,
    objectKey,
    width: size.width,
    height: size.height,
  };
}

function uploadedImageObjectForHash(sourceHash) {
  const objectKey = `${IMAGE_R2_PREFIX}/${sourceHash}${OUTPUT_EXTENSION}`;

  return {
    objectKey,
    url: publicUrlForObjectKey(objectKey),
  };
}

async function photoJsonForSource(sourcePath, sourceRoot, tempRoot, uploadQueue, existingObjectKeys) {
  const relativePath = path.relative(sourceRoot, sourcePath);
  const rollFolder = path.basename(path.dirname(relativePath));
  const roll = rollIdFromFolder(rollFolder);
  const filename = path.basename(sourcePath);
  const extension = path.extname(filename).toLowerCase();
  const sourceHash = await hashFile(sourcePath);
  const sourceSize = await imageSize(sourcePath);
  const workDir = path.join(tempRoot, createHash("sha256").update(relativePath).digest("hex"));
  const sanitizedPath = path.join(workDir, `original${extension}`);
  const variantPaths = Object.fromEntries(
    VARIANTS.map(([name]) => [name, path.join(workDir, `${name}${OUTPUT_EXTENSION}`)]),
  );
  const images = Object.fromEntries(
    VARIANTS.map(([name, width]) => [
      name,
      imageJsonForVariant(name, sourceHash, scaledSize(sourceSize, width)),
    ]),
  );

  const blurImageBuffer = await sharp(sourcePath)
    .rotate()
    .resize({ width: 24, withoutEnlargement: true })
    .keepIccProfile()
    .webp({ quality: 25, effort: 0 })
    .toBuffer();

  const blurImageMetadata = await sharp(blurImageBuffer).metadata();

  images['blur'] = {
    url: `data:image/webp;base64,${blurImageBuffer.toString("base64")}`,
    width: blurImageMetadata.width,
    height: blurImageMetadata.height
  }

  log(`process: ${relativePath}`);

  const base = await metadataForSource(sourcePath, roll, rollFolder, filename);

  if (VARIANTS.every(([name]) => existingObjectKeys.has(images[name].objectKey))) {
    log(`skip existing variants: ${relativePath}`);
    return {
      ...base,
      id: sourceHash,
      sourcePath: relativePath,
      images,
    };
  }

  await fs.mkdir(workDir, { recursive: true });
  await sanitizeOriginal(sourcePath, sanitizedPath);
  for (const [name, width] of VARIANTS) {
    await makeVariant(sanitizedPath, variantPaths[name], width);
  }

  for (const [name] of VARIANTS) {
    uploadQueue.push({
      objectKey: images[name].objectKey,
      filePath: variantPaths[name],
      contentType: OUTPUT_CONTENT_TYPE,
    });
  }

  return {
    ...base,
    id: sourceHash,
    sourcePath: relativePath,
    images,
  };
}

function validateR2Environment() {
  if (!R2_BUCKET) {
    die("R2_BUCKET is required");
  }

  if (!R2_ACCOUNT_ID) {
    die("R2_ACCOUNT_ID is required");
  }

  if (!R2_ACCESS_KEY_ID) {
    die("R2_ACCESS_KEY_ID is required");
  }

  if (!R2_SECRET_ACCESS_KEY) {
    die("R2_SECRET_ACCESS_KEY is required");
  }

  if (!R2_PUBLIC_BASE_URL) {
    die("R2_PUBLIC_BASE_URL is required");
  }
}

async function syncPhotos() {
  validateR2Environment();
  await requireCommand("exiftool");

  if (!SOURCE_DIR) {
    die("PHOTO_SOURCE_DIR is required");
  }

  if (!(await pathExists(SOURCE_DIR))) {
    die(`PHOTO_SOURCE_DIR does not exist: ${SOURCE_DIR}`);
  }

  const sourceRoot = await fs.realpath(SOURCE_DIR);
  const outputPath = path.resolve(OUTPUT_JSON);
  const outputTempPath = `${outputPath}.tmp`;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "photo-r2-sync-"));
  const client = createR2Client();

  try {
    const photos = [];
    const uploadQueue = [];
    const sourceFiles = await walkImages(sourceRoot);
    const existingObjectKeys = await listExistingObjectKeys(client, PHOTO_R2_PREFIX);

    for (const sourcePath of sourceFiles) {
      photos.push(await photoJsonForSource(sourcePath, sourceRoot, tempRoot, uploadQueue, existingObjectKeys));
    }

    const missingUploads = uploadQueue.filter((upload) => {
      if (existingObjectKeys.has(upload.objectKey)) {
        log(`skip existing: ${upload.objectKey}`);
        return false;
      }

      return true;
    });

    log(`missing uploads: ${missingUploads.length}`);
    await runWithConcurrency(missingUploads, UPLOAD_CONCURRENCY, async (upload) => {
      await uploadObject(client, upload.objectKey, upload.filePath, upload.contentType);
    });

    const catalog = {
      generatedAt: new Date().toISOString(),
      baseUrl: R2_PUBLIC_BASE_URL,
      photos,
    };

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputTempPath, `${JSON.stringify(catalog, null, 2)}\n`);
    await fs.rename(outputTempPath, outputPath);
    log(`wrote: ${outputPath}`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function uploadImage(args) {
  const [sourcePathArg] = args;

  if (!sourcePathArg) {
    die("image source file is required");
  }

  const sourcePath = path.resolve(sourcePathArg);

  if (!(await isFile(sourcePath))) {
    die(`image source file does not exist: ${sourcePath}`);
  }

  validateR2Environment();
  await requireCommand("exiftool");

  const sourceHash = await hashFile(sourcePath);
  const { objectKey, url } = uploadedImageObjectForHash(sourceHash);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "image-r2-sync-"));
  const sanitizedPath = path.join(tempRoot, `original${path.extname(sourcePath).toLowerCase()}`);
  const imagePath = path.join(tempRoot, `image${OUTPUT_EXTENSION}`);
  const client = createR2Client();

  try {
    const existingObjectKeys = await listExistingObjectKeys(client, IMAGE_R2_PREFIX);

    if (existingObjectKeys.has(objectKey)) {
      log(`skip existing: ${objectKey}`);
      console.log(url);
      return;
    }

    await sanitizeOriginal(sourcePath, sanitizedPath);
    await makeUploadedImage(sanitizedPath, imagePath);
    await uploadObject(client, objectKey, imagePath, OUTPUT_CONTENT_TYPE);
    console.log(url);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    usage();
    return;
  }

  if (args.length === 0 || args[0] === "photos") {
    await syncPhotos();
    return;
  }

  if (args[0] === "image") {
    await uploadImage(args.slice(1));
    return;
  }

  die(`unknown command: ${args[0]}`);
}

main().catch((error) => {
  die(error.message);
});
