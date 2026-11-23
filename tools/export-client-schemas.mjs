#!/usr/bin/env node
// Regenerate clients/antigravity/*.json from the live server's registered tools.
//
// The Antigravity client schemas are a cache of what the server advertises over
// MCP. Hand-maintaining them let three of them drift (heyloey_done, heyloey_learn,
// read_text_file) while the parity test kept passing, because that test sampled
// three fields instead of comparing the whole schema. This script derives every
// file from the same zod definitions the server registers, using the same
// conversion the MCP SDK applies when it answers tools/list, so the checked-in
// copy cannot disagree with the wire format.
//
// Usage: node tools/export-client-schemas.mjs [--check]
//   (no flag)  rewrite clients/antigravity/*.json
//   --check    exit 1 if any file differs from what the server would emit

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer} from '../src/safe-mcp.mjs';
// The package's exports map already prefixes "./*" with "dist/esm/", so these
// subpaths resolve to dist/esm/server/*.js. Spelling out dist/esm/ here would
// double the prefix and fail with ERR_MODULE_NOT_FOUND.
import {normalizeObjectSchema} from '@modelcontextprotocol/sdk/server/zod-compat.js';
import {toJsonSchemaCompat} from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';

// The Antigravity client re-serialises the parameters object with sorted keys and
// writes no trailing newline; the checked-in copies were taken from that cache.
// Reproduce both exactly, so a regeneration touches only the files whose content
// actually changed instead of rewriting all of them over key order or a newline.
// The envelope keeps its natural name/description/parameters order.
function sortKeys(node) {
  if (Array.isArray(node)) return node.map(sortKeys);
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.keys(node).sort().map((key) => [key, sortKeys(node[key])]));
  }
  return node;
}

function stableJson({name, description, parameters}) {
  return JSON.stringify({name, description, parameters: sortKeys(parameters)});
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../clients/antigravity');
const CHECK = process.argv.includes('--check');

// createServer needs a vault root to build its policy. The schemas do not depend
// on the vault, so any real directory works; a temp dir keeps this hermetic.
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'loey-schema-export-'));
try {
  const server = await createServer({vault: scratch, cli: '/bin/true'});
  const tools = server._registeredTools;
  const names = Object.keys(tools).sort();

  const rendered = new Map();
  for (const name of names) {
    const tool = tools[name];
    const obj = normalizeObjectSchema(tool.inputSchema);
    if (!obj) throw new Error(`${name}: inputSchema is not an object schema`);
    // Identical options to McpServer's tools/list handler (mcp.js:116-121).
    const parameters = toJsonSchemaCompat(obj, {strictUnions: true, pipeStrategy: 'input'});
    rendered.set(`${name}.json`, stableJson({name, description: tool.description, parameters}));
  }

  const instructions = server.server._instructions ?? '';
  rendered.set('instructions.md', instructions);

  let drifted = 0;
  for (const [file, body] of rendered) {
    const target = path.join(OUT_DIR, file);
    let current = null;
    try { current = await fs.readFile(target, 'utf8'); } catch {}
    if (current === body) continue;
    drifted += 1;
    if (CHECK) {
      console.error(`drift: clients/antigravity/${file}`);
    } else {
      await fs.writeFile(target, body);
      console.log(`wrote clients/antigravity/${file}`);
    }
  }

  // A file left behind by a tool that no longer exists is drift too: the client
  // would keep offering a tool the server cannot answer.
  for (const file of await fs.readdir(OUT_DIR)) {
    if (rendered.has(file)) continue;
    drifted += 1;
    if (CHECK) {
      console.error(`stale: clients/antigravity/${file}`);
    } else {
      await fs.rm(path.join(OUT_DIR, file));
      console.log(`removed stale clients/antigravity/${file}`);
    }
  }

  if (CHECK) {
    if (drifted > 0) {
      console.error(`${drifted} client schema file(s) drifted from the server; run: node tools/export-client-schemas.mjs`);
      process.exitCode = 1;
    } else {
      console.log(`client schemas match the server (${rendered.size} files)`);
    }
  } else {
    console.log(drifted === 0 ? 'client schemas already current' : `updated ${drifted} file(s)`);
  }
} finally {
  await fs.rm(scratch, {recursive: true, force: true});
}
