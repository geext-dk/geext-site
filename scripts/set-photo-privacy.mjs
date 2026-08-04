#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PRIVATE_TAG = "Private";
export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif", ".tif", ".tiff"]);

function usage() {
  console.error(`Mark photos as private or public using the Subject metadata field.

Usage:
  node scripts/set-photo-privacy.mjs [--dry-run] private <file-or-directory...>
  node scripts/set-photo-privacy.mjs [--dry-run] public <file-or-directory...>

The command accepts multiple files and recursively walks directories. Supported
image types are: ${[...IMAGE_EXTENSIONS].join(", ")}.
`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
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

      const error = new Error(
        `command failed (${code}): ${[command, ...args].join(" ")}\n${result.stderr}`.trim(),
      );
      Object.assign(error, result);
      reject(error);
    });
  });
}

function isSupportedImage(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function collectImages(inputs) {
  const files = new Set();
  const skipped = [];
  const failures = [];

  async function visit(inputPath) {
    let stats;

    try {
      stats = await fs.stat(inputPath);
    } catch (error) {
      failures.push({ path: inputPath, error: error.message });
      return;
    }

    if (stats.isFile()) {
      if (isSupportedImage(inputPath)) {
        files.add(path.resolve(inputPath));
      } else {
        skipped.push(path.resolve(inputPath));
      }
      return;
    }

    if (!stats.isDirectory()) {
      skipped.push(path.resolve(inputPath));
      return;
    }

    let entries;

    try {
      entries = await fs.readdir(inputPath, { withFileTypes: true });
    } catch (error) {
      failures.push({ path: inputPath, error: error.message });
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      await visit(path.join(inputPath, entry.name));
    }
  }

  for (const input of inputs) {
    await visit(path.resolve(input));
  }

  return { files: [...files].sort(), skipped, failures };
}

function subjectValues(data) {
  if (Array.isArray(data.Subject)) {
    return data.Subject.filter((value) => typeof value === "string");
  }

  if (typeof data.Subject === "string") {
    return [data.Subject];
  }

  return [];
}

export function desiredSubjectValues(subjects, action) {
  const withoutPrivate = subjects.filter((value) => value !== PRIVATE_TAG);

  if (action === "private") {
    return [...withoutPrivate, PRIVATE_TAG];
  }

  return withoutPrivate;
}

async function readSubject(filePath) {
  const { stdout } = await run("exiftool", ["-json", "-Subject", filePath]);
  const parsed = JSON.parse(stdout);
  return subjectValues(parsed[0] ?? {});
}

async function writeSubject(filePath, subjects) {
  const args = ["-overwrite_original"];

  if (subjects.length === 0) {
    args.push("-Subject=");
  } else {
    args.push(...subjects.map((subject) => `-Subject=${subject}`));
  }

  args.push(filePath);
  await run("exiftool", args);
}

function parseArgs(args) {
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((arg) => arg !== "--dry-run");
  const [action, ...inputs] = positional;

  if (action === "-h" || action === "--help") {
    usage();
    return null;
  }

  if (!action || !["private", "public"].includes(action)) {
    throw new Error("action must be either private or public");
  }

  if (inputs.length === 0) {
    throw new Error("at least one file or directory is required");
  }

  return { action, dryRun, inputs };
}

export async function runPrivacyCommand({ action, dryRun = false, inputs }) {
  await run("exiftool", ["-ver"]);

  const { files, skipped, failures } = await collectImages(inputs);
  const summary = {
    changed: 0,
    alreadyCorrect: 0,
    skipped: skipped.length,
    failed: failures.length,
  };

  for (const skippedPath of skipped) {
    console.log(`skip unsupported: ${skippedPath}`);
  }

  for (const failure of failures) {
    console.error(`failed: ${failure.path}: ${failure.error}`);
  }

  for (const filePath of files) {
    try {
      const currentSubjects = await readSubject(filePath);
      const nextSubjects = desiredSubjectValues(currentSubjects, action);

      if (
        currentSubjects.length === nextSubjects.length &&
        currentSubjects.every((value, index) => value === nextSubjects[index])
      ) {
        summary.alreadyCorrect += 1;
        console.log(`already ${action}: ${filePath}`);
        continue;
      }

      if (!dryRun) {
        await writeSubject(filePath, nextSubjects);
      }

      summary.changed += 1;
      console.log(`${dryRun ? "would change" : "changed"} to ${action}: ${filePath}`);
    } catch (error) {
      summary.failed += 1;
      console.error(`failed: ${filePath}: ${error.message}`);
    }
  }

  console.log(
    `summary: changed=${summary.changed} already-correct=${summary.alreadyCorrect} skipped=${summary.skipped} failed=${summary.failed}`,
  );

  if (summary.failed > 0) {
    throw new Error("one or more photos could not be processed");
  }

  return summary;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (!parsed) {
    return;
  }

  await runPrivacyCommand(parsed);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
