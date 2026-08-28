/**
 * Optional bearer token, off by default because the catalogue is public
 * government data.
 *
 *   SEPOMEX_API_TOKEN unset -> every request is served.
 *   SEPOMEX_API_TOKEN set   -> the bearer token must match it exactly.
 *
 * Enabling it is a config change only. A client that already sends some bearer
 * token keeps working as soon as the two values agree.
 */

export function isAuthorised(req) {
  const expected = process.env.SEPOMEX_API_TOKEN;
  if (!expected) {
    return true;
  }
  const header = req.headers.authorization ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match !== null && match[1].trim() === expected;
}
