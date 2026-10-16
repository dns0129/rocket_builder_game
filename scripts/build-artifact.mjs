// 把 vite build 的输出整理成 claude.ai 的 Artifact 网页（用法：npm run artifact）。
// - dist/artifact.html：发布用的页面。平台发布时会自己包上 <!doctype>/<html>/<head>/<body>，
//   所以这里只保留标题、样式表、页面内容和模块脚本。
// - 标准输出：发布时 files 参数要用的映射（网页里的相对路径 -> 本地文件），包括带哈希的脚本、样式、
//   Worker，以及 public/ 里的贴图和电脑演示。
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const DIST = 'dist';
const PAGE = 'artifact.html';

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const title = html.match(/<title>[\s\S]*?<\/title>/)?.[0];
const styles = [...html.matchAll(/<link rel="stylesheet"[^>]*>/g)].map((m) => m[0]);
const scripts = [...html.matchAll(/<script type="module"[^>]*><\/script>/g)].map((m) => m[0]);
const body = html.match(/<body>([\s\S]*?)<\/body>/)?.[1]?.trim();
if (!title || !styles.length || !scripts.length || !body) throw new Error('dist/index.html 的结构和预期不符，先运行 vite build');

writeFileSync(join(DIST, PAGE), [title, ...styles, body, ...scripts].join('\n') + '\n');

const files = {};
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else {
      const rel = relative(DIST, p).split(sep).join('/');
      if (rel !== 'index.html' && rel !== PAGE) files[rel] = p.split(sep).join('/');
    }
  }
};
walk(DIST);
console.log(JSON.stringify({ page: `${DIST}/${PAGE}`, files }, null, 2));
