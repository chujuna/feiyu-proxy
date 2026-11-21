// 泡泡世界 · 媒体上传函数（Netlify Functions v2）
// POST /api/upload { kind:'image'|'audio', filename, mime, data_base64}
// → { url: 'https://cdn.jsdelivr.net/gh/<MEDIA_REPO>@<branch>/<path>', path}
//
//
// 1. 把本文件放进 feiyu-proxy 仓库的 netlify/functions/ 目录（与现有 music.mjs 同级），
// 或放进该仓库根目录 functions/ —— 以仓库现有 netlify.toml 的 functions 配置为准，保持同一种放法。
// 路由由下方 config.path 声明为 /api/upload，无需改 netlify.toml。
// 2. Netlify 后台（Site settings → Environment variables）必须加这 5 个环境变量：
// SUPABASE_URL Supabase 项目地址，如 https://xxxx.supabase.co
// SUPABASE_ANON_KEY Supabase anon public key（前端同款公开 key）
// GITHUB_TOKEN GitHub 细粒度 Token：只授权媒体仓库、只给 Contents 读写
// MEDIA_REPO 媒体仓库，形如 chujuna/paopao-media
// MEDIA_BRANCH 媒体仓库分支，默认 main（可不填）
// ⚠️ GITHUB_TOKEN 绝不写进代码、不进前端、不经聊天传递，只填 Netlify 环境变量。
// 3. 用户需先在 GitHub 建好媒体仓库（建议 chujuna/paopao-media），再生成上面的细粒度 Token。
//
//
// - 身份只认 Supabase JWT：先调 /auth/v1/user 验证，再用该 JWT 查 profiles（走 RLS），伪造/过期一律 401。
// - 已封禁用户禁止上传（403）。
// - 文件大小按 base64 解码后的真实字节数校验；扩展名由服务端按 mime 白名单决定，不信任用户给的 filename。
// - 存储路径由服务端生成（类型/年/月/纯数字用户ID-随机串），用户无法控制路径、无法覆盖他人文件。

export const config = { path: '/api/upload'};

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

// mime 白名单 → 扩展名（扩展名只由这里决定）
const MIME_EXT = {
image: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif'},
audio: { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav'},
};
const SIZE_LIMIT = { image: 5 * 1024 * 1024, audio: 10 * 1024 * 1024};

// 校验 JWT 并取 profiles（未封禁检查、user_no）。失败返回 { error, status}。
async function authenticate(req) {
if (!SUPABASE_URL ||!SUPABASE_ANON_KEY) return { error: 'server env missing: SUPABASE_URL / SUPABASE_ANON_KEY', status: 500};
const auth = req.headers.get('authorization') || '';
const jwt = auth.startsWith('Bearer ')? auth.slice(7).trim(): '';
if (!jwt) return { error: 'missing Authorization Bearer token', status: 401};

// 1) 向 Supabase Auth 验证 JWT 本身
const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + jwt},
});
if (!userRes.ok) return { error: 'invalid or expired token', status: 401};
const user = await userRes.json().catch(() => null);
if (!user ||!user.id) return { error: 'invalid token payload', status: 401};

// 2) 用该 JWT 走 REST 查自己的 profile（RLS 只放行本人行）
const profRes = await fetch(
SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(user.id) + '&select=user_no,role,is_banned',
{ headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + jwt}}
);
if (!profRes.ok) return { error: 'profile lookup failed', status: 502};
const rows = await profRes.json().catch(() => null);
const profile = Array.isArray(rows)? rows[0]: null;
if (!profile) return { error: 'profile not found', status: 403};
if (profile.is_banned) return { error: 'account is banned', status: 403};
return { user, profile};
}

function randomStr(n) {
const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
const buf = new Uint8Array(n);
crypto.getRandomValues(buf);
return Array.from(buf, (b) => chars[b % chars.length]).join('');
}

export default async (req) => {
if (req.method === 'OPTIONS') return withCors(req, new Response(null, { status: 204}));
if (req.method!== 'POST') return json(req, { error: 'method not allowed'}, 405);
if (!GITHUB_TOKEN ||!MEDIA_REPO) return json(req, { error: 'server env missing: GITHUB_TOKEN / MEDIA_REPO'}, 500);

const authn = await authenticate(req);
if (authn.error) return json(req, { error: authn.error}, authn.status);
const userNo = authn.profile.user_no;
if (!Number.isInteger(userNo)) return json(req, { error: 'profile user_no missing'}, 500);

let body;
try { body = await req.json();} catch (e) { return json(req, { error: 'invalid JSON body'}, 400);}
const kind = body && body.kind;
const mime = (body && typeof body.mime === 'string')? body.mime.toLowerCase().split(';')[0].trim(): '';
const dataBase64 = body && body.data_base64;
if (kind!== 'image' && kind!== 'audio') return json(req, { error: 'kind must be image or audio'}, 400);
const ext = MIME_EXT[kind][mime];
if (!ext) return json(req, { error: 'mime not allowed for ' + kind + ': ' + (mime || '(empty)')}, 400);
if (typeof dataBase64!== 'string' ||!dataBase64) return json(req, { error: 'data_base64 required'}, 400);

// 按解码后的真实字节数校验大小（不信任任何前端声明的长度）
let bytes;
try { bytes = Buffer.from(dataBase64, 'base64');} catch (e) { return json(req, { error: 'data_base64 decode failed'}, 400);}
if (!bytes.length) return json(req, { error: 'empty file'}, 400);
if (bytes.length > SIZE_LIMIT[kind]) {
return json(req, { error: kind + ' file too large: ' + bytes.length + ' bytes (limit ' + SIZE_LIMIT[kind] + ')'}, 413);
}

// 服务端生成路径：paopao/file/{YYYY-MM-DD}/{kind}-{user_no}-{随机12位}.{ext}（日期按 Asia/Shanghai）
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const path = 'paopao/file/' + day + '/' + kind + '-' + userNo + '-' + randomStr(12) + '.' + ext;

// GitHub Contents API 上传（PUT 新文件）
const ghUrl = 'https://api.github.com/repos/' + MEDIA_REPO + '/contents/' + path;
let ghRes;
try {
ghRes = await fetch(ghUrl, {
method: 'PUT',
headers: {
Authorization: 'Bearer ' + GITHUB_TOKEN,
Accept: 'application/vnd.github+json',
'X-GitHub-Api-Version': '2022-11-28',
'Content-Type': 'application/json',
'User-Agent': 'paopao-netlify-upload',
},
body: JSON.stringify({
message: 'upload ' + kind + ' by user ' + userNo,
content: bytes.toString('base64'),
branch: MEDIA_BRANCH,
}),
});
} catch (e) {
return json(req, { error: 'github request failed: ' + (e && e.message? e.message: 'network error')}, 502);
}
if (!ghRes.ok) {
const detail = await ghRes.text().catch(() => '');
return json(req, { error: 'github upload failed (' + ghRes.status + ')', detail: detail.slice(0, 300)}, 502);
}

const url = 'https://cdn.jsdelivr.net/gh/' + MEDIA_REPO + '@' + MEDIA_BRANCH + '/' + path;
return json(req, { url, path});
};
