#!/usr/bin/env node
/**
 * Checks a live deployment against every guarantee this API makes, before a
 * consumer is pointed at it.
 *
 * Usage:
 *   node scripts/verify-deployment.mjs https://mx-sepomex-api.vercel.app
 *   node scripts/verify-deployment.mjs <base-url> --token <bearer>
 */

const BASE_PATH = '/api/codigos-postales';

const REQUIRED_FIELDS = ['codigo_postal', 'estado', 'municipio', 'ciudad', 'zona', 'colonias'];

const FIXTURES = {
  '01000': { estado: 'Ciudad de México', municipio: 'Álvaro Obregón' },
  '06700': { estado: 'Ciudad de México' },
  '44100': { estado: 'Jalisco', ciudad: 'Guadalajara' },
  '64000': { estado: 'Nuevo León' },
  '97000': { estado: 'Yucatán' },
};

// Address autofill runs while someone waits on a form, so 5 seconds is the
// practical ceiling and a common client timeout.
const CLIENT_TIMEOUT_MS = 5000;

const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

async function main() {
  const [rawBase, ...rest] = process.argv.slice(2);
  if (!rawBase) {
    console.error('Usage: node scripts/verify-deployment.mjs <base-url> [--token <bearer>]');
    process.exit(2);
  }
  const base = rawBase.replace(/\/+$/, '');
  const tokenIndex = rest.indexOf('--token');
  const token = tokenIndex === -1 ? 'unset-token-probe' : rest[tokenIndex + 1];
  const headers = { Authorization: `Bearer ${token}` };

  console.log(`Verifying ${base}\n`);

  // Clients may run with max_redirects = 0, so a 3xx is a hard failure even when
  // the redirect target would have worked.
  const noRedirect = await fetch(`${base}${BASE_PATH}/01000`, { headers, redirect: 'manual' });
  const location = noRedirect.headers.get('location');
  record(
    'no redirect on the lookup path',
    noRedirect.status < 300 || noRedirect.status >= 400,
    `status ${noRedirect.status}${location ? ` -> ${location}` : ''}`,
  );

  const health = await fetch(`${base}/api/health`);
  const healthBody = await health.json().catch(() => null);
  record(
    'health check reports the data shipped',
    health.ok && healthBody?.status === 'ok',
    healthBody?.manifest
      ? `${healthBody.manifest.postalCodes} postal codes, built ${healthBody.manifest.builtAt}`
      : JSON.stringify(healthBody),
  );

  for (const [postalCode, expected] of Object.entries(FIXTURES)) {
    const started = Date.now();
    const res = await fetch(`${base}${BASE_PATH}/${postalCode}`, { headers, redirect: 'manual' });
    const elapsed = Date.now() - started;
    const body = await res.json().catch(() => null);

    if (res.status !== 200 || body === null) {
      record(`CP ${postalCode} resolves`, false, `status ${res.status}`);
      continue;
    }

    const missing = REQUIRED_FIELDS.filter((field) => !(field in body));
    const wrong = Object.entries(expected).filter(([field, value]) => body[field] !== value);

    record(
      `CP ${postalCode} resolves`,
      missing.length === 0 && wrong.length === 0,
      missing.length > 0
        ? `missing fields: ${missing.join(', ')}`
        : wrong.length > 0
          ? wrong.map(([field, value]) => `${field}: expected "${value}", got "${body[field]}"`).join('; ')
          : `${body.colonias.length} colonias, ${elapsed}ms`,
    );

    record(
      `CP ${postalCode} answers inside ${CLIENT_TIMEOUT_MS}ms`,
      elapsed < CLIENT_TIMEOUT_MS,
      `${elapsed}ms`,
    );

    // Accents must survive the wire. A caller matching on the state name gets
    // nothing back if they do not, and the response still looks like valid JSON.
    record(
      `CP ${postalCode} state name is not mojibake`,
      !/Ã|Â|�/.test(body.estado),
      `estado "${body.estado}"`,
    );
  }

  // 17xxx is unassigned in Mexico, so it can never exist.
  const unknown = await fetch(`${base}${BASE_PATH}/17000`, { headers, redirect: 'manual' });
  record('unknown postal code answers 404', unknown.status === 404, `status ${unknown.status}`);

  const malformed = await fetch(`${base}${BASE_PATH}/abc`, { headers, redirect: 'manual' });
  record('malformed postal code answers 400', malformed.status === 400, `status ${malformed.status}`);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

  if (failed.length > 0) {
    console.error('\nNot safe to send traffic here yet. Failing checks:');
    for (const failure of failed) {
      console.error(`  - ${failure.name}: ${failure.detail}`);
    }
    process.exit(1);
  }

  console.log('\nDeployment is good. Lookup base URL:');
  console.log(`  ${base}${BASE_PATH}/`);
  console.log('(clients that append the postal code to a base URL need the trailing slash)');
}

main().catch((error) => {
  console.error(`\nVerification could not run: ${error.message}`);
  process.exit(1);
});
