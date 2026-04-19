// COMPUTER ACCESS — filtered server-side file/command module. Runs on
// Railway's Linux container, NOT on Sam's local machine. For true
// local access we'd need a desktop companion app (future work).
//
// Everything here is gated by an allowlist of directories and a
// blocklist of commands. External callers hit these via
// /api/computer/* routes registered by dash-agent.js.

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { dirname } from "path";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// Allowlist is resolved to absolute paths, then every read/write path
// is normalised and checked for containment. Symlinks are rejected.
const ALLOWED_DIRECTORIES = [
  REPO_ROOT,
  path.join(REPO_ROOT, "server", "data"),
  "/app",          // Railway container working dir
  "/app/server/data",
  "/tmp/echo",     // Scratchpad
];

const ALLOWED_COMMANDS = new Set([
  "git", "npm", "node", "ls", "cat", "pwd", "echo",
]);

const BLOCKED_COMMAND_TOKENS = [
  "rm", "rmdir", "unlink", "shutdown", "reboot", "mkfs", "dd",
  "curl", "wget", "nc", "ncat", "ssh", "scp", "sudo",
  "kill", "pkill", "killall", "reg", "taskkill", "format",
];

function resolveAllowed(targetPath) {
  const abs = path.resolve(targetPath);
  const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
  return ALLOWED_DIRECTORIES.some(dir => {
    const root = path.resolve(dir);
    return real === root || real.startsWith(root + path.sep);
  }) ? real : null;
}

// ─── FILE I/O ───────────────────────────────────────────────────────
export function readFileSafe(targetPath, { encoding = "utf8", maxBytes = 1 * 1024 * 1024 } = {}) {
  const abs = resolveAllowed(targetPath);
  if (!abs) return { ok: false, error: "path not allowed" };
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return { ok: false, error: "not a file" };
    if (stat.size > maxBytes) return { ok: false, error: `file too large (${stat.size} > ${maxBytes})` };
    return { ok: true, path: abs, size: stat.size, content: fs.readFileSync(abs, encoding) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function writeFileSafe(targetPath, content, { append = false } = {}) {
  const abs = resolveAllowed(targetPath);
  if (!abs) return { ok: false, error: "path not allowed" };
  try {
    const dir = path.dirname(abs);
    if (!resolveAllowed(dir)) return { ok: false, error: "parent dir not allowed" };
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (append) fs.appendFileSync(abs, content);
    else fs.writeFileSync(abs, content);
    return { ok: true, path: abs, bytes: Buffer.byteLength(content || "") };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── COMMAND EXEC ───────────────────────────────────────────────────
// We use execFile (not exec) so arguments are passed as an array and
// shell interpolation is impossible. The command itself is checked
// against the allowlist; arguments are scanned for blocked tokens.
export async function runCommandSafe(command, args = [], { timeoutMs = 20_000, cwd = REPO_ROOT } = {}) {
  if (typeof command !== "string" || !command) return { ok: false, error: "command required" };
  if (!ALLOWED_COMMANDS.has(command)) return { ok: false, error: `command not allowed: ${command}` };
  const safeArgs = Array.isArray(args) ? args.map(String) : [];
  for (const a of safeArgs) {
    const lowered = a.toLowerCase();
    if (BLOCKED_COMMAND_TOKENS.some(t => lowered === t || lowered.includes(`${t} `))) {
      return { ok: false, error: `blocked token in args: ${a}` };
    }
    // Block shell-injection-flavoured characters even in args.
    if (/[;&|`$(){}<>]/.test(a)) return { ok: false, error: `illegal char in arg: ${a}` };
  }
  try {
    const { stdout, stderr } = await exec(command, safeArgs, { cwd, timeout: timeoutMs, maxBuffer: 1 * 1024 * 1024 });
    return { ok: true, stdout: stdout.slice(-8000), stderr: stderr.slice(-2000) };
  } catch (e) {
    return { ok: false, error: e.message.substring(0, 500), stdout: e.stdout?.slice?.(-2000), stderr: e.stderr?.slice?.(-2000) };
  }
}

// Screenshot isn't meaningful on a headless Linux container unless we
// pair it with the Puppeteer browser module — defer until then.
export async function screenshotSafe() {
  return { ok: false, error: "not implemented on server — requires desktop companion" };
}

export function computerAccessStatus() {
  return {
    allowedDirectories: ALLOWED_DIRECTORIES,
    allowedCommands: [...ALLOWED_COMMANDS],
    platform: process.platform,
  };
}
