const fs = require('fs');
const os = require('os');
const path = require('path');

class ToolError extends Error {}

const expand = (p) => (p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p);

// Real path of the deepest existing ancestor, plus the not-yet-existing remainder.
// Resolving real paths defeats ".." tricks and symlinks that point outside a root.
function realish(p) {
  let cur = path.resolve(p); const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()); }
    catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) throw new ToolError('path not found');
      rest.push(path.basename(cur)); cur = parent;
    }
  }
}

const fold = (s) => (process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s);

function within(root, target) {
  const rel = path.relative(fold(root), fold(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Returns the real path if it is inside one of the allowed roots, otherwise throws.
function resolveInRoots(input, roots) {
  if (typeof input !== 'string' || !input || input.includes('\0')) throw new ToolError('invalid path');
  if (!roots.length) throw new ToolError('no folders are allowed for this task');
  const real = realish(expand(input));
  const rootReals = roots.map((r) => { try { return fs.realpathSync.native(path.resolve(expand(r))); } catch (e) { return null; } }).filter(Boolean);
  if (!rootReals.some((r) => within(r, real))) throw new ToolError('path is outside the allowed folders');
  return real;
}

module.exports = { resolveInRoots, expand, within, ToolError };
