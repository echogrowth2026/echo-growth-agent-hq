const { exec } = require("child_process");

function isSafe(cmd, allowedPrefixes, blockedPatterns) {
  if (typeof cmd !== "string" || !cmd.trim()) return false;
  const lower = cmd.toLowerCase();
  if (blockedPatterns.some(p => lower.includes(p.toLowerCase()))) return false;
  const first = lower.trim().split(/\s+/)[0] || "";
  return allowedPrefixes.some(p => first === p.toLowerCase() || first.endsWith("/" + p.toLowerCase()) || first.endsWith("\\" + p.toLowerCase()));
}

async function run(cmd, { cwd, allowedPrefixes, blockedPatterns, timeout = 30_000 }) {
  if (!isSafe(cmd, allowedPrefixes, blockedPatterns)) {
    return { success: false, error: `Command blocked: ${cmd}` };
  }
  return new Promise((resolve) => {
    exec(cmd, { timeout, cwd, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        success: !error,
        stdout: (stdout || "").slice(-5000),
        stderr: (stderr || "").slice(-2000),
        error: error?.message || null,
      });
    });
  });
}

module.exports = { run, isSafe };
