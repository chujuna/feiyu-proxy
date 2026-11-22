// 泡泡世界管理员改用户账号信息：改邮箱 / 重置密码必须走 Supabase Admin API。
// 调用方须带管理员本人的会话 JWT；函数验明管理员身份后才执行，
// 邮箱变更同步写回 profiles.email。服务密钥只存 Netlify 环境变量。
// POST /api/admin-user { user_id, email?, password? } → { ok: true } 或 { error }
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
  // 预检必须返回无正文的 204（带正文会让 Netlify 边缘回 502）
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }
  if (req.method !== 'POST') return json({ error: '请求方式不正确' }, 405);

  const url = env('SUPABASE_URL'), anon = env('SUPABASE_ANON_KEY'), svc = env('SUPABASE_SERVICE_KEY');
  if (!url || !anon || !svc) return json({ error: '服务未配置' }, 500);

  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: '请先登录' }, 401);

  // 验调用者身份 + 管理员角色
  let callerId = '';
  try {
    const r = await fetch(url + '/auth/v1/user', { headers: { apikey: anon, Authorization: 'Bearer ' + jwt } });
    if (r.ok) { const u = await r.json(); callerId = u && u.id || ''; }
  } catch (e) { /* 忽略 */ }
  if (!callerId) return json({ error: '登录已失效，请重新登录' }, 401);
  let isAdmin = false;
  try {
    const r = await fetch(url + '/rest/v1/profiles?select=role&id=eq.' + encodeURIComponent(callerId), {
      headers: { apikey: svc },
    });
    const rows = await r.json();
    isAdmin = Array.isArray(rows) && rows.length && rows[0].role === 'admin';
  } catch (e) { /* 忽略 */ }
  if (!isAdmin) return json({ error: '只有管理员可以修改用户账号信息' }, 403);

  let body = null;
  try { body = await req.json(); } catch (e) { /* 忽略 */ }
  const userId = String((body && body.user_id) || '');
  const email = body && body.email != null ? String(body.email).trim() : '';
  const password = body && body.password != null ? String(body.password) : '';
  if (!userId) return json({ error: '缺少目标用户' }, 400);
  if (!email && !password) return json({ error: '没有要修改的内容' }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: '邮箱格式不正确' }, 400);
  if (password && password.length < 6) return json({ error: '密码至少 6 位' }, 400);

  const patch = {};
  if (email) { patch.email = email; patch.email_confirm = true; }
  if (password) patch.password = password;

  let ok = false, data = null;
  try {
    const r = await fetch(url + '/auth/v1/admin/users/' + encodeURIComponent(userId), {
      method: 'PUT',
      headers: { apikey: svc, Authorization: 'Bearer ' + svc, 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    ok = r.ok;
    data = await r.json();
  } catch (e) { /* 忽略 */ }
  if (!ok) {
    const msg = (data && (data.msg || data.message)) || '';
    if (/already|exists|registered/i.test(msg)) return json({ error: '这个邮箱已被其他账号使用' }, 409);
    return json({ error: '修改失败，请稍后再试' }, 500);
  }

  // 邮箱同步写回 profiles（页面与登录解析都读这张表）
  if (email) {
    try {
      await fetch(url + '/rest/v1/profiles?id=eq.' + encodeURIComponent(userId), {
        method: 'PATCH',
        headers: { apikey: svc, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ email }),
      });
    } catch (e) { /* 忽略 */ }
  }

  return json({ ok: true });
};
export const config = { path: '/api/admin-user' };
