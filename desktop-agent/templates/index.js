// Template registry. Auto-loads every .js file in this folder except
// ones prefixed with "_" (those are shared helpers/types). Each
// template module must export a Template-shaped object — see _schema.js.

const fs = require("fs");
const path = require("path");

const TEMPLATES_DIR = __dirname;
const registry = new Map();

function loadAll() {
  registry.clear();
  const files = fs.readdirSync(TEMPLATES_DIR)
    .filter(f => f.endsWith(".js") && !f.startsWith("_") && f !== "index.js");
  for (const f of files) {
    const full = path.join(TEMPLATES_DIR, f);
    try {
      // Defeat require cache so editing a template during development
      // doesn't require an Electron restart — a reload event can call
      // loadAll() again and pick up changes.
      delete require.cache[require.resolve(full)];
      const mod = require(full);
      const name = mod.name || path.basename(f, ".js");
      if (typeof mod.run !== "function") {
        console.warn(`[templates] ${f} skipped — no run(browser, params) export`);
        continue;
      }
      registry.set(name, { ...mod, name });
    } catch (e) {
      console.error(`[templates] ${f} failed to load:`, e.message);
    }
  }
  console.log(`[templates] Loaded ${registry.size}: ${[...registry.keys()].join(", ") || "(none)"}`);
}

loadAll();

function listTemplates() {
  return [...registry.values()].map(t => ({
    name: t.name,
    description: t.description || "",
    requiredParams: t.requiredParams || [],
    timeoutMs: t.timeoutMs || null,
  }));
}

function getTemplate(name) {
  return registry.get(name) || null;
}

async function executeTemplate(name, params, browser) {
  const tpl = getTemplate(name);
  if (!tpl) {
    return { success: false, result: null, error: `unknown template: ${name}`, durationMs: 0 };
  }
  if (!browser) {
    return { success: false, result: null, error: "browser not running", durationMs: 0 };
  }
  // Required-params guard.
  const required = tpl.requiredParams || [];
  for (const key of required) {
    if (params?.[key] == null || params[key] === "") {
      return { success: false, result: null, error: `missing required param: ${key}`, durationMs: 0 };
    }
  }
  const started = Date.now();
  try {
    const result = await tpl.run(browser, params || {});
    // Templates should return a TemplateResult already, but defend
    // against templates that return a bare value.
    if (result && typeof result === "object" && "success" in result) {
      return { durationMs: Date.now() - started, ...result };
    }
    return { success: true, result, error: null, durationMs: Date.now() - started };
  } catch (e) {
    return { success: false, result: null, error: e.message || String(e), durationMs: Date.now() - started };
  }
}

module.exports = { listTemplates, getTemplate, executeTemplate, reload: loadAll };
