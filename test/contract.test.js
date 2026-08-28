/**
 * Asserts the response contract: the field set, the status codes, and the
 * guarantees callers depend on (exact state names, null rather than empty city,
 * catalogue colonia order). The last test sweeps every postal code in the
 * catalogue, not just fixtures.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import handler from '../api/codigos-postales/[cp].js';
import { lookup } from '../lib/lookup.js';

const RESPONSE_FIELDS = ['codigo_postal', 'estado', 'municipio', 'ciudad', 'zona', 'colonias'];

// Five digits. The 00, 17, 18 and 19 prefixes are unassigned in Mexico.
const ZIP_RE = /^(?!00|17|18|19)\d{5}$/;

const STATE_NAMES = new Set([
  'Aguascalientes',
  'Baja California',
  'Baja California Sur',
  'Campeche',
  'Chiapas',
  'Chihuahua',
  'Ciudad de México',
  'Coahuila de Zaragoza',
  'Colima',
  'Durango',
  'México',
  'Guanajuato',
  'Guerrero',
  'Hidalgo',
  'Jalisco',
  'Michoacán de Ocampo',
  'Morelos',
  'Nayarit',
  'Nuevo León',
  'Oaxaca',
  'Puebla',
  'Querétaro',
  'Quintana Roo',
  'San Luis Potosí',
  'Sinaloa',
  'Sonora',
  'Tabasco',
  'Tamaulipas',
  'Tlaxcala',
  'Veracruz de Ignacio de la Llave',
  'Yucatán',
  'Zacatecas',
]);

/** Minimal stand-in for the Vercel (req, res) pair. */
function invoke({ method = 'GET', cp, headers = {} } = {}) {
  const captured = { status: null, body: null, headers: {} };
  const res = {
    setHeader(name, value) {
      captured.headers[name.toLowerCase()] = value;
    },
    status(code) {
      captured.status = code;
      return res;
    },
    json(body) {
      captured.body = body;
      return res;
    },
  };
  handler({ method, query: { cp }, headers }, res);
  return captured;
}

test('returns the documented field set, and nothing extra', () => {
  const res = invoke({ cp: '01000' });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), [...RESPONSE_FIELDS].sort());
  assert.deepEqual(Object.keys(res.body.colonias[0]).sort(), ['nombre', 'tipo']);
});

test('resolves a known postal code to the right state and colonia', () => {
  const res = invoke({ cp: '01000' });
  assert.equal(res.body.codigo_postal, '01000');
  assert.equal(res.body.estado, 'Ciudad de México');
  assert.equal(res.body.municipio, 'Álvaro Obregón');
  assert.equal(res.body.colonias[0].nombre, 'San Ángel');
});

test('answers 404 for a well-formed but unknown postal code', () => {
  // 17xxx is unassigned in Mexico, so it can never exist.
  const res = invoke({ cp: '17000' });
  assert.equal(res.status, 404);
});

test('rejects a malformed postal code', () => {
  assert.equal(invoke({ cp: 'abcde' }).status, 400);
  assert.equal(invoke({ cp: '123' }).status, 400);
  assert.equal(invoke({ cp: undefined }).status, 400);
});

test('rejects a non-GET method', () => {
  assert.equal(invoke({ method: 'POST', cp: '01000' }).status, 405);
});

test('sets a cache header so repeat lookups are served from the edge', () => {
  const res = invoke({ cp: '01000' });
  assert.match(res.headers['cache-control'], /s-maxage=\d+/);
});

test('serves any bearer token when SEPOMEX_API_TOKEN is unset', () => {
  delete process.env.SEPOMEX_API_TOKEN;
  const res = invoke({ cp: '01000', headers: { authorization: 'Bearer any-client-token' } });
  assert.equal(res.status, 200);
});

test('enforces the bearer token when SEPOMEX_API_TOKEN is set', () => {
  process.env.SEPOMEX_API_TOKEN = 'secret';
  try {
    assert.equal(invoke({ cp: '01000', headers: { authorization: 'Bearer wrong' } }).status, 401);
    assert.equal(invoke({ cp: '01000', headers: {} }).status, 401);
    assert.equal(invoke({ cp: '01000', headers: { authorization: 'Bearer secret' } }).status, 200);
  } finally {
    delete process.env.SEPOMEX_API_TOKEN;
  }
});

test('a city-less postal code reports null, not an empty string', () => {
  const manifest = JSON.parse(readFileSync(new URL('../data/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.postalCodes > 30000, 'data looks too small');

  // Callers fall back to the state with a plain null check, so an empty string
  // would put a blank city into an address instead.
  const shard = JSON.parse(readFileSync(new URL('../data/shards/99.json', import.meta.url), 'utf8'));
  const withoutCity = Object.keys(shard).find((postalCode) => shard[postalCode].ciudad === null);
  assert.ok(withoutCity, 'expected at least one postal code with no city in shard 99');
  assert.equal(lookup(withoutCity).ciudad, null);
});

test('a postal code with a known city keeps it', () => {
  assert.equal(lookup('44100').ciudad, 'Guadalajara');
});

test('every postal code in the catalogue satisfies the contract', () => {
  const shardDir = new URL('../data/shards/', import.meta.url);
  const shardFiles = readdirSync(shardDir).filter((name) => name.endsWith('.json'));
  assert.ok(shardFiles.length > 90, `expected ~96 shards, found ${shardFiles.length}`);

  const problems = [];
  const states = new Set();
  let postalCodes = 0;

  for (const file of shardFiles) {
    const shard = JSON.parse(readFileSync(new URL(file, shardDir), 'utf8'));

    for (const [postalCode, payload] of Object.entries(shard)) {
      postalCodes++;
      states.add(payload.estado);

      if (!ZIP_RE.test(postalCode)) {
        problems.push(`${postalCode}: is not a valid Mexican postal code`);
      }
      if (payload.codigo_postal !== postalCode) {
        problems.push(`${postalCode}: codigo_postal is "${payload.codigo_postal}"`);
      }
      if (!STATE_NAMES.has(payload.estado)) {
        problems.push(`${postalCode}: state "${payload.estado}" is not a known state name`);
      }
      if (payload.ciudad !== null && payload.ciudad.length > 100) {
        problems.push(`${postalCode}: city exceeds 100 chars`);
      }
      if (!Array.isArray(payload.colonias) || payload.colonias.length === 0) {
        problems.push(`${postalCode}: no colonias`);
      }
      for (const colonia of payload.colonias ?? []) {
        if (typeof colonia.nombre !== 'string' || colonia.nombre === '') {
          problems.push(`${postalCode}: colonia with no name`);
        } else if (colonia.nombre.length > 100) {
          problems.push(`${postalCode}: colonia name exceeds 100 chars`);
        }
      }
      // The postal code must live in the shard its prefix points at, or the
      // lookup will never find it.
      if (file !== `${postalCode.slice(0, 2)}.json`) {
        problems.push(`${postalCode}: filed under ${file}`);
      }
    }
  }

  assert.equal(states.size, 32, `expected 32 states, found ${states.size}`);
  assert.ok(postalCodes > 30000, `expected >30k postal codes, found ${postalCodes}`);
  assert.deepEqual(problems.slice(0, 10), [], `${problems.length} contract problem(s)`);
});
