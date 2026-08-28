/**
 * Postal code lookup, backed by the prebuilt shards in data/shards/.
 *
 * Shards are keyed by the first two digits of the postal code, so a request
 * loads at most ~390 KB instead of the full 12.8 MB catalogue. Loaded shards
 * are cached in module scope, which survives for the life of a warm serverless
 * instance.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the shards live at runtime. On Vercel the bundler may relocate the
 * function, so try the deployment root as well as a path relative to this file
 * rather than assuming either one.
 */
const SHARD_DIR_CANDIDATES = [
  join(process.cwd(), 'data', 'shards'),
  join(HERE, '..', 'data', 'shards'),
];

let shardDir = null;
const cache = new Map();

function resolveShardDir() {
  if (shardDir !== null) {
    return shardDir;
  }
  for (const candidate of SHARD_DIR_CANDIDATES) {
    if (existsSync(candidate)) {
      shardDir = candidate;
      return shardDir;
    }
  }
  throw new Error(
    `Postal code shards not found. Looked in: ${SHARD_DIR_CANDIDATES.join(', ')}. ` +
      'Check the includeFiles setting in vercel.json.',
  );
}

function loadShard(prefix) {
  if (cache.has(prefix)) {
    return cache.get(prefix);
  }
  const path = join(resolveShardDir(), `${prefix}.json`);
  // A missing shard means no postal codes start with those two digits, which is
  // a legitimate 404 rather than an error.
  const shard = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  cache.set(prefix, shard);
  return shard;
}

export const POSTAL_CODE_RE = /^\d{5}$/;

/**
 * @param {string} postalCode Five digits.
 * @returns {object | null} The postal code record, or null if unknown.
 */
export function lookup(postalCode) {
  if (!POSTAL_CODE_RE.test(postalCode)) {
    return null;
  }
  return loadShard(postalCode.slice(0, 2))[postalCode] ?? null;
}

/**
 * Used by the health check to prove a deployment actually shipped its data.
 */
export function stats() {
  const dir = resolveShardDir();
  const manifestPath = join(dir, '..', 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  return { shardDir: dir, manifest };
}
