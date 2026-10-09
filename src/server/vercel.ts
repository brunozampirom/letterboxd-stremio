// vercel.json rewrites every path to /api/$1 so the catch-all function
// in api/ picks it up, and the function is handed the rewritten path
// rather than the original. The router would read that leading segment
// as the username: /brunozampirom/manifest.json arrives prefixed and
// resolves to the Letterboxd user "api".
//
// The depth is not something to rely on. Production hands the function
// /api/api/<path> for a destination of /api/$1, so this peels every
// leading segment instead of a fixed count, and a deployment that
// passes the original path through is left untouched.
//
// Trade-off: a Letterboxd user named "api" can't be served. That isn't
// a real profile (letterboxd.com/api is not a user page), and pinning
// an exact prefix depth is what broke production in the first place.
const API_SEGMENT = /^\/api(?=[/?#]|$)/;

export function stripApiPrefix(url: string): string {
  let out = url;
  while (API_SEGMENT.test(out)) {
    out = out.replace(API_SEGMENT, '');
    if (!out.startsWith('/')) out = `/${out}`;
  }
  return out;
}
