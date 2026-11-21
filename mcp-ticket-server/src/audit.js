'use strict';
const fs = require('fs');
const crypto = require('crypto');

// One JSON line per tool call. Records WHAT was called and what happened, never ticket content:
// arguments are stored as a hash plus a few safe identifiers. stdout belongs to the MCP protocol,
// so logs go to stderr or a file.
function createAudit({ file = null, stream = process.stderr, now = () => new Date() } = {}) {
  const entries = [];
  return {
    entries,
    record(e) {
      const line = { ts: now().toISOString(), ...e };
      entries.push(line);
      const text = JSON.stringify(line) + '\n';
      try { if (file) fs.appendFileSync(file, text, { mode: 0o600 }); else if (stream) stream.write(text); } catch { /* auditing must never break a tool call */ }
    },
  };
}
const hashInput = (v) => crypto.createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16);

module.exports = { createAudit, hashInput };
