'use strict';
/*
 * GitVisor - 本地自建的类 GitHub 可视化管理界面（零依赖，纯 Node 内置模块）
 * 只监听 127.0.0.1，不对外、不联网、不推送任何远程。
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = __dirname;
let cfgPath = path.join(ROOT, 'config.json');
try { fs.accessSync(cfgPath); } catch { cfgPath = path.join(ROOT, 'config.example.json'); }
const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const PORT = config.port || 4590;
const HOST = config.host || '127.0.0.1';

function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(err); }
      resolve(String(stdout || ''));
    });
  });
}
const git = (cwd, args) => run('git', args, { cwd });

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

async function isBareRepo(p) {
  const st = await fsp.stat(p).catch(() => null);
  if (!st || !st.isDirectory()) return false;
  if (await exists(path.join(p, '.git'))) return false;      // 普通仓库/工作树
  return (await exists(path.join(p, 'HEAD'))) && (await exists(path.join(p, 'objects')));
}
async function isRepoDir(p) {
  const st = await fsp.stat(p).catch(() => null);
  if (!st || !st.isDirectory()) return false;
  if (await exists(path.join(p, '.git'))) return true;
  return isBareRepo(p);
}

/** id -> {id, name, path} */
const repoIndex = new Map();

async function discover() {
  repoIndex.clear();
  const candidates = [];
  const bases = (config.scanDirs || []).map(d => path.isAbsolute(d) ? d : path.join(ROOT, d));
  for (const base of bases) {
    let entries = [];
    try { entries = await fsp.readdir(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(base, e.name);
      if (await isRepoDir(p)) { candidates.push(p); continue; }
      let subs = [];
      try { subs = await fsp.readdir(p, { withFileTypes: true }); } catch {}
      for (const s of subs) {
        if (!s.isDirectory()) continue;
        const sp = path.join(p, s.name);
        if (await isRepoDir(sp)) candidates.push(sp);
      }
    }
  }
  for (const p of config.extraRepos || []) {
    const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
    if (await isRepoDir(abs)) candidates.push(abs);
  }
  for (const p of candidates) {
    const base = path.basename(p).replace(/\.git$/i, '');
    let id = base, n = 2;
    while (repoIndex.has(id)) id = `${base}-${n++}`;
    repoIndex.set(id, { id, name: base, path: p });
  }
  return [...repoIndex.values()];
}

async function parseBranches(repoPath) {
  const raw = await git(repoPath, ['for-each-ref', '--sort=-committerdate',
    '--format=%(refname:short)%1f%(objectname:short)%1f%(committerdate:relative)%1f%(authorname)%1f%(subject)', 'refs/heads']);
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [name, hash, when, author, subject] = line.split('\x1f');
    out.push({ name, hash, when, author, subject });
  }
  return out;
}

async function repoDetail(repo) {
  const bare = await isBareRepo(repo.path);
  let current = null, dirty = false;
  if (!bare) {
    current = (await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    dirty = (await git(repo.path, ['status', '--porcelain'])).trim().length > 0;
  }
  const branches = await parseBranches(repo.path);
  const baseRef = branches.find(b => b.name === 'main') ? 'main'
    : branches.find(b => b.name === 'master') ? 'master'
    : (current && branches.some(b => b.name === current)) ? current
    : (branches[0] ? branches[0].name : null);
  for (const b of branches) {
    b.current = b.name === current;
    b.base = b.name === baseRef;
    if (baseRef && b.name !== baseRef) {
      try {
        const ab = (await git(repo.path, ['rev-list', '--left-right', '--count', `${baseRef}...${b.name}`])).trim().split(/\s+/);
        b.behind = Number(ab[0]); b.ahead = Number(ab[1]);
      } catch { b.ahead = null; b.behind = null; }
      b.merged = await isAncestor(repo.path, b.name, baseRef);
      if (b.merged) {
        try { b.mergeCommit = await findMergeCommit(repo.path, b.name, baseRef); } catch { b.mergeCommit = null; }
      }
    } else { b.ahead = 0; b.behind = 0; b.merged = b.name === baseRef; }
  }
  return { id: repo.id, name: repo.name, path: repo.path, bare, current, baseRef, dirty, branches };
}

async function repoLog(repo, ref, limit = 100) {
  const fmt = '%H%x1f%h%x1f%an%x1f%cr%x1f%D%x1f%s%x1e';
  const out = await git(repo.path, ['log', `--max-count=${limit}`, `--pretty=format:${fmt}`, ref]);
  return out.split('\x1e').map(s => s.trim()).filter(Boolean).map(chunk => {
    const [hash, h, author, when, refs, subject] = chunk.split('\x1f');
    return { hash, short: h, author, when, refs, subject };
  });
}

async function repoDiff(repo, base, head, opts = {}) {
  let stat, diff, commits;
  const merged = !!opts.merged;
  if (merged) {
    const mc = head; // head 此时为 merge 提交
    stat = (await git(repo.path, ['diff', '--stat', '--no-color', `${mc}^1`, mc])).trim();
    diff = await git(repo.path, ['diff', '--no-color', '-U3', `${mc}^1`, mc]);
    const line = (await git(repo.path, ['log', '-1', '--pretty=%H%x1f%h%x1f%an%x1f%cr%x1f%D%x1f%s', mc])).trim();
    const [hash, h, author, when, refs, subject] = line.split('\x1f');
    commits = [{ hash, short: h, author, when, refs, subject }];
  } else {
    stat = (await git(repo.path, ['diff', '--stat', '--no-color', `${base}...${head}`])).trim();
    diff = await git(repo.path, ['diff', '--no-color', '-U3', `${base}...${head}`]);
    commits = await repoLog(repo, `${base}..${head}`, 200);
  }
  return { base, head, stat, diff, commits, merged };
}

async function repoMerge(repo, source, target) {
  if (await isBareRepo(repo.path)) throw new Error('裸仓库不支持合并（没有工作区）。请对普通仓库操作。');
  if (source === target) throw new Error('源分支和目标分支相同');
  const dirty = (await git(repo.path, ['status', '--porcelain'])).trim();
  if (dirty) throw new Error('目标仓库有未提交改动，请先提交或清理后再合并');
  const cur = (await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  await git(repo.path, ['checkout', target]);
  try {
    await git(repo.path, ['merge', '--no-ff', source, '-m', `merge: ${source} → ${target} (GitVisor)`]);
  } catch (e) {
    let conflict = '';
    try { conflict = (await git(repo.path, ['diff', '--name-only', '--diff-filter=U'])).trim().replace(/\n/g, ', '); } catch {}
    try { await git(repo.path, ['merge', '--abort']); } catch {}
    try { await git(repo.path, ['checkout', cur]); } catch {}
    throw new Error(`合并冲突，已自动中止并还原。冲突文件：${conflict || '未知'}`);
  }
  return { ok: true, source, target };
}

async function repoDeleteBranch(repo, name) {
  const cur = (await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (name === cur) throw new Error('不能删除当前所在的分支');
  await git(repo.path, ['branch', '-D', name]);
  return { ok: true, name };
}

// 判断 maybe 是否是 of 的祖先（用于识别“已合并”）
async function isAncestor(repoPath, maybe, of) {
  try { await git(repoPath, ['merge-base', '--is-ancestor', maybe, of]); return true; }
  catch { return false; }
}

// 找到把 branch 合入 base 的那个 merge 提交（基于 --no-ff 合并产生）
async function findMergeCommit(repoPath, branch, base) {
  const merges = (await git(repoPath, ['log', '--merges', '--pretty=%H', base])).split('\n').map(s => s.trim()).filter(Boolean);
  for (const m of merges) {
    const parents = (await git(repoPath, ['rev-list', '--parents', '-n', '1', m])).trim().split(/\s+/);
    for (const p of parents.slice(1)) {
      if (await isAncestor(repoPath, branch, p)) return m;
    }
  }
  return null;
}

// 回退：生成反向提交（--no-ff 合并用 -m 1；普通提交直接 revert）。不动历史，可再次回退。
async function repoRevert(repo, ref, target, mode) {
  if (await isBareRepo(repo.path)) throw new Error('裸仓库不支持回退（没有工作区）');
  const dirty = (await git(repo.path, ['status', '--porcelain'])).trim();
  if (dirty) throw new Error('工作区有未提交改动，请先提交或清理后再回退');
  const cur = (await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  await git(repo.path, ['checkout', target]);
  try {
    // 自动识别 merge 提交：parent ≥ 2 时一律用 -m 1（等价于回退合并）
    const parents = (await git(repo.path, ['rev-list', '--parents', '-n', '1', ref])).trim().split(/\s+/).length - 1;
    if (mode === 'merge' || parents >= 2) await git(repo.path, ['revert', '-m', '1', ref, '--no-edit']);
    else await git(repo.path, ['revert', ref, '--no-edit']);
  } catch (e) {
    let conflict = '';
    try { conflict = (await git(repo.path, ['diff', '--name-only', '--diff-filter=U'])).trim().replace(/\n/g, ', '); } catch {}
    try { await git(repo.path, ['revert', '--abort']); } catch {}
    try { await git(repo.path, ['checkout', cur]); } catch {}
    throw new Error(`回退冲突，已自动中止并还原。冲突文件：${conflict || '未知'}`);
  }
  const newHead = (await git(repo.path, ['rev-parse', 'HEAD'])).trim();
  return { ok: true, revertCommit: newHead, ref, target };
}

// ---------------- HTTP ----------------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', c => d += c); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${HOST}:${PORT}`);
    const p = u.pathname;

    if (p === '/' || p === '/index.html') {
      return send(res, 200, await fsp.readFile(path.join(ROOT, 'public', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }

    if (p === '/api/repos' && req.method === 'GET') {
      const repos = await discover();
      return send(res, 200, { repos: repos.map(r => ({ id: r.id, name: r.name, path: r.path })) });
    }

    const m = p.match(/^\/api\/repo\/([^/]+)(?:\/(.+))?$/);
    if (m) {
      const repo = repoIndex.get(decodeURIComponent(m[1]));
      if (!repo) { await discover(); }
      const r2 = repoIndex.get(decodeURIComponent(m[1]));
      if (!r2) return send(res, 404, { error: 'repo not found' });
      const sub = m[2] || '';

      if (!sub && req.method === 'GET') return send(res, 200, await repoDetail(r2));
      if (sub === 'log' && req.method === 'GET') {
        const ref = u.searchParams.get('ref'); const limit = Number(u.searchParams.get('limit') || 100);
        return send(res, 200, { commits: await repoLog(r2, ref, limit) });
      }
      if (sub === 'diff' && req.method === 'GET') {
        const base = u.searchParams.get('base'); const head = u.searchParams.get('head');
        const merged = u.searchParams.get('merged') === '1';
        if (!base || !head) return send(res, 400, { error: 'base/head required' });
        return send(res, 200, await repoDiff(r2, base, head, { merged }));
      }
      if (sub === 'merge' && req.method === 'POST') {
        const b = await readBody(req);
        return send(res, 200, await repoMerge(r2, b.source, b.target));
      }
      if (sub === 'branch/delete' && req.method === 'POST') {
        const b = await readBody(req);
        return send(res, 200, await repoDeleteBranch(r2, b.name));
      }
      if (sub === 'revert-merge' && req.method === 'POST') {
        const b = await readBody(req);
        const mc = b.mergeCommit || await findMergeCommit(r2.path, b.branch, b.target);
        if (!mc) return send(res, 400, { error: '未找到该分支的合并提交（可能曾用快进合并，无独立合并提交）' });
        return send(res, 200, await repoRevert(r2, mc, b.target, 'merge'));
      }
      if (sub === 'revert-commit' && req.method === 'POST') {
        const b = await readBody(req);
        if (!b.commit) return send(res, 400, { error: 'commit required' });
        return send(res, 200, await repoRevert(r2, b.commit, b.target, 'commit'));
      }
      return send(res, 404, { error: 'not found' });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: String(e && e.message || e) });
  }
});

discover().then(repos => {
  server.listen(PORT, HOST, () => {
    console.log(`GitVisor 已启动: http://${HOST}:${PORT}`);
    console.log(`已发现 ${repos.length} 个仓库: ${repos.map(r => r.id).join(', ') || '(无)'}`);
  });
});
