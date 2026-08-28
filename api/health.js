/**
 * GET /api/health
 *
 * Proves a deployment actually shipped its data before traffic is sent to it.
 * Returns 503 if the shards are missing or a fixture postal code fails to
 * resolve, so a broken deploy is obvious without having to switch a consumer.
 */

import { lookup, stats } from '../lib/lookup.js';

const FIXTURES = {
  '01000': 'Ciudad de México',
  '44100': 'Jalisco',
  '64000': 'Nuevo León',
  '97000': 'Yucatán',
};

export default function handler(_req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const { manifest } = stats();
    const failures = [];

    for (const [postalCode, expectedState] of Object.entries(FIXTURES)) {
      const payload = lookup(postalCode);
      if (payload === null) {
        failures.push(`${postalCode}: not found`);
      } else if (payload.estado !== expectedState) {
        // Almost always a charset problem. A caller matching on the state name
        // would get nothing back, with no error anywhere to explain why.
        failures.push(`${postalCode}: expected "${expectedState}", got "${payload.estado}"`);
      }
    }

    if (failures.length > 0) {
      return res.status(503).json({ status: 'unhealthy', failures, manifest });
    }

    return res.status(200).json({ status: 'ok', manifest });
  } catch (error) {
    console.error('Health check failed:', error);
    return res.status(503).json({ status: 'unhealthy', error: String(error.message ?? error) });
  }
}
