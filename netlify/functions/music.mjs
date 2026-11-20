// 肥鱼主页歌单接口：密钥只存在 Netlify 环境变量 MYHKW_KEY 里，浏览器永远拿不到。
// GET /api/music?list=1             → QQ 歌单 2206788506 的格式化数据（format=1 原样透传）
// GET /api/music?song=<id>&type=qq  → { url, pic, lrc }（服务端代调 info，缺项再单接口兜底）
export default async (req) => {
  if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
  let key = '';
  try { key = (typeof Netlify !== 'undefined' && Netlify.env) ? (Netlify.env.get('MYHKW_KEY') || '') : ''; } catch (e) { /* 忽略 */ }
  if (!key && typeof process !== 'undefined' && process.env) key = process.env.MYHKW_KEY || '';
  if (!key) return json({ error: 'missing key' }, 500);
  const u = new URL(req.url);
  const base = 'https://myhkw.cn/open/music/';
  const call = async (ep, params) => {
    const q = new URLSearchParams({ key, ...params });
    const r = await fetch(base + ep + '?' + q.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' },
    });
    if (!r.ok) throw new Error('upstream');
    return r.json();
  };
  /* 取一首歌的直链+封面+歌词：info 与 lrc 并行一次取齐，缺项才单接口兜底 */
  const resolveSongUpstream = async (id, type) => {
      let url = '', pic = '', lrc = '';
      /* 一次并行取齐：info 拿直链+封面，lrc 专用接口拿歌词；缺项才单接口兜底，不重复请求 */
      const [infoJ, lrcJ] = await Promise.all([
        call('info', { id, type, url: '1', pic: '1' }).catch(() => null),
        call('lrc', { id, type }).catch(() => null),
      ]);
      if (infoJ) {
        const d = infoJ.data;
        if (d && typeof d === 'object') {
          url = d.url || d.mp3 || d.playUrl || '';
          pic = d.pic || d.picUrl || '';
        } else if (typeof d === 'string') url = d;
      }
      if (lrcJ) {
        const d = lrcJ.data;
        if (typeof d === 'string') lrc = d;
        else if (d && typeof d === 'object') lrc = d.lrc || d.lyric || '';
      }
      if (!url) { try { const j = await call('url', { id, type }); const d = j && j.data; url = typeof d === 'string' ? d : (d && (d.url || d.mp3)) || ''; } catch (e) { /* 忽略 */ } }
      if (!pic) { try { const j = await call('pic', { id, type }); const d = j && j.data; pic = typeof d === 'string' ? d : (d && (d.pic || d.picUrl)) || ''; } catch (e) { /* 忽略 */ } }
      return { url, pic, lrc };
  };
  try {
    if (u.searchParams.get('boot')) {
      /* 开机一次取齐：歌单 + 随机一首的直链/封面/歌词，浏览器一个请求就能开播 */
      const j = await call('list', { type: 'qq', id: '2206788506', format: '1' });
      const d = (j && j.data) || {};
      const ids = d.songId || [];
      let first = null;
      if (ids.length) {
        const i = Math.floor(Math.random() * ids.length);
        const t = (d.type && d.type[i]) || 'qq';
        try { const r = await resolveSongUpstream(String(ids[i]), t); if (r && r.url) first = { id: String(ids[i]), url: r.url, pic: r.pic, lrc: r.lrc }; } catch (e) { /* 忽略 */ }
      }
      return json({ ...(j || {}), first }, 200);
    }
    if (u.searchParams.get('list')) {
      const j = await call('list', { type: 'qq', id: '2206788506', format: '1' });
      return json(j, 200);
    }
    const song = u.searchParams.get('song');
    if (song) {
      const type = u.searchParams.get('type') || 'qq';
      const r = await resolveSongUpstream(song, type);
      return json(r, 200);
    }
    return json({ error: 'bad params' }, 400);
  } catch (e) {
    return json({ error: 'upstream failed' }, 502);
  }
};

export const config = { path: '/api/music' };

function cors(r) {
  r.headers.set('Access-Control-Allow-Origin', '*');
  r.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  r.headers.set('Access-Control-Allow-Headers', '*');
  return r;
}
function json(obj, status) {
  return cors(new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  }));
}
