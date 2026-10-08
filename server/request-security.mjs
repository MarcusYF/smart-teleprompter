// Local API: browser requests must come from this app, not an arbitrary page.
// CLI requests without Origin remain supported. Only external slide-state
// updates intentionally allow cross-origin access; they never send clicks.
export function checkRequest(req, port = 5217) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const host = String(req.headers.host || '').toLowerCase();
  if (!hosts.has(host)) return { status: 403, error: 'Invalid local host' };
  const pathname = new URL(req.url, `http://${host}`).pathname;
  const external = pathname === '/api/slides/state';
  const origin = req.headers.origin;
  if (origin && !external && origin !== `http://${host}`) return { status: 403, error: 'Cross-origin access denied' };
  if (req.headers['sec-fetch-site'] === 'cross-site' && !external) return { status: 403, error: 'Cross-site access denied' };
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
  if (req.method === 'POST' && hasBody && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    return { status: 415, error: 'Use application/json' };
  }
  return null;
}
