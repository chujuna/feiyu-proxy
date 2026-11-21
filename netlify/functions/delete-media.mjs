// 泡泡世界 · 媒体删除函数（Netlify Functions v2）
// POST /api/delete-media { path, bubble_id}
// → { ok: true}（文件已删，或 GitHub 已无此文件时同样返回 ok）
//
//
// 1. 与 upload.mjs 一起放进 feiyu-proxy 仓库的 netlify/functions/（与现有 music.mjs 同级），
// 路由由下方 config.path 声明为 /api/delete-media，无需改 netlify.toml。
// 2. Netlify 后台（Site settings → Environment variables）必须加这 5 个环境变量（与 upload 共用同一套）：
// SUPABASE_URL / SUPABASE_ANON_KEY / GITHUB_TOKEN（细粒度、只授权媒体仓库 Contents 读写）
// MEDIA_REPO（形如 chujuna/paopao-media）/ MEDIA_BRANCH（默认 main，可不填）
// ⚠️ GITHUB_TOKEN 绝不写进代码、不进前端、不经聊天传递，只填 Netlify 环境变量。
// 3. 用户需先建好媒体仓库并生成细粒度 Token（步骤同 upload.mjs 文件头）。
//
//
// - 身份只认 Supabase JWT（/auth/v1/user 验证 + profiles 查询），无效 401、已封禁 403。
// - 删除权限：必须先查 bubbles 确认该泡泡属于请求者本人，或请求者 role='admin'，否则 403。
// 防止任何人拿别人的 path 乱删文件——只认 bubble_id 绑定的归属，不信前端单给的 path。
// - path 严格校验：必须是本仓库媒体目录内的相对路径（image/ 或 audio/ 开头），禁止..、绝对路径、反斜杠。
// - jsDelivr 有 CDN 缓存：GitHub 文件删掉后，CDN 地址可能残留一阵才失效，属已知现象，不算删除失败。

export const config = { path: '/api/delete-media'};

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const MEDIA_REPO = process.env.MEDIA_REPO || '';
const MEDIA_BRANCH = process.env.MEDIA_BRANCH || 'main';

// CORS：只允许正式站点与本地调试。⚠️ 以后站点迁移到新域名时，只改这一处白名单。
const ALLOWED_ORIGINS = ['https://chujuna.github.io'];
function corsOrigin(req) {
const o = req.headers.get('origin') || '';
if (ALLOWED_ORIGINS.includes(o)) return o;
if (/^http:\/\/localhost(:\d+)?$/.test(o) || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(o)) return o;
return ALLOWED_ORIGINS[0];
}
function withCors(req, res) {
res.headers.set('Access-Control-Allow-Origin', corsOrigin(req));
res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
res.headers.set('Vary', 'Origin');
return res;
}
function json(req, obj, status = 200) {
return withCors(req, new Response(JSON.stringify(obj), {
status,
headers: { 'Content-Type': 'application/json; charset=utf-8'},
}));
}

// 校验 JWT 并取 profiles。失败返回 { error, status}。
async function authenticate(req) {
if (!SUPABASE_URL ||!SUPABASE_ANON_KEY) return { error: 'server env missing: SUPABASE_URL / SUPABASE_ANON_KEY', status: 500};
const auth = req.headers.get('authorization') || '';
const jwt = auth.startsWith('Bearer ')? auth.slice(7).trim(): '';
if (!jwt) return { error: 'missing Authorization Bearer token', status: 401};

const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + jwt},
});
if (!userRes.ok) return { error: 'invalid or expired token', status: 401};
const user = await userRes.json().catch(() => null);
if (!user ||!user.id) return { error: 'invalid token payload', status: 401};

const profRes = await fetch(
SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(user.id) + '&select=user_no,role,is_banned',
{ headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + jwt}}
);
if (!profRes.ok) return { error: 'profile lookup failed', status: 502};
const rows = await profRes.json().catch(() => null);
const profile = Array.isArray(rows)? rows[0]: null;
if (!profile) return { error: 'profile not found', status: 403};
if (profile.is_banned) return { error: 'account is banned', status: 403};
return { user, profile, jwt};
}

// path 必须落在媒体目录内：image/ 或 audio/ 开头、无穿越、无绝对路径
function isSafeMediaPath(p) {
if (typeof p!== 'string' ||!p) return false;
if (p.startsWith('/') || p.startsWith('\\') || p.includes('\\') || p.includes('\0')) return false;
if (p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false;
if (!/^(image|audio)\/[A-Za-z0-9._\-\/]+$/.test(p)) return false;
return true;
}

export default async (req) => {
if (req.method === 'OPTIONS') return withCors(req, new Response(null, { status: 204}));
if (req.method!== 'POST') return json(req, { error: 'method not allowed'}, 405);
if (!GITHUB_TOKEN ||!MEDIA_REPO) return json(req, { error: 'server env missing: GITHUB_TOKEN / MEDIA_REPO'}, 500);

const authn = await authenticate(req);
if (authn.error) return json(req, { error: authn.error}, authn.status);
const { user, profile, jwt} = authn;
const isAdmin = profile.role === 'admin';

let body;
try { body = await req.json();} catch (e) { return json(req, { error: 'invalid JSON body'}, 400);}
const path = body && body.path;
const bubbleId = body && body.bubble_id;
if (!isSafeMediaPath(path)) return json(req, { error: 'invalid media path'}, 400);
if (typeof bubbleId!== 'string' ||!bubbleId) return json(req, { error: 'bubble_id required'}, 400);

// 查 bubbles 确认归属（用请求者 JWT 走 REST，RLS 决定可见范围；管理员可读全部）
const bubRes = await fetch(
SUPABASE_URL + '/rest/v1/bubbles?id=eq.' + encodeURIComponent(bubbleId) + '&select=id,user_id,media_path',
{ headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + jwt}}
);
if (!bubRes.ok) return json(req, { error: 'bubble lookup failed'}, 502);
const brows = await bubRes.json().catch(() => null);
const bubble = Array.isArray(brows)? brows[0]: null;
if (!bubble) return json(req, { error: 'bubble not found'}, 404);
if (bubble.user_id!== user.id &&!isAdmin) return json(req, { error: 'not your bubble'}, 403);
// 若泡泡记录里存了 media_path，要求与请求 path 一致，防止借自己的泡泡删别人的文件
if (bubble.media_path && bubble.media_path!== path) return json(req, { error: 'path does not match bubble media'}, 403);

const ghHeaders = {
Authorization: 'Bearer ' + GITHUB_TOKEN,
Accept: 'application/vnd.github+json',
'X-GitHub-Api-Version': '2022-11-28',
'User-Agent': 'paopao-netlify-delete-media',
};
const ghFileUrl = 'https://api.github.com/repos/' + MEDIA_REPO + '/contents/' + path;

// 先 GET 取 sha（删除必需）。404 = 文件已不存在，视为已删除。
let getRes;
try {
getRes = await fetch(ghFileUrl + '?ref=' + encodeURIComponent(MEDIA_BRANCH), { headers: ghHeaders});
} catch (e) {
return json(req, { error: 'github request failed: ' + (e && e.message? e.message: 'network error')}, 502);
}
if (getRes.status === 404) return json(req, { ok: true, note: 'already gone on github'});
if (!getRes.ok) {
const detail = await getRes.text().catch(() => '');
return json(req, { error: 'github lookup failed (' + getRes.status + ')', detail: detail.slice(0, 300)}, 502);
}
const fileInfo = await getRes.json().catch(() => null);
const sha = fileInfo && fileInfo.sha;
if (!sha) return json(req, { error: 'github file sha missing'}, 502);

// DELETE 删除文件
let delRes;
try {
delRes = await fetch(ghFileUrl, {
method: 'DELETE',
headers: {...ghHeaders, 'Content-Type': 'application/json'},
body: JSON.stringify({
message: 'delete media of bubble ' + bubbleId,
sha,
branch: MEDIA_BRANCH,
}),
});
} catch (e) {
return json(req, { error: 'github delete request failed: ' + (e && e.message? e.message: 'network error')}, 502);
}
if (delRes.status === 404) return json(req, { ok: true, note: 'already gone on github'});
if (!delRes.ok) {
const detail = await delRes.text().catch(() => '');
return json(req, { error: 'github delete failed (' + delRes.status + ')', detail: detail.slice(0, 300)}, 502);
}
return json(req, { ok: true});
};
