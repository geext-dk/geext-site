import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import sharp from "sharp";

import { desiredSubjectValues } from "./set-photo-privacy.mjs";
import { isPrivatePhoto, photoVariantObjectKeys } from "./sync-photos-to-r2.mjs";

const execFileAsync = promisify(execFile);
const privacyScript = fileURLToPath(new URL("./set-photo-privacy.mjs", import.meta.url));

async function createPhoto(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 40, g: 80, b: 120 },
    },
  }).jpeg().toFile(filePath);
}

async function readSubjects(filePath) {
  const { stdout } = await execFileAsync("exiftool", ["-json", "-Subject", filePath]);
  const [metadata] = JSON.parse(stdout);
  return Array.isArray(metadata.Subject)
    ? metadata.Subject
    : metadata.Subject
      ? [metadata.Subject]
      : [];
}

async function runPrivacy(...args) {
  return execFileAsync(process.execPath, [privacyScript, ...args]);
}

test("privacy CLI marks and unmarks recursive photo inputs without duplicates or backups", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "photo-privacy-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const firstPhoto = path.join(root, "roll", "first.jpg");
  const secondPhoto = path.join(root, "roll", "nested", "second.jpg");
  await createPhoto(firstPhoto);
  await createPhoto(secondPhoto);
  await execFileAsync("exiftool", [
    "-overwrite_original",
    "-Subject=Film: Test",
    "-Subject=Camera: Test",
    firstPhoto,
  ]);

  await runPrivacy("private", root);

  const firstSubjects = await readSubjects(firstPhoto);
  const secondSubjects = await readSubjects(secondPhoto);
  assert.deepEqual(firstSubjects, ["Film: Test", "Camera: Test", "Private"]);
  assert.deepEqual(secondSubjects, ["Private"]);
  assert.equal((await fs.readdir(path.dirname(firstPhoto))).some((name) => name.includes("_original")), false);

  await runPrivacy("private", firstPhoto);
  assert.equal((await readSubjects(firstPhoto)).filter((value) => value === "Private").length, 1);

  await runPrivacy("--dry-run", "public", firstPhoto);
  assert.equal((await readSubjects(firstPhoto)).includes("Private"), true);

  await runPrivacy("public", firstPhoto);
  assert.deepEqual(await readSubjects(firstPhoto), ["Film: Test", "Camera: Test"]);
});

test("privacy helpers use an exact, case-sensitive marker", () => {
  assert.deepEqual(
    desiredSubjectValues(["Film: Test", "Private", "Private"], "private"),
    ["Film: Test", "Private"],
  );
  assert.deepEqual(
    desiredSubjectValues(["Film: Test", "Private"], "public"),
    ["Film: Test"],
  );
  assert.equal(isPrivatePhoto({ Subject: ["Private"] }), true);
  assert.equal(isPrivatePhoto({ Subject: ["private"] }), false);
  assert.equal(isPrivatePhoto({ Subject: ["Film: Test"] }), false);
});

test("sync cleanup targets only generated photo variants", () => {
  assert.deepEqual(photoVariantObjectKeys("abc123"), [
    "photos/abc123-thumb.avif",
    "photos/abc123-grid.avif",
    "photos/abc123-large.avif",
    "photos/abc123-telegram.jpg",
  ]);
});

test("privacy CLI reports unsupported and missing inputs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "photo-privacy-errors-"));
  const unsupported = path.join(root, "notes.txt");
  await fs.writeFile(unsupported, "not a photo");

  try {
    const result = await runPrivacy("private", unsupported, path.join(root, "missing.jpg"));
    assert.fail(`expected command failure, got: ${result.stdout}`);
  } catch (error) {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /skip unsupported/);
    assert.match(error.stdout, /summary: changed=0 already-correct=0 skipped=1 failed=1/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
