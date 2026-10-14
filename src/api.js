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
import { MACHINE } from './machine.js';
import { listApiProjects } from './projects.js';
import { milestoneRoadmap } from './roadmap.js';
import { proofStats } from './stats.js';
import { prepareFlowHistory, projectFlowStats } from './stats-flow.js';
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
      requestReceipts: board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('relay_person_requests')?.meta_value ?? null,
      milestones,
      externalMilestones: hasExternalMilestones ? milestoneRoadmap(info.root, board) : null,
    };
  }, isMain);
  const revision = JSON.stringify([
    info.commonDir, id, resolveCommit(info.root, 'HEAD'), files,
    local.event, local.agents, local.leases, local.requestReceipts, local.milestones, local.externalMilestones, store.EVENT_LOG_VERSION,
  ]);
  return { cacheId: info.commonDir + '\0' + id, revision, milestones: local.externalMilestones, cacheable: true };
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
    milestones: milestones ?? store.roadmap(db),
    rowDecisions: store.rowDecisions(db),
    checks: new Map(store.listItems(db, { all: true }).map((item) => store.getItem(db, item.item_id)).map((item) => [item.item_id, {
      check: item.item_check,
      ...(item.item_check_baseline ? { checkBaseline: item.item_check_baseline } : {}),
    }])),
    proofStats: proofStats(db),
    threads: new Map(store.listItems(db, { all: true }).map((item) => [item.item_id, store.itemThread(db, item.item_id)])),
    leases: new Map(store.listItems(db, { all: true }).map((item) => [item.item_id, item.item_lease_until ?? null])),
  }), codeIsMain);
  state.proofStats = projectData.proofStats;
  state.requests = projectData.requests;
  state.personRequests = projectData.personRequests;
  state.milestones = projectData.milestones;
  state.items = state.items.map((item) => ({ ...item, ...projectData.checks.get(item.id) }));
  state = projectRowDecisions(projectData.rowDecisions, state);
  state.items = state.items.map((item) => ({ ...item, thread: projectData.threads.get(item.id) ?? [] }));
  return withListFields(state, projectData.leases);
}

/** What a board-state item summary keeps: what the lists and the roadmap read (A2, N26). */
const SUMMARY_FIELDS = Object.freeze(['id', 'title', 'lane', 'status', 'route', 'milestone', 'specs', 'claim', 'builtBy',
  'blockedBy', 'updatedAt', 'stage', 'since', 'counts', 'verdict']);
const SUMMARY_KEYS = new Set(SUMMARY_FIELDS);
const CLOCK_MOVES = MACHINE.moves.filter((move) => move.by.includes('clock'));

/**
 * Replay an item's recorded events through the declared lifecycle, as the view's timeline does
 * (M1). The board logs a claim on a claimed item as renew, and never the clock's lapse, so a move
 * that cannot start where the replay stands, or a status the history does not reach, puts the
 * lapse in first.
 *
 * @param {{ kind: string, at: string }[]} history
 * @param {string} status
 * @returns {{ from: string, move: object | null, at: string | null }[]}
 */
function lifecycleSteps(history, status) {
  const steps = [];
  let at = MACHINE.initial;
  /** Record where the replay stands and the move it makes, if any, then follow that move. */
  const step = (move, event) => {
    steps.push({ from: at, move, at: event ? event.at : null });
    if (move) at = move.to;
  };
  for (const event of history) {
    const verb = event.kind === 'renew' ? 'claim' : event.kind;
    /** The declared move this event makes from a state; a renew is the claim that stays claimed. */
    const fits = (state) => MACHINE.moves.find((move) => move.verb === verb && move.from.includes(state)
      && (verb !== 'claim' || (event.kind === 'renew') === (move.to === state)));
    const lapse = fits(at) ? null : CLOCK_MOVES.find((move) => move.from.includes(at) && fits(move.to));
    if (lapse) step(lapse, null);
    step(fits(at) || null, event);
  }
  const lapse = at === status ? null : CLOCK_MOVES.find((move) => move.from.includes(at) && move.to === status);
  if (lapse) step(lapse, null);
  return steps;
}

/** When an item arrived in its list stage; edits, review reservations and renewals do not restart it. */
function stageSince(item, steps) {
  if (item.merged) return item.history.findLast((event) => event.kind === 'merged')?.at || item.updatedAt;
  const arrival = steps.findLast((step) => step.move && step.from !== step.move.to);
  // A lapse is inferred, but the claim's own receipt records the deadline that caused it.
  if (arrival?.move?.verb === 'lapse') {
    const claim = item.thread.findLast((entry) => entry.type === 'move' && ['claim', 'renew'].includes(entry.kind));
    if (claim?.detail?.leaseUntil) return claim.detail.leaseUntil;
  }
  return arrival ? arrival.at || item.updatedAt : item.history.find((event) => event.kind === 'add')?.at || item.updatedAt;
}

/**
 * Give every item what its list rows read without its history: its list stage and when it entered
 * it, its roadmap milestone, the live lease on it, and its verdict and fact counts. A recorded merge,
 * not an accept, ends the pipeline. The board's moves are tallied once, keyed from>to:verb as the
 * lifecycle drawing sums them.
 *
 * @param {any} state
 * @param {Map<number, string | null>} leases Each item's recorded claim deadline.
 * @returns {any}
 */
function withListFields(state, leases) {
  const milestones = new Map();
  for (const milestone of state.milestones ?? []) {
    for (const entry of milestone.items) if (typeof entry.id === 'number' && !milestones.has(entry.id)) milestones.set(entry.id, milestone.name);
  }
  const moveCounts = {};
  const items = state.items.map((item) => {
    const steps = lifecycleSteps(item.history, item.status);
    for (const step of steps) {
      const key = step.move && step.from + '>' + step.move.to + ':' + step.move.verb;
      if (key) moveCounts[key] = (moveCounts[key] ?? 0) + 1;
    }
    // Who holds the item under a live lease: its builder while claimed, its reviewer while reserved.
    const claim = item.status === 'claimed' && item.owner ? { by: item.owner, until: leases.get(item.id) ?? null }
      : item.status === 'submitted' && item.reviewer ? { by: item.reviewer, until: item.reviewUntil } : null;
    return { ...item,
      milestone: milestones.get(item.id) ?? null,
      claim,
      stage: item.merged ? 'merged' : item.status === 'verified' ? 'accepted' : item.status,
      since: stageSince(item, steps),
      counts: { verdicts: item.verdicts.length, facts: item.thread.filter((entry) => entry.type === 'fact').length },
    };
  });
  return { ...state, items, moveCounts };
}

/** Keep the summary fields; the latest verdict keeps only its decision and reason. */
function itemSummary(item) {
  const summary = Object.fromEntries(SUMMARY_FIELDS.map((key) => [key, item[key]]));
  summary.verdict = item.verdict && { decision: item.verdict.decision, reason: item.verdict.reason };
  return summary;
}

/** Everything a summary leaves out, with the latest verdict whole: laid over its summary, it is the full item. */
function itemDetail(item) {
  return Object.fromEntries(Object.entries(item).filter(([key]) => key === 'id' || key === 'verdict' || !SUMMARY_KEYS.has(key)));
}

/** The text the view's search matches for an item, lowercased: its #id, title, lane, spec ids and criterion. */
function searchText(item) {
  return ('#' + item.id + ' ' + item.title + ' ' + item.lane + ' ' + item.specs.join(' ') + ' ' + (item.criterion || '')).toLowerCase();
}

/** One cached board build: the full state, its item summaries and the lookups that serve them. */
function snapshotEntry(revision, state, preparedFlow) {
  const summary = { ...state, items: state.items.map(itemSummary) };
  return { revision, state, summary, preparedFlow, summaryFields: prepareStateJson(summary), stateJsonFields: null,
    items: new Map(state.items.map((item) => [item.id, item])), searchTexts: null };
}

/** Add the request-specific unread count without mutating the reusable snapshot. */
function stateForRequest(state, root, seen, preparedFlow, refreshFlow, isMain) {
  const projection = seen === null ? { unseen: null } : withBoard(root, (board) => ({
    unseen: { since: seen, count: board.db.prepare('SELECT COUNT(*) AS n FROM shout WHERE shout_id > ?').get(seen).n },
  }), isMain);
  if (refreshFlow && preparedFlow) {
    projection.proofStats = {
      ...state.proofStats,
      flow: projectFlowStats(preparedFlow, null, Date.now(), state.proofStats),
    };
  }
  return { ...state, ...projection };
}

/** Cache JSON fragments for state fields whose values stay fixed across a cache hit. */
function prepareStateJson(state) {
  const fields = Object.entries(state).map(([key, value]) => {
    if (key === 'unseen') return { dynamic: key };
    if (key === 'proofStats') {
      const stats = Object.entries(value).filter(([name]) => name !== 'flow').map(([name, entry]) => jsonField(name, entry)).filter(Boolean);
      return { dynamic: key, stats };
    }
    return { static: jsonField(key, value) };
  });
  if (!fields.some((field) => field.dynamic === 'unseen')) fields.push({ dynamic: 'unseen' });
  return fields;
}

/** Serialize a state field through JSON.stringify, omitting values JSON would omit. */
function jsonField(key, value) {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? '' : JSON.stringify(key) + ':' + encoded;
}

/** Reuse static state fragments while encoding request-specific unread and flow data. */
function serializeState(state, fields) {
  if (!fields) return JSON.stringify(state);
  const encoded = fields.map((field) => {
    if (field.static !== undefined) return field.static;
    if (field.dynamic === 'unseen') return jsonField('unseen', state.unseen);
    if (field.dynamic === 'proofStats') {
      const flow = jsonField('flow', state.proofStats?.flow);
      return '"proofStats":{' + [...field.stats, flow].filter(Boolean).join(',') + '}';
    }
    return '';
  }).filter(Boolean);
  return '{' + encoded.join(',') + '}';
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
export function createLocalApiHandler({ secret, getPort, runCommand, projects = listApiProjects, isMain, allowedOrigins = [], onStateBuild, stateDetail = 'full' } = {}) {
  if (typeof getPort !== 'function') throw new TypeError('createLocalApiHandler needs a bound-port getter');
  if (typeof runCommand !== 'function') throw new TypeError('createLocalApiHandler needs the actual CLI entry point as runCommand');
  // A page that still reads each item's detail from the state keeps full items until it opts in.
  if (!['full', 'summary'].includes(stateDetail)) throw new TypeError('createLocalApiHandler stateDetail is full or summary');
  const codeIsMain = codeIsFromMain() && isMain !== false;
  const key = Buffer.from(secret);
  const permittedOrigins = new Set(allowedOrigins);
  const stateCache = new Map();
  /**
   * Read the current board build through `read(entry, cached)`, reusing the cached build while every
   * input revision holds before and after the read, and building it again when one moved.
   */
  function withSnapshot(board, read) {
    const before = boardStateRevision(board.root, board.id, codeIsMain);
    const cached = stateCache.get(before.cacheId);
    if (before.cacheable && cached?.revision === before.revision) {
      const result = read(cached, true);
      const after = boardStateRevision(board.root, board.id, codeIsMain);
      if (after.cacheable && after.revision === before.revision) {
        stateCache.delete(before.cacheId);
        stateCache.set(before.cacheId, cached);
        return result;
      }
    }

    onStateBuild?.({ board: board.id });
    const state = buildLocalBoardState(board, codeIsMain, before.milestones);
    const history = withBoard(board.root, (db) => store.events(db), codeIsMain);
    const entry = snapshotEntry(before.revision, state, prepareFlowHistory(history));
    const after = boardStateRevision(board.root, board.id, codeIsMain);
    if (before.cacheable && after.cacheable && before.revision === after.revision) {
      stateCache.set(before.cacheId, entry);
      while (stateCache.size > 32) stateCache.delete(stateCache.keys().next().value);
    } else {
      stateCache.delete(before.cacheId);
    }
    return read(entry, false);
  }
  /** Return item summaries or every item in full, as asked or by this server's default, and the JSON for either. */
  function localState(board, seen, { detail = null } = {}) {
    return withSnapshot(board, (entry, cached) => {
      const full = (detail ?? stateDetail) === 'full';
      const state = stateForRequest(full ? entry.state : entry.summary, board.root, seen, entry.preparedFlow, cached, codeIsMain);
      // Full fragments wait for the first full request, so a server sending summaries never builds them.
      const fields = full ? (entry.stateJsonFields ??= prepareStateJson(entry.state)) : entry.summaryFields;
      return { state, json: serializeState(state, fields) };
    });
  }
  /** One item's detail from the current build, or null when the board has no such item. */
  function localItem(board, id) {
    return withSnapshot(board, (entry) => {
      const item = entry.items.get(id);
      return item ? itemDetail(item) : null;
    });
  }
  /** The ids of the items the view's search would show for this text, in board-state order. */
  function localSearch(board, text) {
    const words = String(text).trim().toLowerCase();
    return withSnapshot(board, (entry) => {
      entry.searchTexts ??= entry.state.items.map((item) => [item.id, searchText(item)]);
      return entry.searchTexts.filter(([, searched]) => !words || searched.includes(words)).map(([id]) => id);
    });
  }
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
    state: (board, who, seen, options) => localState(board, seen, options).state,
    stateJson: (board, who, seen, options) => localState(board, seen, options).json,
    item: (board, id) => localItem(board, id),
    search: (board, text) => localSearch(board, text),
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

/**
 * Serve the RFC 0002 API only on loopback, behind the same session-secret boundary as the view. Its
 * state sends item summaries unless asked for detail=full; each item's detail has its own path (A2).
 */
export function serveApi({ port = 0, secret = randomBytes(18).toString('base64url'), runCommand, projects = listApiProjects, isMain, onStateBuild, stateDetail = 'summary' } = {}) {
  if (typeof runCommand !== 'function') throw new TypeError('serveApi needs the actual CLI entry point as runCommand');
  let bound;
  const handler = createLocalApiHandler({ secret, getPort: () => bound, runCommand, projects, isMain, onStateBuild, stateDetail });
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
