export default async (req) => {
  if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
  const u = new URL(req.url);
  const target = u.searchParams.get('url');
  if (!target) return cors(new Response('missing url param', { status: 400 }));
  let t;
  try { t = new URL(target); } catch (e) { return cors(new Response('bad url', { status: 400 })); }
  if (t.protocol !== 'http:' && t.protocol !== 'https:') {
    return cors(new Response('bad protocol', { status: 400 }));
  }
  let resp;
  try {
    resp = await fetch(t.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': t.origin + '/',
      },
    });
  } catch (e) {
    return cors(new Response('upstream fetch failed', { status: 502 }));
  }
  const ct = resp.headers.get('content-type') || '';
  const isPlaylist = /\.m3u8($|\?)/i.test(t.pathname + t.search) || ct.includes('mpegurl');
  if (isPlaylist) {
    const text = await resp.text();
    const base = t.href;
    const self = u.origin + u.pathname + '?url=';
    const abs = (x) => { try { return new URL(x, base).href; } catch (e) { return null; } };
    const out = text.split('\n').map(line => {
      const s = line.trim();
      if (!s) return line;
      if (s.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (m, x) => {
          const a = abs(x);
          return a ? 'URI="' + self + encodeURIComponent(a) + '"' : m;
        });
      }
      const a = abs(s);
      return a ? self + encodeURIComponent(a) : line;
    }).join('\n');
    return cors(new Response(out, {
      status: resp.status,
      headers: { 'content-type': 'application/vnd.apple.mpegurl; charset=utf-8' },
    }));
  }
  const body = await resp.arrayBuffer();
  return cors(new Response(body, {
    status: resp.status,
    headers: { 'content-type': ct || 'application/octet-stream' },
  }));
};

export const config = { path: '/api/proxy' };

function cors(r) {
  r.headers.set('Access-Control-Allow-Origin', '*');
  r.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  r.headers.set('Access-Control-Allow-Headers', '*');
  return r;
}
