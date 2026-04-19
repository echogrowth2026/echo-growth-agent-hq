// JSDoc type definitions for the template system. No runtime exports.
// Loaded via JSDoc imports in other template files so editors can hint
// on the shape without us shipping TypeScript.

/**
 * @typedef {Object} TemplateResult
 * @property {boolean} success
 * @property {*} result          Arbitrary payload from the template (may be null)
 * @property {string|null} error Human-readable failure reason
 * @property {number} durationMs Wall-clock time spent in run()
 * @property {string} [screenshotPath] Path to the error screenshot if one was taken
 */

/**
 * @typedef {Object.<string, *>} TemplateParams
 */

/**
 * @typedef {Object} Template
 * @property {string} name
 * @property {string} [description]
 * @property {string[]} [requiredParams]
 * @property {number} [timeoutMs]
 * @property {(browser: import("puppeteer").Browser, params: TemplateParams) => Promise<TemplateResult>} run
 */

module.exports = {};
