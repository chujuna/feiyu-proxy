// 泡泡世界免邮箱注册：站点关闭邮箱验证时，注册只填用户名+密码。
// 此函数在服务端用 Admin API 建号（内部邮箱 <用户名>@users.paopao.app、自动确认），
// 页面随后用用户名走 /api/login 登录。服务密钥只存 Netlify 环境变量。
// POST /api/register { username, password } → { ok: true } 或 { error }
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

  const url = env('SUPABASE_URL'), svc = env('SUPABASE_SERVICE_KEY');
  if (!url || !svc) return json({ error: '注册服务未配置' }, 500);

  let body = null;
  try { body = await req.json(); } catch (e) { /* 忽略 */ }
  const username = String((body && body.username) || '').trim();
  const password = String((body && body.password) || '');
  if (!/^[A-Za-z]{1,8}$/.test(username)) return json({ error: '用户名只能是 1-8 位纯字母' }, 400);
  if (password.length < 6) return json({ error: '密码至少 6 位' }, 400);

  let data = null, ok = false;
  try {
    const r = await fetch(url + '/auth/v1/admin/users', {
      method: 'POST',
      headers: { apikey: svc, Authorization: 'Bearer ' + svc, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: username.toLowerCase() + '@users.paopao.app',
        password,
        email_confirm: true,
        user_metadata: { username },
      }),
    });
    ok = r.ok;
    data = await r.json();
  } catch (e) { /* 忽略 */ }
  if (!ok || !data || !data.id) {
    const msg = (data && (data.msg || data.message)) || '';
    if (/already|exists|registered/i.test(msg)) return json({ error: '用户名「' + username + '」已被占用，换一个' }, 409);
    return json({ error: '注册失败，请稍后再试' }, 500);
  }

  return json({ ok: true });
};
export const config = { path: '/api/register' };
