#!/usr/bin/env node
/**
 * Builds the postal-code data served by this API from the official SEPOMEX
 * (Correos de Mexico) national catalogue.
 *
 * The download is an ASP.NET WebForms page, so it needs two requests: a GET to
 * pick up __VIEWSTATE / __EVENTVALIDATION, then a POST that submits the form
 * with "all states" + "txt".
 *
 * Output: data/shards/<first two digits>.json keyed by postal code, plus
 * data/manifest.json. Nothing is written unless every validation gate passes -
 * a silently truncated or mis-encoded download must fail the build, not ship.
 *
 * Usage: node scripts/build-data.mjs [--source <file.txt>]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const SHARD_DIR = join(DATA_DIR, 'shards');
const MANIFEST = join(DATA_DIR, 'manifest.json');

const EXPORT_URL =
  'https://www.correosdemexico.gob.mx/SSLServicios/ConsultaCP/CodigoPostal_Exportar.aspx?tipoBusqueda=exportar&sTipoDoc=txt';

/**
 * The 32 official state display names, pinned so the build fails loudly if
 * SEPOMEX renames one or the file is decoded with the wrong charset. Callers
 * match these by exact string, so a mojibake name is worse than a crash: the
 * data still parses, and every lookup quietly stops resolving.
 */
const STATE_NAMES = new Set(
  [
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
  ].map((name) => name.toLowerCase()),
);

// Five digits. The 00, 17, 18 and 19 prefixes are unassigned in Mexico.
const ZIP_RE = /^(?!00|17|18|19)\d{5}$/;
const MAX_CITY = 100;
const MAX_NEIGHBOURHOOD = 100;

// Known postal codes with the state we expect. A cheap canary against a
// scrambled or partial file.
const FIXTURES = {
  '01000': 'Ciudad de México',
  '06700': 'Ciudad de México',
  '44100': 'Jalisco',
  '64000': 'Nuevo León',
  '97000': 'Yucatán',
};

const COUNT_DRIFT_TOLERANCE = 0.05;

const HTML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function hiddenField(html, name) {
  const match = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`));
  if (!match) {
    throw new Error(`Could not find hidden form field "${name}" - the SEPOMEX page layout changed.`);
  }
  return match[1].replace(/&(amp|lt|gt|quot|#39);/g, (entity) => HTML_ENTITIES[entity]);
}

async function download() {
  console.log('-> Fetching the SEPOMEX export form...');
  const page = await fetch(EXPORT_URL);
  if (!page.ok) {
    throw new Error(`SEPOMEX form returned ${page.status}`);
  }
  const html = new TextDecoder('windows-1252').decode(await page.arrayBuffer());

  const body = new URLSearchParams({
    __VIEWSTATE: hiddenField(html, '__VIEWSTATE'),
    __VIEWSTATEGENERATOR: hiddenField(html, '__VIEWSTATEGENERATOR'),
    __EVENTVALIDATION: hiddenField(html, '__EVENTVALIDATION'),
    cboEdo: '00', // all states
    rblTipo: 'txt',
    'btnDescarga.x': '30',
    'btnDescarga.y': '12',
  });

  console.log('-> Posting the form to download the national catalogue...');
  const res = await fetch(EXPORT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: EXPORT_URL },
    body,
  });
  if (!res.ok) {
    throw new Error(`SEPOMEX download returned ${res.status}`);
  }

  const disposition = res.headers.get('content-disposition') ?? '';
  if (!disposition.includes('.zip')) {
    throw new Error(
      `Expected a zip attachment, got "${res.headers.get('content-type')}". The form flow probably broke.`,
    );
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const zipPath = join(DATA_DIR, 'sepomex-raw.zip');
  const zip = Buffer.from(await res.arrayBuffer());
  writeFileSync(zipPath, zip);
  console.log(`   downloaded ${(zip.length / 1e6).toFixed(2)} MB`);

  // `unzip -p` streams the single .txt member to stdout. Present on macOS and
  // on ubuntu-latest runners.
  const raw = execFileSync('unzip', ['-p', zipPath], { maxBuffer: 256 * 1024 * 1024 });
  rmSync(zipPath);
  return new TextDecoder('windows-1252').decode(raw);
}

function parse(text) {
  const lines = text.split(/\r?\n/);
  // Line 1 is a copyright notice, line 2 is the pipe-delimited header.
  const header = lines[1]?.split('|') ?? [];
  const col = Object.fromEntries(header.map((name, index) => [name, index]));

  const required = ['d_codigo', 'd_asenta', 'd_tipo_asenta', 'D_mnpio', 'd_estado', 'd_ciudad', 'd_zona'];
  for (const name of required) {
    if (col[name] === undefined) {
      throw new Error(
        `Column "${name}" missing from the SEPOMEX header - the layout changed. Got: ${header.join(',')}`,
      );
    }
  }

  const byPostalCode = new Map();
  let rows = 0;

  for (const line of lines.slice(2)) {
    if (!line.trim()) {
      continue;
    }
    const fields = line.split('|');
    const postalCode = fields[col.d_codigo];
    if (!postalCode) {
      continue;
    }
    rows++;

    let entry = byPostalCode.get(postalCode);
    if (entry === undefined) {
      entry = { estado: [], municipio: [], ciudad: [], zona: [], colonias: [], seen: new Set() };
      byPostalCode.set(postalCode, entry);
    }

    entry.estado.push(fields[col.d_estado]);
    entry.municipio.push(fields[col.D_mnpio]);
    entry.zona.push(fields[col.d_zona]);
    // An empty city must become null, not "", so callers can fall back to the
    // state name with a plain null check.
    entry.ciudad.push(fields[col.d_ciudad]?.trim() || null);

    const nombre = fields[col.d_asenta];
    const tipo = fields[col.d_tipo_asenta];
    const key = `${nombre}|${tipo}`;
    if (nombre && !entry.seen.has(key)) {
      entry.seen.add(key);
      // Catalogue order is preserved on purpose: callers commonly prefill from
      // the first entry.
      entry.colonias.push({ nombre, tipo });
    }
  }

  return { byPostalCode, rows };
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = values[0];
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 327 postal codes have a city on some rows and a blank on others. A blank means
 * SEPOMEX did not fill that row in, not that the place has no city, so prefer a
 * real name whenever one exists - it gives the applicant "Guadalajara" instead
 * of a caller falling back to "Jalisco". Affects 37 postal codes today.
 */
function pickCity(values) {
  const named = values.filter((value) => value !== null);
  return named.length > 0 ? mostCommon(named) : null;
}

function toPayloads(byPostalCode) {
  const payloads = new Map();
  for (const [postalCode, entry] of byPostalCode) {
    payloads.set(postalCode, {
      codigo_postal: postalCode,
      estado: mostCommon(entry.estado),
      municipio: mostCommon(entry.municipio),
      ciudad: pickCity(entry.ciudad),
      zona: mostCommon(entry.zona),
      colonias: entry.colonias,
    });
  }
  return payloads;
}

function validate(payloads, rows) {
  const errors = [];
  const states = new Set();

  for (const [postalCode, payload] of payloads) {
    if (!ZIP_RE.test(postalCode)) {
      errors.push(`Postal code "${postalCode}" is not a valid Mexican postal code`);
    }
    if (!STATE_NAMES.has(String(payload.estado).toLowerCase())) {
      errors.push(`State "${payload.estado}" (CP ${postalCode}) is not a known state name`);
    }
    states.add(payload.estado);

    if (payload.ciudad !== null && payload.ciudad.length > MAX_CITY) {
      errors.push(`City too long for CP ${postalCode}: ${payload.ciudad.length} chars`);
    }
    if (payload.colonias.length === 0) {
      errors.push(`CP ${postalCode} has no colonias`);
    }
    for (const colonia of payload.colonias) {
      if (colonia.nombre.length > MAX_NEIGHBOURHOOD) {
        errors.push(`Colonia too long for CP ${postalCode}: "${colonia.nombre}"`);
      }
    }
  }

  if (states.size !== 32) {
    errors.push(`Expected 32 states, found ${states.size}`);
  }

  for (const [postalCode, expected] of Object.entries(FIXTURES)) {
    const payload = payloads.get(postalCode);
    if (payload === undefined) {
      errors.push(`Fixture CP ${postalCode} is missing from the data`);
    } else if (payload.estado !== expected) {
      errors.push(`Fixture CP ${postalCode}: expected "${expected}", got "${payload.estado}"`);
    }
  }

  if (existsSync(MANIFEST)) {
    const previous = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const comparisons = [
      ['Row', rows, previous.rows],
      ['Postal code', payloads.size, previous.postalCodes],
    ];
    for (const [label, now, before] of comparisons) {
      if (!before) {
        continue;
      }
      const drift = Math.abs(now - before) / before;
      if (drift > COUNT_DRIFT_TOLERANCE) {
        errors.push(
          `${label} count moved ${(drift * 100).toFixed(1)}% (${before} -> ${now}), over the ` +
            `${COUNT_DRIFT_TOLERANCE * 100}% tolerance. If SEPOMEX really changed this much, ` +
            'delete data/manifest.json and rerun.',
        );
      }
    }
  }

  // Report only the first few, otherwise a charset bug prints 30k lines.
  if (errors.length > 0) {
    const shown = errors.slice(0, 10).join('\n  - ');
    const more = errors.length > 10 ? `\n  ... and ${errors.length - 10} more` : '';
    throw new Error(`Validation failed with ${errors.length} problem(s):\n  - ${shown}${more}`);
  }

  return { states: states.size };
}

function write(payloads, rows) {
  rmSync(SHARD_DIR, { recursive: true, force: true });
  mkdirSync(SHARD_DIR, { recursive: true });

  const shards = new Map();
  for (const [postalCode, payload] of payloads) {
    const prefix = postalCode.slice(0, 2);
    if (!shards.has(prefix)) {
      shards.set(prefix, {});
    }
    shards.get(prefix)[postalCode] = payload;
  }

  let bytes = 0;
  for (const [prefix, contents] of [...shards].sort()) {
    const json = JSON.stringify(contents);
    writeFileSync(join(SHARD_DIR, `${prefix}.json`), json);
    bytes += Buffer.byteLength(json);
  }

  const manifest = {
    builtAt: new Date().toISOString(),
    source: 'SEPOMEX / Correos de Mexico national postal code catalogue',
    rows,
    postalCodes: payloads.size,
    shards: shards.size,
    bytes,
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main() {
  const args = process.argv.slice(2);
  const sourceIndex = args.indexOf('--source');

  const text =
    sourceIndex === -1
      ? await download()
      : new TextDecoder('windows-1252').decode(readFileSync(args[sourceIndex + 1]));

  const { byPostalCode, rows } = parse(text);
  console.log(`-> Parsed ${rows.toLocaleString()} rows into ${byPostalCode.size.toLocaleString()} postal codes`);

  const payloads = toPayloads(byPostalCode);
  const { states } = validate(payloads, rows);
  console.log(`-> Validation passed (${states} states, all postal codes valid)`);

  const manifest = write(payloads, rows);
  console.log(`-> Wrote ${manifest.shards} shards, ${(manifest.bytes / 1e6).toFixed(2)} MB total, to data/shards/`);
}

main().catch((error) => {
  console.error(`\nBuild failed: ${error.message}`);
  process.exit(1);
});
