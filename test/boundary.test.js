/**
 * The boundary (P5): the core stays free of any particular model, inference engine or model vendor,
 * and of the network. Agents meet it only through the agent contract, so the core never couples to
 * the tools that run models, however useful they are. Agent tools are another matter: helping
 * Claude Code, Codex and others read the repo's rules (AGENTS.md, skills) is the core's job.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODELS = /\b(ollama|mlx|vllm|qwen|llama|mistral|gemma|deepseek|haiku|sonnet|opus|gpt-\d|gemini|openai|anthropic)\b/i;
const NETWORK = /node:(https?|http2|net|dgram|tls)\b|\bfetch\s*\(|\bWebSocket\b/;
const SECRET_LABELS = /\['(Anthropic|OpenAI) key',/;

/**
 * Every source file of the core, with its lines.
 */
function sources() {
  return ['src', 'bin'].flatMap((dir) =>
    readdirSync(join(ROOT, dir)).filter((name) => name.endsWith('.js')).map((name) => ({
      file: `${dir}/${name}`,
      lines: readFileSync(join(ROOT, dir, name), 'utf8').split('\n'),
    })),
  );
}

test('the core names no model, engine or vendor; secret patterns may name the keys they catch [P5]', () => {
  const found = sources().flatMap(({ file, lines }) =>
    lines.flatMap((line, index) => (MODELS.test(line) && !SECRET_LABELS.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
  );
  assert.deepEqual(found, []);
});

test('only explicit relay commands open outbound connections; the view and API stay on loopback [P5, H15, H17, N26, A2]', () => {
  const allowed = (file, line) => file === 'src/relay.js' ||
    (file === 'src/relay-pairing-client.js' && line.trim() === 'response = await fetch(new URL(path, url), {') ||
    (['src/serve.js', 'src/api.js'].includes(file) && line.trim() === "import { createServer } from 'node:http';") ||
    (file === 'src/local-fetch.js' && line.trim() === "import { request as httpRequest } from 'node:http';") ||
    (file === 'src/serve.js' && line.trim() === "const reply = await fetch(address.origin + path, { headers: { 'x-pullboard-key': address.searchParams.get('k') } });") ||
    (file === 'src/view-session.js' && line.trim() === "const response = await fetch(`http://${LOOPBACK}:${view.port}/api/v1/boards?k=${encodeURIComponent(view.secret)}`, {") ||
    (file === 'src/cockpit.js' && /^\s*const res = await fetch\(path, /.test(line));
  const found = sources().flatMap(({ file, lines }) =>
    lines.flatMap((line, index) => (NETWORK.test(line) && !allowed(file, line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
  );
  assert.deepEqual(found, []);
  const localFetchPath = join(ROOT, 'src', 'local-fetch.js');
  const localFetchSource = readFileSync(localFetchPath, 'utf8');
  const httpImport = "import { request as httpRequest } from 'node:http';";
  assert.equal(localFetchSource.split(httpImport).length - 1, 1, 'the local fetch has one exact HTTP request import');
  /** Substitute a synthetic request primitive in a child so production code cannot open a socket. */
  const interceptedSource = localFetchSource.replace(httpImport, `import { EventEmitter } from 'node:events';
const requests = [];
globalThis.__localFetchRequests = requests;
const httpRequest = (url, _options, onResponse) => {
  const target = new URL(url);
  requests.push(target.href);
  const outgoing = new EventEmitter();
  outgoing.end = () => {
    const redirects = target.pathname === '/redirect';
    const incoming = Readable.from([]);
    incoming.statusCode = redirects ? 302 : 200;
    incoming.statusMessage = redirects ? 'Found' : 'OK';
    incoming.rawHeaders = redirects ? ['Location', 'http://outside.invalid/redirected'] : [];
    onResponse(incoming);
  };
  outgoing.destroy = () => {};
  return outgoing;
};`);
  const localFetchModule = `data:text/javascript;base64,${Buffer.from(interceptedSource).toString('base64')}`;
  const childSource = `
import assert from 'node:assert/strict';
const { fetchLocal, isLocalHttp } = await import(${JSON.stringify(localFetchModule)});
const allowed = ['http://127.0.0.1/', 'http://localhost/', 'http://[::1]/'];
for (const address of allowed) assert.equal(isLocalHttp(address), true, address);
const refused = ['http://outside.invalid/', 'http://127.0.0.2/', 'http://[::2]/', 'https://127.0.0.1/', 'ftp://localhost/'];
for (const address of refused) {
  assert.equal(isLocalHttp(address), false, address);
  await assert.rejects(fetchLocal(address), /local fetch requires a loopback HTTP address/);
  assert.deepEqual(globalThis.__localFetchRequests, [], 'a refused address never reaches the request primitive');
}
for (const address of ['http://127.0.0.1:8765/local', 'http://localhost:8765/local', 'http://[::1]:8765/local']) {
  const response = await fetchLocal(address);
  assert.equal(response.status, 200);
  await response.text();
}
assert.deepEqual(globalThis.__localFetchRequests, [
  'http://127.0.0.1:8765/local', 'http://localhost:8765/local', 'http://[::1]:8765/local',
]);
await assert.rejects(fetchLocal('http://127.0.0.1:8765/redirect'), /local fetch requires a loopback HTTP address/);
assert.deepEqual(globalThis.__localFetchRequests, [
  'http://127.0.0.1:8765/local', 'http://localhost:8765/local', 'http://[::1]:8765/local',
  'http://127.0.0.1:8765/redirect',
], 'the redirect target is refused before a second request');
`;
  const proof = spawnSync(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: ROOT, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(proof.error, undefined, `the isolated loopback proof completed: ${proof.error?.message ?? ''}`);
  assert.equal(proof.status, 0, `the isolated loopback proof passed:\n${proof.stderr}\n${proof.stdout}`);
  const serve = readFileSync(join(ROOT, 'src', 'serve.js'), 'utf8');
  assert.match(serve, /export const LOOPBACK = '127\.0\.0\.1';/);
  assert.match(serve, /server\.listen\(port, LOOPBACK, /);
  const viewSession = readFileSync(join(ROOT, 'src', 'view-session.js'), 'utf8');
  assert.match(viewSession, /import \{ LOOPBACK, lastPort \} from '\.\/serve\.js';/);
  assert.match(viewSession, /redirect: 'manual'/, 'the local reuse probe cannot follow a remote redirect');
  const api = readFileSync(join(ROOT, 'src', 'api.js'), 'utf8');
  assert.match(api, /const ADDRESS = '127\.0\.0\.1';/);
  assert.match(api, /server\.listen\(port, ADDRESS, /);
  assert.match(serve, /connect-src 'self'/, "the page may call nothing but its own server");
});
