#!/usr/bin/env bun
import { chmodSync, mkdirSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = process.env.HOME;
const BIN_DIR = join(HOME, ".local/bin");
const BIN = join(BIN_DIR, "agent-relay");
const UNIT_DIR = join(HOME, ".config/systemd/user");

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function main(argv) {
  const withSystemd = argv.includes("--systemd");
  const cli = join(ROOT, "src/cli.mjs");
  chmodSync(cli, 0o755);
  mkdirSync(BIN_DIR, { recursive: true });
  if (exists(BIN)) unlinkSync(BIN);
  symlinkSync(cli, BIN);
  process.stdout.write(`linked ${BIN} -> ${cli}\n`);

  if (!withSystemd) {
    process.stdout.write(`systemd unit left untouched; rerun with --systemd to link ${join(UNIT_DIR, "agent-relay@.service")}\n`);
    return;
  }
  mkdirSync(UNIT_DIR, { recursive: true });
  const target = join(UNIT_DIR, "agent-relay@.service");
  if (exists(target)) unlinkSync(target);
  symlinkSync(join(ROOT, "systemd/agent-relay@.service"), target);
  process.stdout.write(`linked ${target}\n`);
  process.stdout.write("next: systemctl --user daemon-reload && systemctl --user enable --now agent-relay@feishu\n");
}

main(process.argv.slice(2));
