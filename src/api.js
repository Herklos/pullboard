/** The local API v1: the CLI's moves, persistent board identities and live events (A2). */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { displayAgentName } from './agent-names.js';
import * as store from './board.js';
import { CONFIG_FILE, COORDINATOR, loadConfig } from './config.js';
import { codeIsFromMain, repoInfo, resolveCommit } from './git.js';
import { refusalDocument } from './json.js';
import { relayLinked, relayOperation, relayRevoke, relayTokens } from './relay.js';
import { laneNames } from './lanes.js';
import { listApiProjects } from './projects.js';
import { milestoneRoadmap } from './roadmap.js';
import { proofStats } from './stats.js';
import { flowStats } from './stats-flow.js';
import { projectRowDecisions } from './row-decisions.js';
import { Refused } from './refused.js';
import { codeAt, projectState } from './serve.js';
import { relayPresentationShout } from './relay-presentation.js';
import { createApiHandler } from './api-http.js';
import { moveArgs } from './api-moves.js';
import { personRequestStatuses } from './relay-requests.js';
export { moveArgs } from './api-moves.js';

/** Hash the exact bytes of one state input, preserving a missing-file marker. */
function fileRevision(root, file) {
  const path = join(root, file);
  if (!existsSync(path)) return [file, null];
  return [file, createHash('sha256').update(readFileSync(path)).digest('hex')];
}

/** Capture the inexpensive inputs that can invalidate a complete board-state snapshot. */
function boardStateRevision(root, id, isMain) {
  const info = repoInfo(root);
  const config = loadConfig(info.root);
  const files = [
    fileRevision(info.root, CONFIG_FILE),
    fileRevision(info.root, config.spec),
    fileRevision(info.root, config.practice),
    ['standard-doctrine.md', createHash('sha256').update(readFileSync(new URL('./standard-doctrine.md', import.meta.url))).digest('hex')],
  ];
  const local = withBoard(info.root, (board) => {
    const now = board.clock.now().toISOString();
    const agents = store.listAgents(board);
    const leases = board.db.prepare('SELECT item_id, item_status, item_owner, item_lease_until, item_review_by, item_review_until FROM item ORDER BY item_id').all()
      .map((item) => [
        item.item_id, item.item_status, item.item_owner, item.item_lease_until, item.item_review_by, item.item_review_until,
        item.item_status === 'claimed' && (item.item_lease_until ?? '') > now,
        item.item_status === 'submitted' && Boolean(item.item_review_by) && (item.item_review_until ?? '') > now,
      ]);
    const milestones = store.milestones(board);
    const hasExternalMilestones = milestones.some((milestone) => milestone.items.some((item) => typeof item !== 'number'));
    return {
      event: board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id,
      agents,
      leases,
      milestones: hasExternalMilestones ? milestoneRoadmap(info.root, board) : store.roadmap(board),
    };
  }, isMain);
  const revision = JSON.stringify([
    info.commonDir, id, resolveCommit(info.root, 'HEAD'), files,
    local.event, local.agents, local.leases, local.milestones, store.EVENT_LOG_VERSION,
  ]);
  return { cacheId: info.commonDir + '\0' + id, revision, milestones: local.milestones, cacheable: true };
}

/** Build the complete local API state, including fields that the shared project snapshot omits. */
function buildLocalBoardState(board, codeIsMain, milestones) {
  let state = projectState(board.root, { seen: null, isMain: codeIsMain });
  const config = loadConfig(board.root);
  state.agents = state.agents.map((agent) => ({
    ...agent,
    model: agent.agent_model ?? 'unknown',
    displayName: displayAgentName(agent, config.agents.names),
  }));
  state.board = board.id;
  const projectData = withBoard(board.root, (db) => ({
    requests: store.openRequests(db),
    personRequests: personRequestStatuses(db),
    milestones,
    rowDecisions: store.rowDecisions(db),
    checks: new Map(store.listItems(db, { all: true }).map((item) => store.getItem(db, item.item_id)).map((item) => [item.item_id, {
      check: item.item_check,
      ...(item.item_check_baseline ? { checkBaseline: item.item_check_baseline } : {}),
    }])),
    proofStats: proofStats(db),
    threads: new Map(store.listItems(db, { all: true }).map((item) => [item.item_id, store.itemThread(db, item.item_id)])),
  }), codeIsMain);
  state.proofStats = projectData.proofStats;
  state.requests = projectData.requests;
  state.personRequests = projectData.personRequests;
  state.milestones = projectData.milestones;
  state.items = state.items.map((item) => ({ ...item, ...projectData.checks.get(item.id) }));
  state = projectRowDecisions(projectData.rowDecisions, state);
  state.items = state.items.map((item) => ({ ...item, thread: projectData.threads.get(item.id) ?? [] }));
  return state;
}

/** Add the request-specific unread count without mutating the reusable snapshot. */
function stateForRequest(state, root, seen, history, refreshFlow, isMain) {
  const projection = seen === null ? { unseen: null } : withBoard(root, (board) => ({
    unseen: { since: seen, count: board.db.prepare('SELECT COUNT(*) AS n FROM shout WHERE shout_id > ?').get(seen).n },
  }), isMain);
  if (refreshFlow && history) {
    projection.proofStats = {
      ...state.proofStats,
      flow: flowStats(history, null, Date.now(), state.proofStats),
    };
  }
  return { ...state, ...projection };
}

const ADDRESS = '127.0.0.1';
const VERSION = 1;

/** Read a registered board and release its SQLite connection on every path.
 *
 * @param {string} root
 * @param {(board: any, info: any) => any} read
 * @param {boolean} [isMain] Whether the running CLI code comes from the main checkout.
 */
function withBoard(root, read, isMain) {
  const info = repoInfo(root);
  loadConfig(info.root);
  const board = store.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'), undefined, { isMain: codeIsFromMain() && isMain !== false });
  try { return read(board, info); } finally { store.closeBoard(board); }
}

/** Registered boards carry one persistent identity across local and relay addresses. */
export function apiBoards(projects = listApiProjects, isMain) {
  return projects().flatMap((project) => {
    try { return [withBoard(project.root, (board) => ({ ...project, id: store.boardId(board) }), isMain)]; }
    catch { return []; }
  });
}

/**
 * List readable registered boards and retain actionable warnings for entries that failed to open.
 *
 * @param {() => { root: string, name: string, project: string, added: string }[]} projects
 * @returns {{ boards: object[], warnings: object[] }}
 */
function apiBoardListing(projects = listApiProjects, isMain) {
  const boards = [];
  const warnings = [];
  for (const project of projects()) {
    try {
      boards.push(withBoard(project.root, (board) => ({ ...project, id: store.boardId(board) }), isMain));
    } catch (cause) {
      const error = ['EVENT_LOG_VERSION', 'UNMERGED_SCHEMA'].includes(cause.code) ? cause : new Refused('BOARD_UNAVAILABLE', `registered project ${project.root} cannot be read; restore the repo or run pullboard forget ${project.root}`);
      warnings.push({ ...project, error: refusalDocument(error) });
    }
  }
  return { boards, warnings };
}

/** Resolve only registered boards, so a request cannot open an arbitrary path on the machine. */
function findBoard(id, projects, isMain) {
  const board = apiBoards(projects, isMain).find((entry) => entry.id === id);
  if (!board) throw new Refused('NO_BOARD', `no registered board ${id}; run pullboard serve in its repo and use GET /api/v1/boards`);
  return board;
}

/** Read events in sequence, including changes made by other processes on the same board. */
function afterEvents(root, after, isMain) {
  return withBoard(root, (board) => board.db.prepare('SELECT * FROM event WHERE event_id > ? ORDER BY event_id').all(after), isMain);
}

/** Resolve an authenticated local caller's agent to its own checkout, never another board. */
function agentPath(root, name = COORDINATOR, isMain) {
  if (typeof name !== 'string' || !name) throw new Refused('BAD_REQUEST', 'agent needs a registered name; omit it to act as the coordinator');
  return withBoard(root, (board, info) => {
    if (name === COORDINATOR && !relayLinked(root)) store.ensureCoordinator(board, root);
    const agent = store.listAgents(board).find((entry) => entry.agent_id === name);
    if (!agent) throw new Refused('NO_AGENT', `no registered agent ${name}; use the agents in this board's state or join a worktree first`);
    // A clone shares the coordinator identity, but resolves its main checkout locally.
    if (name === COORDINATOR && relayLinked(root)) return root;
    if (repoInfo(agent.agent_path).commonDir !== info.commonDir) throw new Refused('WRONG_BOARD', `agent ${name}'s worktree belongs to another board; join the agent in this board's worktree`);
    return agent.agent_path;
  }, isMain);
}

/** Execute one actual CLI command and retain its emitted event without a latest-row race. */
export async function executeMove(root, body, runCommand, isMain) {
  if (Object.keys(body).some((key) => !['verb', 'item', 'args', 'agent'].includes(key))) throw new Refused('BAD_REQUEST', 'a move takes only verb, item, args and agent; remove the unknown fields');
  const argv = moveArgs(body);
  let cwd;
  try { cwd = agentPath(root, body.agent, isMain); } catch (error) {
    if (!(error instanceof Refused) || error.code === 'BAD_REQUEST') throw error;
    return { status: error.code === 'WRONG_BOARD' ? 403 : 409, body: refusalDocument(error) };
  }
  let output = '';
  let diagnostics = '';
  const events = [];
  const status = await runCommand(argv, {
    cwd,
    personChannel: 'view',
    stdout: { isTTY: false, write: (text) => { output += text; } },
    stderr: { write: (text) => { diagnostics += text; } },
    onEvent: (row) => { events.push(row); },
  });
  const result = JSON.parse(output);
  if (status) return { status: 409, body: result };
  if (body.verb === 'next' && result.offer) return { status: 200, body: { version: VERSION, event: null, result, offer: result.offer } };
  const kind = body.verb === 'verify' ? body.args?.decision
    : body.verb === 'done' ? 'submit'
    : body.verb === 'hold' && body.args?.off ? 'unhold' : body.verb;
  const event = events.find((row) => row.event_kind === kind) ?? events.at(-1);
  if (!event) throw new Error(`move ${body.verb} produced no event${diagnostics ? `: ${diagnostics}` : ''}`);
  return { status: 200, body: { version: VERSION, event, result } };
}

/** Create a person's coordinator request through the same shout transaction as the CLI. */
async function createRequest(root, body, isMain) {
  if (typeof body.text !== 'string' || !body.text.trim() || Object.keys(body).some((key) => key !== 'text')) throw new Refused('BAD_REQUEST', 'a request needs {text: "what the coordinator should do"}');
  const message = { from: 'person', to: COORDINATOR, text: body.text, request: true, lanes: laneNames(loadConfig(root)) };
  if (relayLinked(root)) {
    const id = await relayOperation(root, 'shout', [message], { err: () => {} });
    return withBoard(root, (board) => ({ version: VERSION,
      event: store.events(board).find((event) => JSON.parse(event.event_detail).shout === id),
      result: { id, request: true } }), isMain);
  }
  return withBoard(root, (board) => {
    const id = store.shout(board, message);
    return { version: VERSION, event: board.lastEvent, result: { id, request: true } };
  }, isMain);
}

/** Create the authenticated local adapter used by the HTTP server and other local transports. */
export function createLocalApiHandler({ secret, getPort, runCommand, projects = listApiProjects, isMain, allowedOrigins = [], onStateBuild } = {}) {
  if (typeof getPort !== 'function') throw new TypeError('createLocalApiHandler needs a bound-port getter');
  if (typeof runCommand !== 'function') throw new TypeError('createLocalApiHandler needs the actual CLI entry point as runCommand');
  const codeIsMain = codeIsFromMain() && isMain !== false;
  const key = Buffer.from(secret);
  const permittedOrigins = new Set(allowedOrigins);
  const stateCache = new Map();
  return createApiHandler({
    authenticate: (req) => {
      const url = new URL(req.url ?? '/', 'http://' + ADDRESS);
      const authorization = String(req.headers.authorization ?? '');
      const given = Buffer.from(String(req.headers['x-pullboard-key'] ?? (authorization.startsWith('Bearer ') ? authorization.slice(7) : url.searchParams.get('k') ?? '')));
      const bound = getPort();
      const ownHost = req.headers.host === ADDRESS + ':' + bound || req.headers.host === 'localhost:' + bound;
      if (!ownHost || given.length !== key.length || !timingSafeEqual(given, key)) throw new Refused('AUTH_REQUIRED', 'this API needs its session secret and own host; use the address pullboard serve printed');
      if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host && !permittedOrigins.has(req.headers.origin)) throw new Refused('API_ORIGIN', 'use the API from its own origin');
      return { local: true };
    },
    boards: () => apiBoardListing(projects, codeIsMain),
    board: (id) => findBoard(id, projects, codeIsMain),
    state: (board, who, seen) => {
      const before = boardStateRevision(board.root, board.id, codeIsMain);
      const cached = stateCache.get(before.cacheId);
      if (before.cacheable && cached?.revision === before.revision) {
        const afterProjection = stateForRequest(cached.state, board.root, seen, cached.history, true, codeIsMain);
        const after = boardStateRevision(board.root, board.id, codeIsMain);
        if (after.cacheable && after.revision === before.revision) {
          stateCache.delete(before.cacheId);
          stateCache.set(before.cacheId, cached);
          return afterProjection;
        }
      }

      onStateBuild?.({ board: board.id });
      const state = buildLocalBoardState(board, codeIsMain, before.milestones);
      const history = withBoard(board.root, (db) => store.events(db), codeIsMain);
      const after = boardStateRevision(board.root, board.id, codeIsMain);
      if (before.cacheable && after.cacheable && before.revision === after.revision) {
        stateCache.set(before.cacheId, { revision: before.revision, state, history });
        while (stateCache.size > 32) stateCache.delete(stateCache.keys().next().value);
      } else {
        stateCache.delete(before.cacheId);
      }
      return stateForRequest(state, board.root, seen, null, false, codeIsMain);
    },
    shout: (board, id) => relayLinked(board.root)
      ? relayPresentationShout(board.root, id)
      : withBoard(board.root, (db) => store.shoutDetails(db, id), codeIsMain),
    code: (board, ref) => codeAt(board.root, ref),
    events: (board, after) => afterEvents(board.root, after, codeIsMain),
    eventLogVersion: () => store.EVENT_LOG_VERSION,
    move: (board, body) => executeMove(board.root, body, runCommand, codeIsMain),
    request: (board, body) => createRequest(board.root, body, codeIsMain),
    tokens: async (board) => (await relayTokens(board.root, { err() {} })).tokens,
    revokeToken: (board, id) => relayRevoke(board.root, id, { personChannel: 'view', say() {}, err() {} }),
  });
}

/** Serve the RFC 0002 API only on loopback, behind the same session-secret boundary as the view. */
export function serveApi({ port = 0, secret = randomBytes(18).toString('base64url'), runCommand, projects = listApiProjects, isMain, onStateBuild } = {}) {
  if (typeof runCommand !== 'function') throw new TypeError('serveApi needs the actual CLI entry point as runCommand');
  let bound;
  const handler = createLocalApiHandler({ secret, getPort: () => bound, runCommand, projects, isMain, onStateBuild });
  const server = createServer(handler);
  server.requestTimeout = 15_000;
  return new Promise((ready, fail) => {
    server.once('error', (error) => fail(new Refused(error.code === 'EADDRINUSE' ? 'PORT_BUSY' : 'API_LISTEN', `cannot listen on ${ADDRESS}:${port}: ${error.message}; run pullboard serve --port 0 to choose a free port`)));
    server.listen(port, ADDRESS, () => {
      bound = server.address().port;
      ready({
        url: `http://${ADDRESS}:${bound}/api/v1/boards?k=${secret}`,
        port: bound,
        close: () => new Promise((closed) => { handler.close(); server.close(() => closed()); server.closeIdleConnections(); }),
      });
    });
  });
}
