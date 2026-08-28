# mx-sepomex-api

A postal code lookup API for Mexico. Give it a five-digit código postal, get back
the state, municipality, city, zone, and every colonia registered under it.

Data comes from the official SEPOMEX catalogue published by Correos de México,
rebuilt monthly. No database, no upstream API call at request time — the
catalogue is prebuilt into the deployment, so a lookup is a file read from a
warm cache.

```bash
curl https://<deployment>/api/codigos-postales/01000
```

```json
{
  "codigo_postal": "01000",
  "estado": "Ciudad de México",
  "municipio": "Álvaro Obregón",
  "ciudad": "Ciudad de México",
  "zona": "Urbano",
  "colonias": [{ "nombre": "San Ángel", "tipo": "Colonia" }]
}
```

Built for address autofill: the caller asks for a postal code and fills in
everything except street and number, letting the person pick their colonia from
`colonias`.

## API

### `GET /api/codigos-postales/:cp`

| Status | Meaning |
|---|---|
| `200` | Found. Body as above. |
| `400` | `:cp` is not five digits. |
| `401` | Token required but missing or wrong. See [Auth](#auth). |
| `404` | Five valid digits, but no such postal code in the catalogue. |
| `405` | Method other than `GET` or `HEAD`. |
| `500` | The deployment is missing its data. Check `/api/health`. |

Fields:

| Field | Type | Notes |
|---|---|---|
| `codigo_postal` | `string` | Five digits, echoing the request. |
| `estado` | `string` | Official SEPOMEX state name, e.g. `Coahuila de Zaragoza`. |
| `municipio` | `string` | Municipality. |
| `ciudad` | `string \| null` | `null` when SEPOMEX registers no city — true for about 64% of postal codes. |
| `zona` | `string` | `Urbano`, `Semiurbano`, or `Rural`. |
| `colonias` | `{nombre, tipo}[]` | Every colonia under the postal code, in catalogue order. `tipo` is `Colonia`, `Pueblo`, `Fraccionamiento`, `Barrio`, and so on. |

Responses carry `s-maxage=2592000`, so a CDN serves repeat postal codes without
invoking the function.

### `GET /api/health`

Returns the data manifest and probes five known postal codes. `200` with
`status: "ok"`, or `503` with the failures listed. Use it to confirm a
deployment actually shipped its data before sending traffic to it.

## Stability guarantees

Callers depend on these. Changing any of them is a breaking change, however
harmless it looks:

- **`estado` is the official SEPOMEX display name, unmodified.** Callers map it
  to their own state codes by exact string match, so `Michoacán de Ocampo` never
  becomes `Michoacán`. Accents included — the source file is windows-1252, and
  decoding it as UTF-8 produces mojibake that still parses as valid JSON. That is
  the single most dangerous failure here, because a caller matching on the name
  gets nothing back and sees no error. Guarded by a build gate, a test, and
  `/api/health`.
- **`ciudad` is `null`, never `""`.** Callers fall back to `estado` on null. An
  empty string would put a blank city into an address.
- **`colonias` keeps catalogue order.** Callers commonly prefill from the first
  entry, so reordering silently changes what people see.
- **Every field in the response is always present.** `ciudad` may be `null`, but
  no key is ever omitted.
- **No redirects, ever.** Not even a trailing-slash normalisation. Clients that
  set `max_redirects: 0` treat a 3xx as a failed lookup. `vercel.json` pins
  `trailingSlash: false` and `cleanUrls: false` for this reason.
- **404 means "no such postal code"**, and is distinct from 5xx, which means the
  service is broken. Callers rely on that split to tell "let the user type their
  address by hand" apart from "retry or alert".

## Data

`scripts/build-data.mjs` downloads the catalogue directly from SEPOMEX. The
download page is ASP.NET WebForms, so the script GETs it for `__VIEWSTATE` and
`__EVENTVALIDATION`, then POSTs the form asking for all states in txt format.
Fully automatic — nothing is downloaded by hand.

The source is a windows-1252, pipe-delimited file: ~159k rows over ~31.9k postal
codes. Output is `data/shards/<first two digits>.json` — 96 shards, ~12 MB total
— so a lookup reads at most ~390 KB rather than the whole catalogue.

```bash
node scripts/build-data.mjs                    # download and rebuild
node scripts/build-data.mjs --source file.txt  # rebuild from a local export
node --test test/contract.test.js              # 11 tests, sweeps all 31.9k codes
```

Nothing is written unless every gate passes: all 32 states present and spelled as
expected, every postal code five digits with an assigned prefix, field lengths
within limits, five fixture postal codes resolving to the right state, and row
counts within 5% of the previous build. A truncated or mis-decoded download fails
the build instead of shipping an API that answers "not found" for all of Mexico.

Two judgement calls the raw data forces:

- **Blank cities.** 327 postal codes have a city on some rows and a blank on
  others. A blank means SEPOMEX did not fill that row in, not that the place has
  no city, so a real name wins whenever one exists. `null` only when every row is
  blank. Affects 37 postal codes.
- **Duplicate colonias.** The catalogue repeats identical name + type pairs under
  different internal ids. They are deduplicated, or a picker shows "Centro"
  twice.

Shards are committed, so deploying needs no build step.
`.github/workflows/refresh-data.yml` rebuilds monthly and commits only when the
data actually changed.

## Deploying

```bash
npx vercel login
npx vercel --prod
node scripts/verify-deployment.mjs https://<deployment-url>
```

`verify-deployment.mjs` checks a live URL for redirects, response shape, encoding,
404 and 400 handling, and whether responses land inside a 5 second client timeout.
It exits non-zero if anything would break, so run it before pointing a consumer at
a new deployment.

Vercel settings that matter:

- **Deployment Protection must be off** for the URL consumers use, or they get a
  401 instead of a payload.
- Region is `iad1`. Move it closer if your consumer runs elsewhere.
- The Hobby plan is licensed for non-commercial use. Anything production-facing
  belongs on Pro.

## Auth

Off by default, because the catalogue is public government data.

- `SEPOMEX_API_TOKEN` **unset**: every request is served.
- `SEPOMEX_API_TOKEN` **set**: requests must send `Authorization: Bearer <token>`
  matching it exactly, or get a 401.

Setting the variable is the whole change — no code edit, and clients that already
send some bearer token keep working once the values agree.

## Limits

This is a key lookup on a postal code, and nothing else. There is no search by
street, city, or free text, and the underlying catalogue could not answer those
anyway — it has no street-level data.
