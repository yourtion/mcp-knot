const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { packAll } = require('./release-packages.cjs');
const output = mkdtempSync(join(tmpdir(), 'mcp-knot-pack-'));
try {
  packAll(output);
} finally {
  rmSync(output, { recursive: true, force: true });
}
