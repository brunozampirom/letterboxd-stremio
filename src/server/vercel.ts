// vercel.json rewrites every path to /api/$1 so the catch-all function
// in api/ handles it. A Node function on Vercel is handed the
// *rewritten* path, so requests arrive with an extra leading /api
// segment, which the router would otherwise read as the username:
// /brunozampirom/manifest.json arrives as /api/brunozampirom/
// manifest.json and resolves to the Letterboxd user "api".
//
// The strip is conditional on the prefix actually being there, so a
// runtime that hands over the original path is left untouched. A
// Letterboxd user genuinely named "api" still resolves, because the
// rewrite turns /api/manifest.json into /api/api/manifest.json and
// only one segment is removed.
const API_PREFIX = /^\/api(?=[/?#]|$)/;

export function stripApiPrefix(url: string): string {
  const stripped = url.replace(API_PREFIX, '');
  if (stripped === url) return url;
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}
