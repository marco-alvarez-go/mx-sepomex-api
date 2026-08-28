/**
 * Guards the wire format against accidental drift.
 *
 * Consumers pin the exact field names, field order, and status code bodies, so a
 * rename or reorder here is a breaking change even when the data is fine. This
 * suite compares the live handler against test/fixtures/wire-contract.json. If a
 * change is deliberate, update the fixture in the same commit - that makes the
 * break visible in review rather than in production.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import handler from '../api/codigos-postales/[cp].js';

const CONTRACT = JSON.parse(readFileSync(new URL('fixtures/wire-contract.json', import.meta.url), 'utf8'));

function invoke({ method = 'GET', cp, headers = {}, query = {} } = {}) {
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
  handler({ method, query: { cp, ...query }, headers }, res);
  return captured;
}

function typeOf(value) {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

function matchesType(value, spec) {
  return spec.split('|').includes(typeOf(value));
}

test('200 response key order is unchanged', () => {
  const { body } = invoke({ cp: '01000' });
  // Object.keys reflects insertion order, which is the order res.json serialises.
  assert.deepEqual(Object.keys(body), CONTRACT.response['200'].keyOrder);
});

test('200 field types are unchanged', () => {
  const { body, headers } = invoke({ cp: '01000' });
  for (const [field, spec] of Object.entries(CONTRACT.response['200'].types)) {
    assert.ok(
      matchesType(body[field], spec),
      `${field}: contract says ${spec}, got ${typeOf(body[field])}`,
    );
  }
  assert.equal(headers['content-type'], CONTRACT.response['200'].headers['content-type']);
});

test('colonia entries keep their key order and types', () => {
  const { body } = invoke({ cp: '01000' });
  const { coloniaKeyOrder, coloniaTypes } = CONTRACT.response['200'];
  for (const colonia of body.colonias) {
    assert.deepEqual(Object.keys(colonia), coloniaKeyOrder);
    for (const [field, spec] of Object.entries(coloniaTypes)) {
      assert.ok(matchesType(colonia[field], spec), `colonia.${field}: expected ${spec}`);
    }
  }
});

test('a null city is serialised as null, not dropped or blanked', () => {
  // Key presence matters as much as the value: consumers read the field directly.
  const shard = JSON.parse(readFileSync(new URL('../data/shards/99.json', import.meta.url), 'utf8'));
  const cp = Object.keys(shard).find((code) => shard[code].ciudad === null);
  assert.ok(cp, 'expected a city-less postal code in shard 99');

  const { body } = invoke({ cp });
  assert.ok('ciudad' in body, 'ciudad key must always be present');
  assert.equal(body.ciudad, null);
  assert.deepEqual(Object.keys(body), CONTRACT.response['200'].keyOrder);
});

test('error bodies are unchanged', () => {
  const cases = [
    ['400', invoke({ cp: 'abc' })],
    ['404', invoke({ cp: '17000' })],
    ['405', invoke({ method: 'DELETE', cp: '01000' })],
  ];
  for (const [status, result] of cases) {
    assert.equal(result.status, Number(status));
    assert.deepEqual(result.body, CONTRACT.response[status].body);
  }
});

test('401 body is unchanged when a token is required', () => {
  process.env.SEPOMEX_API_TOKEN = 'secret';
  try {
    const result = invoke({ cp: '01000', headers: { authorization: 'Bearer wrong' } });
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, CONTRACT.response['401'].body);
  } finally {
    delete process.env.SEPOMEX_API_TOKEN;
  }
});

test('405 sets the Allow header the contract promises', () => {
  const { headers } = invoke({ method: 'DELETE', cp: '01000' });
  assert.equal(headers.allow, CONTRACT.response['405'].headers.allow);
});

test('the request needs nothing but the path param', () => {
  // No query string, no body, no headers. Anything else a caller sends is
  // ignored rather than required.
  const bare = invoke({ cp: '01000', headers: {} });
  assert.equal(bare.status, 200);

  const noisy = invoke({
    cp: '01000',
    headers: { authorization: 'Bearer anything', 'x-unexpected': '1' },
    query: { unexpected: 'ignored' },
  });
  assert.equal(noisy.status, 200);
  assert.deepEqual(noisy.body, bare.body);
});

test('the route path matches the contract', () => {
  // The filename is the route, so a rename silently moves the endpoint.
  const [, expected] = CONTRACT.request.path.match(/^\/api\/(.+)\/\{cp\}$/);
  const url = new URL(`../api/${expected}/[cp].js`, import.meta.url);
  assert.ok(readFileSync(url, 'utf8').length > 0, `expected a handler at api/${expected}/[cp].js`);
});

test('the path param format matches the contract', () => {
  const re = new RegExp(CONTRACT.request.pathParam.format);
  assert.ok(re.test('01000'));
  assert.ok(!re.test('1000'));
  assert.ok(!re.test('010000'));
  assert.ok(!re.test('0100a'));
});
