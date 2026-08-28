/**
 * GET /api/codigos-postales/:cp
 *
 * Resolves a five-digit Mexican postal code to its state, municipality, city,
 * zone and colonias, from the prebuilt SEPOMEX catalogue in data/shards/.
 *
 * The status codes are part of the contract: 404 means the postal code does not
 * exist, while 5xx means this service is broken. Callers use that split to tell
 * "ask the user to type their address" apart from "retry or alert", so the two
 * must never be conflated.
 */

import { isAuthorised } from '../../lib/auth.js';
import { POSTAL_CODE_RE, lookup } from '../../lib/lookup.js';

// SEPOMEX publishes updates monthly. Cache hard at the edge so repeat postal
// codes are served without invoking this function at all.
const CACHE_CONTROL = 'public, max-age=0, s-maxage=2592000, stale-while-revalidate=86400';

export default function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!isAuthorised(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { cp } = req.query;
  const postalCode = Array.isArray(cp) ? cp[0] : cp;

  if (typeof postalCode !== 'string' || !POSTAL_CODE_RE.test(postalCode)) {
    return res.status(400).json({ error: 'invalid_postal_code' });
  }

  let payload;
  try {
    payload = lookup(postalCode);
  } catch (error) {
    // Missing or unreadable shards, which is a broken deployment rather than an
    // unknown postal code. Must not be reported as a 404.
    console.error('Postal code lookup failed:', error);
    return res.status(500).json({ error: 'lookup_unavailable' });
  }

  if (payload === null) {
    res.setHeader('Cache-Control', CACHE_CONTROL);
    return res.status(404).json({ error: 'not_found' });
  }

  res.setHeader('Cache-Control', CACHE_CONTROL);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(200).json(payload);
}
