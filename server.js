// 轻量试卷资料共享站 - 单文件服务端 (数据: Redis 或 TiDB, 文件: GitHub/GitCode Release)
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const Redis = require('ioredis');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// ---------- KV 存储 ----------
let redis = null, mysqldb = null;
let backend = (process.env.BACKEND === 'tidb') ? 'tidb' : 'redis';
async function dbInit(b) {
  backend = b === 'tidb' ? 'tidb' : 'redis';
  if (backend === 'redis') {
    if (!redis) redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  } else {
    if (!mysqldb) {
      const mysql = require('mysql2/promise'); // 按需加载，降低常驻内存
      mysqldb = await mysql.createConnection(process.env.TIDB_URL);
      await mysqldb.query('CREATE TABLE IF NOT EXISTS kv (k VARCHAR(191) PRIMARY KEY, v JSON)');
    }
  }
}
async function kvGet(k) {
  if (backend === 'redis') { const v = await redis.get(k); return v ? JSON.parse(v) : null; }
  const [rows] = await mysqldb.query('SELECT v FROM kv WHERE k=?', [k]);
  if (!rows.length) return null;
  let v = rows[0].v; if (typeof v === 'string') v = JSON.parse(v); return v;
}
async function kvSet(k, v) {
  const j = JSON.stringify(v);
  if (backend === 'redis') { await redis.set(k, j); return; }
  await mysqldb.query('INSERT INTO kv (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)', [k, j]);
}
async function kvDel(k) {
  if (backend === 'redis') { await redis.del(k); return; }
  await mysqldb.query('DELETE FROM kv WHERE k=?', [k]);
}

// ---------- 设置 ----------
const DEF_SETTINGS = {
  siteName: '试卷资料共享站', footer: '',
  smtpHost: '', smtpPort: 465, smtpUser: '', smtpPass: '', smtpFrom: '',
  ghToken: '', ghOwner: '', ghRepoName: '',
  gitcodeUrl: '', lastSync: 0, proxyOff: false,
  startPoints: 20, proxyCost: 3, uploadPoints: 10, maxFileMB: 10
};
async function getSettings() { return Object.assign({}, DEF_SETTINGS, (await kvGet('settings')) || {}); }
async function setSettings(patch) {
  const s = Object.assign(await getSettings(), patch);
  await kvSet('settings', s); return s;
}

// ---------- 会话 ----------
function sign(v) { return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url'); }
function makeToken(u) { const p = u + '.' + Date.now(); return p + '.' + sign(p); }
function checkToken(t) {
  if (!t) return null; const i = t.lastIndexOf('.');
  const p = t.slice(0, i); if (sign(p) !== t.slice(i + 1)) return null;
  const [u, ts] = p.split('.'); if (Date.now() - +ts > 30 * 864e5) return null; return u;
}
function getUser(req) {
  const match = (req.headers.cookie || '').match(/sess=([^;]+)/);
  if (!match) return null;
  return checkToken(match[1]);
}
function auth(req, res, next) { const u = getUser(req); if (!u || u === '__admin') return res.status(401).json({ e: '未登录' }); req.user = u; next(); }
function adminOnly(req, res, next) { if (getUser(req) !== '__admin') return res.status(403).json({ e: '需要管理员' }); next(); }

// ---------- 算术验证码 ----------
const captchas = {};
setInterval(() => { for (const k in captchas) if (Date.now() - captchas[k].t > 6e5) delete captchas[k]; }, 3e5);
function newCaptcha() {
  const r = () => Math.floor(Math.random() * 51); // 0-50，避免大数
  const a = r(), b = r(), c = r(), d = r();
  const id = crypto.randomUUID();
  captchas[id] = { a, b, c, d, t: Date.now() };
  return { id, q: [`${a} + ${b} = ?`, `${c} + ${d} = ?`] };
}
function checkCaptcha(body) {
  const c = captchas[body.capId]; if (!c) return '验证码已过期，请刷新';
  const a1 = parseInt(body.ans1), a2 = parseInt(body.ans2);
  if (isNaN(a1) || isNaN(a2)) { delete captchas[body.capId]; return '答案必须为数字'; }
  if (a1 !== c.a + c.b || a2 !== c.c + c.d) { delete captchas[body.capId]; return '算术题答案错误'; }
  if (Date.now() - c.t < 1200) { delete captchas[body.capId]; return '回答过快，判定为机器人，请求已驳回'; }
  delete captchas[body.capId]; return null;
}
const phoneRe = /^1[3-9]\d{9}$/;
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha = v => crypto.createHash('sha256').update(v).digest('hex');

async function sendMail(s, to, code) {
  const tr = nodemailer.createTransport({ host: s.smtpHost, port: +s.smtpPort, secure: +s.smtpPort === 465, auth: { user: s.smtpUser, pass: s.smtpPass } });
  await tr.sendMail({ from: s.smtpFrom || s.smtpUser, to, subject: `【${s.siteName}】验证码`, text: `您的验证码：${code}，10分钟内有效。` });
}

// ---------- GitHub ----------
async function ghHeaders() { const s = await getSettings(); return { Authorization: `Bearer ${s.ghToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'paper-share' }; }
async function ghRelease() {
  const s = await getSettings();
  let r = await fetch(`https://api.github.com/repos/${s.ghOwner}/${s.ghRepoName}/releases/tags/files`, { headers: await ghHeaders() });
  if (r.status === 404)
    r = await fetch(`https://api.github.com/repos/${s.ghOwner}/${s.ghRepoName}/releases`, { method: 'POST', headers: await ghHeaders(), body: JSON.stringify({ tag_name: 'files', name: 'files' }) });
  return r.json();
}
async function ghUpload(name, buf, ct) {
  const rel = await ghRelease();
  const s = await getSettings();
  const url = rel.upload_url.split('{')[0] + `?name=${encodeURIComponent(name)}`;
  const r = await fetch(url, { method: 'POST', headers: Object.assign(await ghHeaders(), { 'Content-Type': ct, 'Content-Length': buf.length }), body: buf });
  if (!r.ok) throw new Error('上传失败');
  return r.json();
}
async function ghDownloadUrl(f) {
  const s = await getSettings();
  return `https://github.com/${s.ghOwner}/${s.ghRepoName}/releases/download/files/${f.id}${f.ext ? '.' + f.ext : ''}`;
}

// ---------- 辅助 ----------
const getUserDoc = n => kvGet('user:' + n);
const saveUserDoc = u => kvSet('user:' + u.name, u);
async function allFiles() {
  const out = [];
  for (const id of (await kvGet('files')) || []) { const f = await kvGet('file:' + id); if (f) out.push(f); }
  return out.sort((a, b) => b.id - a.id);
}
const syncedNow = s => Date.now() - s.lastSync < 3 * 864e5;

// ---------- 服务 ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.get('/api/captcha', (req, res) => res.json(newCaptcha()));

app.post('/api/sendcode', async (req, res) => {
  const e = checkCaptcha(req.body); if (e) return res.status(400).json({ e });
  const { email } = req.body;
  if (!emailRe.test(email || '')) return res.status(400).json({ e: '邮箱格式错误' });
  if (await kvGet('email:' + email)) return res.status(400).json({ e: '该邮箱已注册' });
  const s = await getSettings();
  if (!s.smtpHost) return res.status(400).json({ e: '管理员未配置SMTP' });
  const code = String(Math.floor(1e5 + Math.random() * 9e5));
  await kvSet('mailcode:' + email, { code, t: Date.now() });
  try { await sendMail(s, email, code); res.json({ ok: 1 }); }
  catch (err) { res.status(500).json({ e: '邮件发送失败' }); }
});

app.post('/api/register', async (req, res) => {
  const e = checkCaptcha(req.body); if (e) return res.status(400).json({ e });
  const { name, pass, email, phone, code } = req.body;
  if (!name || !pass || name.length > 30) return res.status(400).json({ e: '参数错误' });
  if (!emailRe.test(email || '')) return res.status(400).json({ e: '邮箱格式错误' });
  if (phone && !phoneRe.test(phone)) return res.status(400).json({ e: '手机号格式错误' });
  if (await kvGet('user:' + name)) return res.status(400).json({ e: '用户名已存在' });
  if (await kvGet('email:' + email)) return res.status(400).json({ e: '该邮箱已注册' });
  if (phone && await kvGet('phone:' + phone)) return res.status(400).json({ e: '手机号已注册' });
  const mc = await kvGet('mailcode:' + email);
  if (!mc || Date.now() - mc.t > 6e5 || mc.code !== code) return res.status(400).json({ e: '验证码错误或过期' });
  const s = await getSettings();
  const u = { name, pass: sha(pass), email, phone: phone || '', points: s.startPoints, uploads: 0, reg: Date.now() };
  await saveUserDoc(u); await kvSet('email:' + email, name);
  if (phone) await kvSet('phone:' + phone, name);
  await kvDel('mailcode:' + email);
  const uidx = (await kvGet('useridx')) || []; uidx.push(name); await kvSet('useridx', uidx);
  res.setHeader('Set-Cookie', 'sess=' + makeToken(name) + '; Path=/; HttpOnly; Max-Age=2592000');
  res.json({ ok: 1 });
});

app.post('/api/login', async (req, res) => {
  const e = checkCaptcha(req.body); if (e) return res.status(400).json({ e });
  const { name, pass } = req.body;
  if (name === ADMIN_USER && pass === ADMIN_PASS) {
    res.setHeader('Set-Cookie', 'sess=' + makeToken('__admin') + '; Path=/; HttpOnly; Max-Age=2592000');
    return res.json({ ok: 1, admin: true });
  }
  const u = await getUserDoc(name);
  if (!u || u.pass !== sha(pass)) return res.status(400).json({ e: '用户名或密码错误' });
  res.setHeader('Set-Cookie', 'sess=' + makeToken(name) + '; Path=/; HttpOnly; Max-Age=2592000');
  res.json({ ok: 1 });
});

app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'sess=; Path=/; Max-Age=0'); res.json({ ok: 1 }); });

app.get('/api/me', async (req, res) => {
  const name = getUser(req);
  if (name === '__admin') return res.json({ admin: true, name: '__admin' });
  if (!name) return res.json({});
  const u = await getUserDoc(name);
  res.json(u ? { name: u.name, points: u.points, uploads: u.uploads } : {});
});

app.get('/api/site', async (req, res) => {
  const s = await getSettings();
  res.json({ siteName: s.siteName, footer: s.footer });
});

// 分类
app.get('/api/cats', async (req, res) => res.json((await kvGet('cats')) || []));
app.post('/api/cats', auth, async (req, res) => {
  const { name } = req.body;
  if (!name || name.length > 20) return res.status(400).json({ e: '分类名错误' });
  const cats = (await kvGet('cats')) || [];
  if (cats.includes(name)) return res.status(400).json({ e: '分类已存在' });
  cats.push(name); await kvSet('cats', cats); res.json({ ok: 1 });
});

// 文件列表
app.get('/api/files', async (req, res) => {
  let fs = await allFiles();
  if (req.query.cat) fs = fs.filter(f => f.cat === req.query.cat);
  const s = await getSettings();
  res.json(fs.map(f => ({
    id: f.id, name: f.name, cat: f.cat, size: f.size, by: f.by, time: f.time,
    downloads: f.downloads || 0, rate: f.rateCount ? +(f.rateSum / f.rateCount).toFixed(1) : 0,
    canMirror: syncedNow(s) && f.mirror !== false
  })));
});

// 上传 -> GitHub Release, 重命名为 ID.ext
app.post('/api/upload', auth, upload.single('file'), async (req, res) => {
  const u = await getUserDoc(req.user); if (!u) return res.status(401).json({ e: '未登录' });
  if (!req.file) return res.status(400).json({ e: '无文件' });
  const s = await getSettings();
  if (!s.ghToken || !s.ghOwner || !s.ghRepoName) return res.status(400).json({ e: '管理员未配置GitHub' });
  const id = ((await kvGet('counter:file')) || 0) + 1;
  await kvSet('counter:file', id);
  const ext = (path.extname(req.file.originalname) || '').slice(1);
  try {
    const asset = await ghUpload(id + (ext ? '.' + ext : ''), req.file.buffer, req.file.mimetype || 'application/octet-stream');
    const f = { id, name: req.file.originalname, ext, cat: req.body.cat || '默认', size: req.file.size, by: u.name, time: Date.now(), assetId: asset.id, rateSum: 0, rateCount: 0, downloads: 0, mirror: true };
    const idx = (await kvGet('files')) || []; idx.push(id);
    await kvSet('files', idx); await kvSet('file:' + id, f);
    u.points += s.uploadPoints; u.uploads++; await saveUserDoc(u);
    res.json({ ok: 1, id, points: u.points });
  } catch (err) {
    await kvSet('counter:file', id - 1);
    res.status(500).json({ e: '上传失败' });
  }
});

// 下载选项
app.get('/api/download/:id', async (req, res) => {
  const f = await kvGet('file:' + req.params.id);
  if (!f) return res.status(404).json({ e: '文件不存在' });
  const s = await getSettings();
  const cost = Math.ceil(f.size / 500 / 1024) * s.proxyCost;
  res.json({
    github: await ghDownloadUrl(f),
    proxy: s.proxyOff ? null : `/api/download/proxy/${f.id}`,
    proxyCost: cost,
    proxyHint: '由于网络原因可能无法访问或速度很慢',
    mirror: (syncedNow(s) && f.mirror !== false) ? `/api/download/mirror/${f.id}` : null
  });
});

// 中转下载(扣积分, 流式转发不缓冲整个文件, 省内存)
app.get('/api/download/proxy/:id', auth, async (req, res) => {
  const u = await getUserDoc(req.user);
  const f = await kvGet('file:' + req.params.id); if (!f) return res.status(404).json({ e: '文件不存在' });
  const s = await getSettings();
  if (s.proxyOff) return res.status(400).json({ e: '中转下载已关闭' });
  const cost = Math.ceil(f.size / 500 / 1024) * s.proxyCost;
  if (u.points < cost) return res.status(400).json({ e: `积分不足，需要${cost}分，当前${u.points}分` });
  const r = await fetch(await ghDownloadUrl(f), { redirect: 'follow' });
  if (!r.ok) return res.status(502).json({ e: 'GitHub取文件失败 HTTP ' + r.status });
  u.points -= cost; await saveUserDoc(u);
  f.downloads = (f.downloads || 0) + 1; await kvSet('file:' + f.id, f);
  await kvSet('stat:proxyBytes', ((await kvGet('stat:proxyBytes')) || 0) + (f.size || 0));
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  if (r.headers.get('content-length')) res.setHeader('Content-Length', r.headers.get('content-length'));
  Readable.fromWeb(r.body).pipe(res);
});

// 镜像下载(302跳转 GitCode)
app.get('/api/download/mirror/:id', async (req, res) => {
  const f = await kvGet('file:' + req.params.id); if (!f) return res.status(404).json({ e: '文件不存在' });
  const s = await getSettings();
  if (!s.gitcodeUrl || !syncedNow(s) || f.mirror === false) return res.status(400).json({ e: '镜像不可用' });
  f.downloads = (f.downloads || 0) + 1; await kvSet('file:' + f.id, f);
  res.redirect(s.gitcodeUrl.replace(/\/$/, '') + `/releases/download/files/${f.id}${f.ext ? '.' + f.ext : ''}`);
});

// 评价
app.post('/api/rate/:id', auth, async (req, res) => {
  const st = +req.body.stars; if (!(st >= 1 && st <= 5)) return res.status(400).json({ e: '评分错误' });
  const f = await kvGet('file:' + req.params.id); if (!f) return res.status(404).json({ e: '文件不存在' });
  const key = 'rate:' + f.id + ':' + req.user;
  if (await kvGet(key)) return res.status(400).json({ e: '已评价过' });
  await kvSet(key, { stars: st, text: (req.body.text || '').slice(0, 200), by: req.user, time: Date.now() });
  const idx = (await kvGet('rateidx:' + f.id)) || [];
  idx.push(req.user); await kvSet('rateidx:' + f.id, idx);
  f.rateSum += st; f.rateCount++; await kvSet('file:' + f.id, f);
  res.json({ ok: 1 });
});
app.get('/api/rate/:id', async (req, res) => {
  const out = [];
  for (const n of (await kvGet('rateidx:' + req.params.id)) || []) { const r = await kvGet('rate:' + req.params.id + ':' + n); if (r) out.push(r); }
  res.json(out);
});

// ---------- 管理端 ----------
app.get('/api/admin/settings', adminOnly, async (req, res) => res.json(await getSettings()));
app.post('/api/admin/settings', adminOnly, async (req, res) => {
  const allow = ['siteName', 'footer', 'smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'smtpFrom', 'ghToken', 'ghOwner', 'ghRepoName', 'gitcodeUrl', 'startPoints', 'proxyCost', 'uploadPoints', 'maxFileMB', 'proxyOff'];
  const patch = {};
  for (const k of allow) if (k in req.body) patch[k] = req.body[k];
  if (patch.proxyOff !== undefined) patch.proxyOff = !!patch.proxyOff;
  await setSettings(patch);
  res.json({ ok: 1 });
});
app.post('/api/admin/smtp-test', adminOnly, async (req, res) => {
  const s = await getSettings();
  try { await sendMail(s, s.smtpFrom || s.smtpUser, '这是一封SMTP测试邮件'); res.json({ ok: 1 }); }
  catch (e) { res.status(500).json({ e: e.message }); }
});

// 数据看板 + 成本估计 (目标: ≤$0.03/天, 即 ≤$0.90/月, 预算$1留$0.1富余)
function daysInMonth() { return new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate(); }
const DAILY_BUDGET = 0.03, MEM_PRICE = 10; // $/GB/月
app.get('/api/admin/stats', adminOnly, async (req, res) => {
  const files = await allFiles();
  const uidx = (await kvGet('useridx')) || [];
  let totalPoints = 0;
  for (const n of uidx) { const u = await getUserDoc(n); if (u) totalPoints += u.points; }
  let totalDownloads = 0; for (const f of files) totalDownloads += f.downloads || 0;
  const proxyBytes = (await kvGet('stat:proxyBytes')) || 0;
  const s = await getSettings();
  // Railway 计费: 内存 $10/GB/月 (按实际GB用量), 出口流量 $0.05/GB
  const rssGB = process.memoryUsage().rss / 1073741824;
  const dayRatio = new Date().getDate() / daysInMonth();
  const memCostMonth = +(rssGB * MEM_PRICE).toFixed(2);           // 按当前内存推算整月
  const egressCostMonth = +(proxyBytes / 1073741824 * 0.05 / (dayRatio || 1)).toFixed(2); // 按已过天数折算整月
  const memDaily = +(memCostMonth / daysInMonth()).toFixed(3);
  const egressDaily = +(egressCostMonth / daysInMonth()).toFixed(3);
  const totalDaily = +(memDaily + egressDaily).toFixed(3);
  const totalMonth = +(memCostMonth + egressCostMonth).toFixed(2);
  const advice = [];
  if (totalDaily > DAILY_BUDGET) advice.push(`⚠ 日均 $${totalDaily} 超出 $0.03 预算：建议关闭中转下载，或提高中转积分单价`);
  else if (totalDaily > DAILY_BUDGET * 0.7) advice.push('接近日预算：引导用户走 GitHub 直连 / GitCode 镜像');
  else advice.push('成本正常');
  if (rssGB > 0.085) advice.push('内存偏高：建议 Railway 设置内存上限 128MB，或重启服务');
  const egressAllowGB = +(((DAILY_BUDGET * daysInMonth()) - memCostMonth) / 0.05).toFixed(2);
  if (egressAllowGB <= 0) advice.push('内存费用已占满预算，必须缩减内存或升级预算');
  else advice.push(`本月剩余可中转流量约 ${Math.max(0, egressAllowGB - proxyBytes / 1073741824).toFixed(2)} GB`);
  res.json({
    users: uidx.length, files: files.length, totalDownloads, totalPoints, proxyBytes,
    rssMB: +(rssGB * 1024).toFixed(1),
    sync: { gitcodeConfigured: !!s.gitcodeUrl, lastSync: s.lastSync, nextSyncIn: Math.max(0, 3 * 864e5 - (Date.now() - s.lastSync)) },
    cost: {
      dailyBudget: DAILY_BUDGET, memDaily, egressDaily, totalDaily,
      memMonth: memCostMonth, egressMonth: egressCostMonth, totalMonth,
      egressGB: +(proxyBytes / 1073741824).toFixed(4), egressAllowGB: Math.max(0, egressAllowGB),
      within: totalDaily <= DAILY_BUDGET
    },
    advice
  });
});

// 立即同步 GitCode
app.post('/api/admin/sync', adminOnly, (req, res) => { syncGitcode(); res.json({ ok: 1 }); });

// GitCode 每3天镜像同步 (git push --mirror)
const fs = require('fs');
const os = require('os');
const MIRROR_DIR = path.join(os.tmpdir(), 'mirror.git');
function syncGitcode() {
  getSettings().then(s => {
    if (!s.gitcodeUrl || !s.ghToken) return;
    execFile('rm', ['-rf', MIRROR_DIR], () => {
      execFile('git', ['clone', '--mirror', `https://${s.ghToken}@github.com/${s.ghOwner}/${s.ghRepoName}.git`, MIRROR_DIR], err => {
        if (err) return console.error('gitcode sync clone fail:', err.message);
        execFile('git', ['push', '--mirror', s.gitcodeUrl], { cwd: MIRROR_DIR }, err2 => {
          if (err2) return console.error('gitcode sync push fail:', err2.message);
          setSettings({ lastSync: Date.now() }).then(() => console.log('gitcode synced'));
        });
      });
    });
  });
}
if (process.env.GITCODE_SYNC !== 'off') {
  setInterval(syncGitcode, 3 * 864e5);
  setTimeout(syncGitcode, 30000);
}

// ---------- 启动 ----------
(async () => {
  // 先用环境变量选择后端并初始化连接，再读取数据库中的设置
  await dbInit(process.env.BACKEND || 'redis');
  const s0 = await getSettings();
  // 若数据库中配置的后端与环境不同，切换后端
  if (s0.backend !== (process.env.BACKEND || 'redis')) await dbInit(s0.backend);
  if (!(await kvGet('cats'))) await kvSet('cats', ['默认']);
  app.listen(PORT, () => console.log('listening on ' + PORT));
})().catch(e => { console.error('startup failed:', e); process.exit(1); });
