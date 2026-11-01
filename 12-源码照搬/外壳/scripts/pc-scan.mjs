#!/usr/bin/env node
/**
 * pc-scan —— 本地电脑场景的扫描端（2026-10-31 补建）
 *
 * 为什么存在：renderer\renderers.js 的 pc-toplarge / pc-junk 面板只读 JSON、自己不能扫盘，
 * 注释里写的产出方 `scripts\pc-scan.mjs` 从来没被建过 ⇒ 面板永远停在「还没扫过」。
 *
 * 产出：外壳\data\pc-cleanup-scan.json（路径来自 renderer 的 PC_DATA.scan = paths.dataDir）
 * 结构（面板读的字段，少一个就会空态或报错）：
 *   scannedAt    ISO 字符串
 *   tookSec      本次扫描用时（秒）
 *   minGb        小于这个体积的目录不进榜
 *   items        [{ path, gb }]        全盘大户排行（按 gb 倒序）
 *   byDrive      { "C:": [{ path, gb }] }  单盘排行（点分区卡时用）
 *   junk         [{ k, path, gb, note }]   可清理体检（缓存/临时/回收站…）
 *   junkTotalGb  体检合计
 *
 * 只读：只 stat / readdir / readFile，不删除、不改名、不执行任何外部命令。
 *
 * 用法：
 *   node scripts\pc-scan.mjs
 *   node scripts\pc-scan.mjs --min-gb 1 --max-sec 240 --drives C,D
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellDir = path.resolve(here, '..');           // 外壳
const dataDir = path.join(shellDir, 'data');
const GB = 1024 ** 3;

// ---------- 参数 ----------
const argv = process.argv.slice(2);
function argVal(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return dflt;
}
const MIN_GB = Math.max(0, Number(argVal('min-gb', '0.5')) || 0.5);
const MAX_SEC = Math.max(10, Number(argVal('max-sec', '900')) || 900);
const SKIP_JUNK = argv.includes('--skip-junk');   // 只刷大盘排行（体检那步 ~90s，测试/快速重扫用得着）
const OUT = argVal('out', path.join(dataDir, 'pc-cleanup-scan.json'));
const DRIVES = (argVal('drives', 'C,D,E,F') || 'C,D,E,F')
  .split(',')
  .map((s) => s.trim().toUpperCase().replace(/:$/, ''))
  .filter((s) => /^[A-Z]$/.test(s))
  .map((s) => s + ':');

const startedAt = Date.now();
const deadline = startedAt + MAX_SEC * 1000;
// 进度状态文件：面板上的按钮/进度条读它（一次扫描 4~5 分钟，没有进度用户会以为按钮没反应）。
// 只写两个字段够用的东西，别塞大数组 —— 面板每 2 秒读一次。
const STATE = argVal('state', path.join(dataDir, 'pc-cleanup-scan.state.json'));
const startedIso = new Date().toISOString();
function writeState(patch) {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(Object.assign({ startedAt: startedIso }, patch)), 'utf8');
  } catch { /* 状态写不了不影响扫描本身 */ }
}
// 阶段截止：先给「可清理体检」一块固定预算（缓存不该把整盘扫描的时间吃光），
// 再按「剩余盘数」给每块盘平分剩余时间 —— 否则 C 盘一慢，D 盘直接被跳过。
let phaseDeadline = deadline;
const outOfTime = () => Date.now() > phaseDeadline;

// 扫盘时跳过的系统目录：要么没权限、要么是链接环、要么交给「可清理体检」单独量
const SKIP_DIR = new Set(['$recycle.bin', 'system volume information', 'config.msi', 'documents and settings']);
const MAX_DEPTH = 64;

// ---------- 递归量目录体积（给 junk 用；可中断） ----------
function sizeOf(target) {
  let st;
  try { st = fs.lstatSync(target); } catch { return 0; }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.isFile() ? st.size : 0;
  if (outOfTime()) return 0;
  let ents;
  try { ents = fs.readdirSync(target, { withFileTypes: true }); } catch { return 0; }
  let total = 0;
  for (const e of ents) {
    if (outOfTime()) break;
    const p = path.join(target, e.name);
    try {
      if (e.isDirectory()) total += sizeOf(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch { /* 没权限的跳过，不中断整次扫描 */ }
  }
  return total;
}

// ---------- 整盘走一遍：算每个目录的递归体积，顺手建父子索引 ----------
// onTick(state) 每 ~0.7 秒回调一次，进度条靠它（files/dirs/bytes 是**已经走到的量**，单调递增）
function walkDrive(root, onTick) {
  const sizes = new Map();     // 目录 -> 本目录及以下字节数
  const children = new Map();  // 目录 -> [{ p, bytes }]
  const state = { files: 0, dirs: 0, bytes: 0, truncated: false };
  let lastTick = 0;
  const tick = () => {
    const now = Date.now();
    if (now - lastTick < 700) return;
    lastTick = now;
    if (onTick) { try { onTick(state); } catch { /* 进度写失败不影响扫描 */ } }
  };

  function walk(dir, depth) {
    if (state.truncated) return 0;
    if (outOfTime()) { state.truncated = true; return 0; }
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    let total = 0;
    const kids = [];
    for (const e of ents) {
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) {
          if (SKIP_DIR.has(e.name.toLowerCase())) continue;
          if (depth >= MAX_DEPTH) continue;
          const b = walk(p, depth + 1);
          if (b > 0) kids.push({ p, bytes: b });
          total += b;
        } else if (e.isFile()) {
          const sz = fs.statSync(p).size;
          total += sz; state.bytes += sz; state.files++;
        } else {
          // junction / 符号链接：不跟（跟了会绕圈、也会把同一份数据算两遍）
          const st = fs.lstatSync(p);
          if (st.isFile()) { total += st.size; state.bytes += st.size; state.files++; }
        }
      } catch { /* 单个条目失败不影响整盘 */ }
    }
    state.dirs++;
    sizes.set(dir, total);
    if (kids.length) children.set(dir, kids);
    tick();
    return total;
  }

  walk(root, 0);
  return { sizes, children, state };
}

/**
 * 从一棵已量好的树里挑「大户」：
 * 沿"某个子目录占父目录 75% 以上"的单链往下钻（C:\Users → C:\Users\me → AppData…），
 * 钻到底就报那个最具体的目录，然后**不再进这一枝** ⇒ 榜单里的目录互不包含，体积不会重复计。
 */
function pickTop(scan, root, minBytes, limit) {
  const { sizes, children } = scan;
  const out = [];
  const rep = (dir, size, depth) => {
    let cur = dir, curSize = size, d = depth;
    while (d < depth + 6) {
      const kids = children.get(cur);
      if (!kids || !kids.length) break;
      const top = kids.reduce((a, b) => (b.bytes > a.bytes ? b : a), kids[0]);
      if (top.bytes < curSize * 0.75) break;
      cur = top.p; curSize = top.bytes; d++;
    }
    return { path: cur, bytes: curSize };
  };
  const kids = (children.get(root) || []).slice().sort((a, b) => b.bytes - a.bytes);
  for (const k of kids) {
    if (out.length >= limit) break;
    if (k.bytes < minBytes) continue;
    out.push(rep(k.p, k.bytes, 1));
  }
  return out;
}

// ---------- 可清理体检：只量「删了不会丢数据」的位置 ----------
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const PROGRAMDATA = process.env.ProgramData || 'C:\\ProgramData';
const WINDIR = process.env.SystemRoot || 'C:\\Windows';

// 浏览器缓存：只算 Cache / Code Cache / GPUCache / Service Worker 这些，不碰书签密码
const BROWSER_CACHE_SUBS = ['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache',
  'DawnCache', 'DawnGraphiteCache', 'Service Worker\\CacheStorage', 'Service Worker\\ScriptCache'];

function browserCache(userDataDir) {
  let profiles = [];
  try {
    profiles = fs.readdirSync(userDataDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(userDataDir, e.name));
  } catch { return null; }
  let total = 0, first = null, n = 0;
  for (const p of profiles) {
    for (const sub of BROWSER_CACHE_SUBS) {
      const q = path.join(p, sub);
      const b = sizeOf(q);
      if (b > 0) { total += b; n++; if (!first) first = q; }
      if (outOfTime()) break;
    }
    if (outOfTime()) break;
  }
  return total > 0 ? { total, first, n } : null;
}

function collectJunk() {
  // 每一项先登记、再逐个量；量的时候打印耗时 —— 慢在哪一眼能看出来（缓存类小文件多，最慢）
  const jobs = [];
  const job = (k, note, measure) => jobs.push({ k, note, measure });
  const dirJob = (k, p, note) => job(k, note, () => ({ path: p, bytes: sizeOf(p) }));

  // ① 回收站：常被忽略、量起来也快，放最前
  job('回收站', '清空回收站即可；删前确认里面没有还要找回的文件', () => {
    let total = 0, first = null;
    for (const d of DRIVES) {
      const b = sizeOf(d + '\\$Recycle.Bin');
      total += b;
      if (b > 0 && !first) first = d + '\\$Recycle.Bin';
    }
    return { path: first, bytes: total };
  });

  // ② 临时目录
  dirJob('用户临时文件', os.tmpdir(), '正被程序占用的文件会自动跳过；重启后这里会自己长回来');
  dirJob('Windows 临时', path.join(WINDIR, 'Temp'), '系统临时目录，可整目录清');

  // ③ 浏览器缓存（只算 Cache / Code Cache 这些，不碰书签密码）
  // ⚠ browserCache 返回的是 { total, first, n }，进榜单前要换成 { path, bytes }，字段名对不上会被记成 0
  job('Chrome 缓存', '只含各 Profile 的 Cache / Code Cache，不含书签、密码、历史', () => {
    const c = browserCache(path.join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data'));
    return c ? { path: c.first, bytes: c.total } : null;
  });
  job('Edge 缓存', '只含各 Profile 的 Cache / Code Cache，不含书签、密码、历史', () => {
    const c = browserCache(path.join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'));
    return c ? { path: c.first, bytes: c.total } : null;
  });

  // ④ 杂项缓存
  dirJob('缩略图与图标缓存', path.join(LOCALAPPDATA, 'Microsoft', 'Windows', 'Explorer'), '缩略图数据库，删后自己重建（Explorer 正开着可能删不掉）');
  dirJob('崩溃转储', path.join(LOCALAPPDATA, 'CrashDumps'), '程序崩溃留下的 dump，可删');
  dirJob('npm 缓存', path.join(LOCALAPPDATA, 'npm-cache'), 'npm 的包缓存，删了下次装包会重新下载');
  dirJob('pip 缓存', path.join(LOCALAPPDATA, 'pip', 'Cache'), 'pip 的 wheel 缓存，可删');
  dirJob('预读取 Prefetch', path.join(WINDIR, 'Prefetch'), '删了只会让首次启动慢一点，可删');
  job('Windows 错误报告', '崩溃报告转储，可删', () => ({
    path: path.join(PROGRAMDATA, 'Microsoft', 'Windows', 'WER'),
    bytes: sizeOf(path.join(PROGRAMDATA, 'Microsoft', 'Windows', 'WER'))
      + sizeOf(path.join(LOCALAPPDATA, 'Microsoft', 'Windows', 'WER')),
  }));

  // ⑤ Windows 更新相关（更新缓存常常最大，放后面：前面小项先拿到手）
  dirJob('传递优化缓存',
    path.join(WINDIR, 'ServiceProfiles', 'NetworkService', 'AppData', 'Local', 'Microsoft', 'Windows', 'DeliveryOptimization'),
    'Windows 更新用的 P2P 下载缓存，可删');
  dirJob('Windows 更新缓存', path.join(WINDIR, 'SoftwareDistribution', 'Download'),
    '更新装完后可删；删前先停 wuauserv 与 bits');

  // ⑥ 旧系统
  dirJob('旧系统 Windows.old', 'C:\\Windows.old', '升级前的旧系统备份，整个目录可删（用「磁盘清理」删更稳）');

  const out = [];
  const t0 = Date.now();
  for (const j of jobs) {
    const t = Date.now();
    let r = null;
    try { r = j.measure(); } catch { /* 量不了就跳过 */ }
    const sec = ((Date.now() - t) / 1000).toFixed(1);
    if (!r || !r.path || r.bytes < 1) { console.log(`[junk] ${j.k} 0 · ${sec}s`); continue; }
    const gb = Math.round((r.bytes / GB) * 100) / 100;
    console.log(`[junk] ${j.k} ${gb}GB · ${sec}s${outOfTime() ? ' · 已超时' : ''}`);
    out.push({ k: j.k, path: r.path, gb, note: j.note });
  }
  console.log(`[junk] 量完 ${out.length} 项 · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return out.sort((a, b) => b.gb - a.gb);
}

// ---------- 主流程 ----------
try {
const t0 = Date.now();
writeState({ running: true, phase: 'junk', pct: 0, files: 0, dirs: 0, drive: '', msg: '可清理体检' });
phaseDeadline = Math.min(deadline, startedAt + Math.min(180, Math.max(120, MAX_SEC * 0.3)) * 1000);   // 体检单独给 120~180 秒
const junk = SKIP_JUNK ? [] : collectJunk();
phaseDeadline = deadline;
console.log(`[junk] ${junk.length} 项 · 合计 ${(junk.reduce((a, j) => a + j.gb, 0)).toFixed(2)} GB · ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const items = [];
const byDrive = {};
let partial = false;

const liveDrives = DRIVES.filter((d) => fs.existsSync(d + '\\'));
for (const drive of DRIVES) if (!liveDrives.includes(drive)) console.log(`[skip] ${drive} 不存在`);

for (let i = 0; i < liveDrives.length; i++) {
  const drive = liveDrives[i];
  const root = drive + '\\';
  const rest = liveDrives.length - i;
  const remainMs = deadline - Date.now();
  if (remainMs < 20 * 1000) { partial = true; console.log(`[skip] ${drive} 剩余时间不够，跳过`); continue; }
  phaseDeadline = Date.now() + Math.max(45 * 1000, Math.floor(remainMs / rest));
  const t1 = Date.now();
  // 这块盘"已用多少"：进度百分比的分母（statfs 一下就有，不用再走一遍树）
  let usedBytes = 0;
  try {
    const st = fs.statfsSync(root);
    usedBytes = (Number(st.blocks) - Number(st.bavail)) * Number(st.bsize) || 0;
  } catch (e) { usedBytes = 0; }
  const scan = walkDrive(root, (s) => writeState({
    running: true, phase: 'drive', drive,
    pct: usedBytes ? Math.min(99, Math.round((s.bytes / usedBytes) * 100)) : 0,
    files: s.files, dirs: s.dirs, msg: '扫描 ' + drive,
  }));
  const top = pickTop(scan, root, MIN_GB * GB, 30);
  byDrive[drive] = top.map((x) => ({ path: x.path, gb: Math.round((x.bytes / GB) * 100) / 100 }));
  for (const x of top) items.push({ path: x.path, gb: Math.round((x.bytes / GB) * 100) / 100 });
  if (scan.state.truncated) partial = true;
  console.log(`[drive] ${drive} ${scan.state.files} 文件 / ${scan.state.dirs} 目录 · 入选 ${top.length} · ${((Date.now() - t1) / 1000).toFixed(0)}s${scan.state.truncated ? ' · 超时截断' : ''}`);
}

items.sort((a, b) => b.gb - a.gb);

const payload = {
  scannedAt: new Date().toISOString(),
  tookSec: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
  minGb: MIN_GB,
  partial,
  items: items.slice(0, 40),
  byDrive,
  junk,
  junkTotalGb: Math.round((junk.reduce((a, j) => a + j.gb, 0)) * 100) / 100,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1), 'utf8');
console.log(`[done] 写入 ${OUT}`);
console.log(`[done] items ${payload.items.length} · 分盘 ${Object.keys(byDrive).join('/')} · junk ${junk.length} 项 ${payload.junkTotalGb} GB · 用时 ${payload.tookSec}s${partial ? ' · 结果不完整（超时）' : ''}`);
writeState({
  running: false, ok: true, phase: 'done', pct: 100, msg: '完成',
  finishedAt: new Date().toISOString(), tookSec: payload.tookSec,
  items: payload.items.length, junkTotalGb: payload.junkTotalGb,
});
} catch (e) {
  writeState({ running: false, ok: false, phase: 'fail', finishedAt: new Date().toISOString(), err: String((e && e.message) || e) });
  console.error('[fail] ' + String((e && e.stack) || e));
  process.exitCode = 1;
}
