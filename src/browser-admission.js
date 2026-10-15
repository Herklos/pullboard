/** Classify whether selected tests may launch Chrome; uncertainty keeps browser coverage enabled. */
import { readFile, realpath, stat } from 'node:fs/promises';
import { posix, relative, resolve, sep } from 'node:path';
import { commonJsIn, importsIn } from './module-imports.js';

const MODULE_SUFFIXES = ['.js', '.mjs', '.cjs', '.cts', '.json'];
const CHROME_FIXTURE = 'test/chrome-fixture.js';

/** Convert an in-root absolute or relative selection to a normalized repository-relative path. */
function repositoryPath(root, file) {
  if (typeof file !== 'string' || !file) return null;
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, file);
  const rel = relative(absoluteRoot, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep).join('/');
}

/** Check that a resolved path stays inside the real repository, including through symlinks. */
async function staysInside(root, absolute) {
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(absolute)]);
  return realTarget.startsWith(realRoot + sep);
}

/** Resolve one literal relative module request using file metadata, returning null when ambiguous. */
async function localTarget(root, importer, request) {
  if (typeof request !== 'string' || !request.startsWith('.')) return null;
  const raw = request.split(/[?#]/u)[0];
  const base = posix.normalize(posix.join(posix.dirname(importer), raw));
  if (base === '..' || base.startsWith('../') || base.startsWith('/')) return null;
  const candidates = posix.extname(base)
    ? [base]
    : [base, ...MODULE_SUFFIXES.map((suffix) => base + suffix), ...MODULE_SUFFIXES.map((suffix) => posix.join(base, `index${suffix}`))];
  const found = [];
  for (const candidate of candidates) {
    const absolute = resolve(root, ...candidate.split('/'));
    try {
      if (!(await staysInside(root, absolute))) return null;
      if ((await stat(absolute)).isFile()) found.push(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
  }
  return found.length === 1 ? found[0] : null;
}

/** Return true for full or uncertain selections, cockpit tests, or imports reaching the Chrome fixture. */
export async function testsNeedBrowser(root, files) {
  if (!Array.isArray(files) || files.length === 0) return true;
  const normalized = files.map((file) => repositoryPath(root, file));
  if (normalized.some((file) => file === null)) return true;
  if (normalized.some((file) => file === 'test/cockpit' || file.startsWith('test/cockpit/'))) return true;

  let frontier = [...new Set(normalized)];
  const seen = new Set();
  try {
    while (frontier.length) {
      const paths = [];
      const sources = [];
      for (const path of frontier) {
        if (seen.has(path)) continue;
        seen.add(path);
        if (path === CHROME_FIXTURE) return true;
        if (path.endsWith('.json')) continue;
        if (/\.(?:cjs|cts)$/u.test(path)) return true;
        const absolute = resolve(root, ...path.split('/'));
        if (!(await staysInside(root, absolute))) return true;
        paths.push(path);
        sources.push(await readFile(absolute, 'utf8'));
      }
      if (!sources.length) break;
      if (commonJsIn(sources).some(Boolean)) return true;
      const imports = importsIn(sources);
      const next = new Set();
      for (let index = 0; index < imports.length; index += 1) {
        for (const request of imports[index]) {
          if (request === 'node:module') return true;
          if (request.startsWith('node:')) continue;
          if (!request.startsWith('.')) return true;
          const target = await localTarget(root, paths[index], request);
          if (!target) return true;
          if (target === CHROME_FIXTURE) return true;
          if (!target.endsWith('.json') && !seen.has(target)) next.add(target);
        }
      }
      frontier = [...next];
    }
    return false;
  } catch {
    return true;
  }
}
