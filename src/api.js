/** The local API v1: the CLI's moves, persistent board identities and live events (A2). */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { displayAgentName } from './agent-names.js';
import * as store from './board.js';
import { CONFIG_FILE, COORDINATOR, loadConfig } from './config.js';
import { codeIsFromMain, repoInfo, resolveCommit } from './git.js';
import { refusalDocument } from './json.js';
import { relayLinked, relayOperation, relayRevoke, relayTokens } from './relay.js';
import { laneNames } from './lanes.js';
import { listApiProjects, registryFile } from './projects.js';
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

/** Inputs shared by the complete state cache and the lightweight live-change watcher. */
const STATE_REVISION_INPUTS = Object.freeze([
  'identity', 'head', 'files', 'event', 'agents', 'leases', 'requestReceipts', 'milestones', 'externalRoadmap', 'eventLogVersion',
]);

/** Serialize named state inputs in one stable order for cache and stream comparisons. */
function stateRevision(inputs) {
  return JSON.stringify(STATE_REVISION_INPUTS.map((name) => [name, inputs[name]]));
}

/** Name project and built-in files separately, even when their basenames collide. */
function stateFileInputs(root, config) {
  return [
    { name: `config:${CONFIG_FILE}`, path: join(root, CONFIG_FILE) },
    { name: `spec:${config.spec}`, path: join(root, config.spec) },
    { name: `practice:${config.practice}`, path: join(root, config.practice) },
    { name: 'builtin:standard-doctrine.md', path: new URL('./standard-doctrine.md', import.meta.url) },
  ];
}

/** Hash the exact bytes of one named input, preserving a missing-file marker. */
function fileRevision(file) {
  if (!existsSync(file.path)) return [file.name, null];
  return [file.name, createHash('sha256').update(readFileSync(file.path)).digest('hex')];
}

/**
 * Read this board's own revision inputs from one open connection, for the cache and the watcher alike.
 * nextExpiry is the earliest live claim or review lease, when a lease turns over with no write.
 */
function localRevisionInputs(board, now) {
  const leases = board.db.prepare('SELECT item_id, item_status, item_owner, item_lease_until, item_review_by, item_review_until FROM item ORDER BY item_id').all()
    .map((item) => [
      item.item_id, item.item_status, item.item_owner, item.item_lease_until, item.item_review_by, item.item_review_until,
      item.item_status === 'claimed' && (item.item_lease_until ?? '') > now,
      item.item_status === 'submitted' && Boolean(item.item_review_by) && (item.item_review_until ?? '') > now,
    ]);
  const expiries = leases.flatMap(([, , , leaseUntil, , reviewUntil, claimLive, reviewLive]) => [claimLive ? leaseUntil : null, reviewLive ? reviewUntil : null]);
  return {
    event: board.db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM event').get().id,
    agents: store.listAgents(board),
    leases,
    requestReceipts: board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('relay_person_requests')?.meta_value ?? null,
    milestones: store.milestones(board),
    nextExpiry: expiries.filter(Boolean).sort()[0] ?? null,
  };
}

/** Capture the inexpensive inputs that can invalidate a complete board-state snapshot. */
function boardStateRevision(root, id, isMain) {
  const info = repoInfo(root);
  const config = loadConfig(info.root);
  const files = stateFileInputs(info.root, config).map(fileRevision);
  const local = withBoard(info.root, (board) => {
    const inputs = localRevisionInputs(board, board.clock.now().toISOString());
    const hasExternalMilestones = inputs.milestones.some((milestone) => milestone.items.some((item) => typeof item !== 'number'));
    return { ...inputs, externalMilestones: hasExternalMilestones ? milestoneRoadmap(info.root, board) : null };
  }, isMain);
  const revision = stateRevision({
    identity: [info.commonDir, id],
    head: resolveCommit(info.root, 'HEAD'),
    files,
    event: local.event,
    agents: local.agents,
    leases: local.leases,
    requestReceipts: local.requestReceipts,
    milestones: local.milestones,
    externalRoadmap: local.externalMilestones,
    eventLogVersion: store.EVENT_LOG_VERSION,
  });
  return { cacheId: info.commonDir + '\0' + id, revision, milestones: local.externalMilestones, cacheable: true };
}

/** Cheap file identity for an event-stream poll; content is read only after this marker changes. */
function fileMarker(file) {
  try {
    const stat = statSync(file.path);
    return [file.name, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [file.name, null];
    throw error;
  }
}

/** Capture a marker for a single absolute path, including an explicit missing-file value. */
function fileMarkerForPath(path) {
  try {
    const stat = statSync(path);
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'missing';
    throw error;
  }
}

/** Read HEAD and its selected ref without spawning Git on every 200 ms poll. */
function headFileRevision(info) {
  const head = readFileSync(join(info.gitDir, 'HEAD'), 'utf8').trim();
  if (/^[0-9a-f]{40,64}$/iu.test(head)) return head.toLowerCase();
  const symbolic = /^ref: (.+)$/.exec(head);
  if (!symbolic) return head;
  const ref = symbolic[1];
  try { return readFileSync(join(info.commonDir, ref), 'utf8').trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    let packed;
    try { packed = readFileSync(join(info.commonDir, 'packed-refs'), 'utf8'); }
    catch (packedError) {
      if (packedError.code === 'ENOENT') return head;
      throw packedError;
    }
    return packed.split('\n').find((line) => line.endsWith(' ' + ref))?.split(' ')[0] ?? head;
  }
}

/**
 * Read the machine registry that milestoneRoadmap resolves against, without listApiProjects' pruning
 * or metadata writes: a poll must not rewrite the registry it watches.
 */
function registeredProjects() {
  try {
    const value = JSON.parse(readFileSync(registryFile(), 'utf8'));
    if (!Array.isArray(value.projects)) return [];
    return value.projects.filter((project) => typeof project?.root === 'string').map((project) => ({
      ...project,
      root: resolve(project.root),
      name: project.name ?? basename(project.root),
    }));
  } catch {
    return [];
  }
}

/** Open only boards named by this board's external milestone references. */
function openRoadmapInputs(root, milestones, localDb) {
  const references = milestones.flatMap((milestone) => milestone.items.filter((item) => typeof item !== 'number'));
  const registered = references.length ? registeredProjects() : [];
  const opened = new Map();
  const pathMarkers = new Map();
  const watchPath = (path) => {
    if (!pathMarkers.has(path)) pathMarkers.set(path, fileMarkerForPath(path));
  };
  let inputs;
  try {
    inputs = references.map((reference) => {
      const match = /^(.+)#([1-9]\d*)$/.exec(reference);
      if (!match) return { reference, unavailable: true };
      const [, repo, number] = match;
      const candidates = registered.filter((project) => project.name === repo || basename(project.root) === repo);
      for (const candidate of candidates) {
        watchPath(candidate.root);
        watchPath(join(candidate.root, '.git'));
      }
      if (candidates.length !== 1) return { reference, unavailable: true };
      try {
        const info = repoInfo(candidates[0].root);
        const path = join(info.commonDir, 'pullboard', 'board.sqlite');
        watchPath(path);
        const db = resolve(candidates[0].root) === resolve(root) ? localDb : (opened.get(path) ?? store.openBoardReadOnly(path));
        if (db !== localDb) opened.set(path, db);
        return { reference, id: Number(number), db, path };
      } catch {
        return { reference, unavailable: true };
      }
    });
  } catch (error) {
    for (const db of opened.values()) {
      try { db.close(); } catch {}
    }
    throw error;
  }
  return {
    inputs,
    close() {
      for (const db of opened.values()) {
        try { db.close(); } catch {}
      }
    },
    needsRefresh() {
      for (const [path, marker] of pathMarkers) if (fileMarkerForPath(path) !== marker) return true;
      return false;
    },
    revision(now) {
      const values = [];
      let nextExpiry = null;
      for (const input of inputs) {
        if (input.unavailable) { values.push([input.reference, 'unavailable']); continue; }
        const item = input.db.prepare('SELECT item_title, item_status, item_lease_until FROM item WHERE item_id = ?').get(input.id);
        if (!item) { values.push([input.reference, 'missing']); continue; }
        const status = item.item_status === 'claimed' && (item.item_lease_until ?? '') <= now ? 'open' : item.item_status;
        if (item.item_status === 'claimed' && item.item_lease_until > now && (!nextExpiry || item.item_lease_until < nextExpiry)) nextExpiry = item.item_lease_until;
        values.push([input.reference, item.item_title, status]);
      }
      return { values, nextExpiry };
    },
  };
}

/** Watch the same named state inputs as the cache without rebuilding a board-state response. */
function watchLocalStateRevision(board) {
  const info = repoInfo(board.root);
  const config = loadConfig(info.root);
  let files = stateFileInputs(info.root, config);
  const dbPath = join(info.commonDir, 'pullboard', 'board.sqlite');
  let db = store.openBoardReadOnly(dbPath);
  let closed = false;
  let dbMarker;
  let fileMarkers;
  let fileContent;
  let head;
  let dataVersion;
  let local = null;
  let external = null;
  let externalVersion = new Map();
  let externalValues = null;
  let externalNextExpiry = null;
  let externalReferences = null;
  let registryMarker = null;

  try {
    dbMarker = fileMarkerForPath(dbPath);
    fileMarkers = files.map(fileMarker);
    fileContent = files.map(fileRevision);
    head = headFileRevision(info);
    dataVersion = db.prepare('PRAGMA data_version').get().data_version;
  } catch (error) {
    db.close();
    throw error;
  }

  /** Refresh related external board reads only after their retained connection reports a commit. */
  function externalInputs(now, milestoneDefinitions, localChanged) {
    const references = milestoneDefinitions.flatMap((milestone) => milestone.items.filter((item) => typeof item !== 'number'));
    const currentRegistryMarker = fileMarkerForPath(registryFile());
    const registryChanged = registryMarker !== currentRegistryMarker;
    if (!external || JSON.stringify(externalReferences) !== JSON.stringify(references) || registryChanged || external.needsRefresh()) {
      external?.close();
      external = openRoadmapInputs(info.root, milestoneDefinitions, db);
      externalVersion = new Map();
      externalValues = null;
      externalNextExpiry = null;
      externalReferences = references;
      registryMarker = currentRegistryMarker;
    }
    let changed = false;
    for (const input of external.inputs) {
      if (!input.unavailable && input.db !== db) {
        // Keep the version observed before row reads. A commit during revision() is then
        // detected on the next poll instead of pairing old rows with a newer version.
        const value = input.db.prepare('PRAGMA data_version').get().data_version;
        const key = input.db;
        if (externalVersion.has(key) && externalVersion.get(key) !== value) changed = true;
        externalVersion.set(key, value);
      }
    }
    if (changed || localChanged || !externalValues || (externalNextExpiry && externalNextExpiry <= now)) {
      const current = external.revision(now);
      externalValues = current.values;
      externalNextExpiry = current.nextExpiry;
    }
    return externalValues;
  }

  /** Return the current cheap revision, updating heavier SQL projections only when needed. */
  function revision() {
    if (closed) throw new Error('the event-stream revision watcher is closed');
    const latestDbMarker = fileMarkerForPath(dbPath);
    if (latestDbMarker !== dbMarker) {
      const replacement = store.openBoardReadOnly(dbPath);
      const replacementVersion = replacement.prepare('PRAGMA data_version').get().data_version;
      external?.close();
      external = null;
      db.close();
      db = replacement;
      dbMarker = latestDbMarker;
      dataVersion = replacementVersion;
      local = null;
      externalValues = null;
      externalVersion = new Map();
    }
    const currentMarkers = files.map(fileMarker);
    if (JSON.stringify(currentMarkers) !== JSON.stringify(fileMarkers)) {
      const latestConfig = loadConfig(info.root);
      files = stateFileInputs(info.root, latestConfig);
      fileMarkers = files.map(fileMarker);
      fileContent = files.map(fileRevision);
    }
    const latestHead = headFileRevision(info);
    const latestDataVersion = db.prepare('PRAGMA data_version').get().data_version;
    const now = new Date().toISOString();
    const localChanged = latestDataVersion !== dataVersion;
    const localExpiryChanged = Boolean(local?.nextExpiry && local.nextExpiry <= now);
    if (!local || localChanged || localExpiryChanged) {
      local = localRevisionInputs({ db, clock: store.systemClock }, now);
      dataVersion = latestDataVersion;
    }
    head = latestHead;
    const externalRoadmap = externalInputs(now, local.milestones, localChanged || localExpiryChanged);
    return stateRevision({
      identity: [info.commonDir, board.id],
      head,
      files: fileContent,
      event: local.event,
      agents: local.agents,
      leases: local.leases,
      requestReceipts: local.requestReceipts,
      milestones: local.milestones,
      externalRoadmap,
      eventLogVersion: store.EVENT_LOG_VERSION,
    });
  }

  return {
    revision,
    close() {
      if (closed) return;
      closed = true;
      try { external?.close(); } finally { db.close(); }
    },
  };
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
export function createLocalApiHandler({ secret, getPort, runCommand, projects = listApiProjects, isMain, allowedOrigins = [], onStateBuild } = {}) {
  if (typeof getPort !== 'function') throw new TypeError('createLocalApiHandler needs a bound-port getter');
  if (typeof runCommand !== 'function') throw new TypeError('createLocalApiHandler needs the actual CLI entry point as runCommand');
  const codeIsMain = codeIsFromMain() && isMain !== false;
  const key = Buffer.from(secret);
  const permittedOrigins = new Set(allowedOrigins);
  const stateCache = new Map();
  /** Return the current state and its cached-static JSON representation under revision checks. */
  function localState(board, seen) {
    const before = boardStateRevision(board.root, board.id, codeIsMain);
    const cached = stateCache.get(before.cacheId);
    if (before.cacheable && cached?.revision === before.revision) {
      const state = stateForRequest(cached.state, board.root, seen, cached.preparedFlow, true, codeIsMain);
      const after = boardStateRevision(board.root, board.id, codeIsMain);
      if (after.cacheable && after.revision === before.revision) {
        stateCache.delete(before.cacheId);
        stateCache.set(before.cacheId, cached);
        return { state, json: serializeState(state, cached.stateJsonFields) };
      }
    }

    onStateBuild?.({ board: board.id });
    const state = buildLocalBoardState(board, codeIsMain, before.milestones);
    const history = withBoard(board.root, (db) => store.events(db), codeIsMain);
    const preparedFlow = prepareFlowHistory(history);
    const after = boardStateRevision(board.root, board.id, codeIsMain);
    const stateJsonFields = prepareStateJson(state);
    if (before.cacheable && after.cacheable && before.revision === after.revision) {
      const entry = { revision: before.revision, state, preparedFlow, stateJsonFields };
      stateCache.set(before.cacheId, entry);
      while (stateCache.size > 32) stateCache.delete(stateCache.keys().next().value);
    } else {
      stateCache.delete(before.cacheId);
    }
    const projected = stateForRequest(state, board.root, seen, null, false, codeIsMain);
    return { state: projected, json: serializeState(projected, stateJsonFields) };
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
    state: (board, who, seen) => localState(board, seen).state,
    stateJson: (board, who, seen) => localState(board, seen).json,
    watchRevision: (board) => watchLocalStateRevision(board),
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
