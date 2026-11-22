// 泡泡世界用户名 / ID 登录：Supabase Auth 只认邮箱登录，此函数在服务端把
// 用户名（纯字母、不区分大小写）或 ID（user_no）解析成邮箱再代为登录，
// 只返回会话 token，邮箱不经过浏览器。服务密钥只存 Netlify 环境变量。
// POST /api/login { account, password } → { access_token, refresh_token } 或 { error }
function env(name) {
  try { if (typeof Netlify !== 'undefined' && Netlify.env) return Netlify.env.get(name) || ''; } catch (e) { /* 忽略 */ }
  if (typeof process !== 'undefined' && process.env) return process.env[name] || '';
  return '';
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
export default async (req) => {
  if (req.method === 'OPTIONS') return json({}, 204);
  if (req.method !== 'POST') return json({ error: '请求方式不正确' }, 405);

  const url = env('SUPABASE_URL'), anon = env('SUPABASE_ANON_KEY'), svc = env('SUPABASE_SERVICE_KEY');
  if (!url || !anon || !svc) return json({ error: '登录服务未配置' }, 500);

  let body = null;
  try { body = await req.json(); } catch (e) { /* 忽略 */ }
  const account = String((body && body.account) || '').trim();
  const password = String((body && body.password) || '');
  if (!account || !password) return json({ error: '请输入账号和密码' }, 400);

  let email = account;
  if (!account.includes('@')) {
    const filter = /^\d+$/.test(account)
      ? 'user_no=eq.' + encodeURIComponent(account)
      : 'username=ilike.' + encodeURIComponent(account);
    let rows = null, lookupOk = false;
    try {
      const r = await fetch(url + '/rest/v1/profiles?select=email&' + filter, {
        // 新版 sb_secret 密钥不是 JWT，只能走 apikey 头；放进 Bearer 会被当 JWT 解析而拒绝
        headers: { apikey: svc },
      });
      lookupOk = r.ok;
      rows = await r.json();
    } catch (e) { /* 忽略 */ }
    if (!lookupOk) return json({ error: '登录服务异常，请改用邮箱登录' }, 500);
    if (!Array.isArray(rows) || !rows.length || !rows[0].email) {
      return json({ error: '账号或密码不正确' }, 401);
    }
    email = rows[0].email;
  }

  let data = null, ok = false;
  try {
    const r = await fetch(url + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    ok = r.ok;
    data = await r.json();
  } catch (e) { /* 忽略 */ }
  if (!ok || !data || !data.access_token) return json({ error: '账号或密码不正确' }, 401);

  return json({ access_token: data.access_token, refresh_token: data.refresh_token });
};
export const config = { path: '/api/login' };
