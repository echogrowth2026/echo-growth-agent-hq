const fs = require("fs");
const path = require("path");

function isAllowed(filePath, allowed) {
  const resolved = path.resolve(filePath);
  return allowed.some(dir => resolved === path.resolve(dir) || resolved.startsWith(path.resolve(dir) + path.sep));
}

async function readFile(filePath, allowed) {
  if (!isAllowed(filePath, allowed)) return { success: false, error: `Access denied — ${filePath} is not in allowedDirs` };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { success: false, error: "not a file" };
    if (stat.size > 2 * 1024 * 1024) return { success: false, error: `file too large (${stat.size} bytes)` };
    return { success: true, content: fs.readFileSync(filePath, "utf-8"), size: stat.size };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function writeFile(filePath, content, allowed) {
  if (!isAllowed(filePath, allowed)) return { success: false, error: "Access denied" };
  try {
    const dir = path.dirname(filePath);
    if (!isAllowed(dir, allowed)) return { success: false, error: "parent dir not allowed" };
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content ?? "", "utf-8");
    return { success: true, bytes: Buffer.byteLength(content || "") };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function listDir(dirPath, allowed) {
  if (!isAllowed(dirPath, allowed)) return { success: false, error: "Access denied" };
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true }).map(e => ({
      name: e.name,
      type: e.isDirectory() ? "dir" : "file",
    }));
    return { success: true, entries };
  } catch (e) { return { success: false, error: e.message }; }
}

module.exports = { readFile, writeFile, listDir, isAllowed };
