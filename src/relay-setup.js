/** Set up a machine once, enroll its phone in the foreground and link later registrations [H5,H17]. */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as store from './board.js';
import { phoneProposal, publishPhoneApproval, warnPhoneApproval } from './relay-phone.js';
import { openApproval, restoreLinkReply } from './relay-approval.js';
import { requirePersonChannel } from './person.js';
import { codeIsFromMain, repoInfo } from './git.js';
import { listApiProjects } from './projects.js';
import { acceptDeviceEnrollment, beginDeviceEnrollment, readRelayMachine, relayMachineOwner, updateRelayMachine } from './relay-machine.js';
import { deliverDeviceWraps, relayDeviceRequest, relayMachineSignIn, relayMachineContext, relayRevokeDevice, relayOn, relayStatus, originRepository, revokeRelayPersonSession } from './relay.js';
import { terminalQr } from './qr.js';
import { Refused } from './refused.js';

/** Return local opt-in gaps without contacting the relay or renewing a person session. */
export function unlinkedRelayProjects() {
  const machine = readRelayMachine();
  if (!machine.autoLink) return [];
  return listApiProjects().filter(project => !machine.excluded.includes(project.root)).flatMap(project => {
    try { if (relayStatus(project.root).linked) return []; } catch { /* Preserve the registered project as a named finding. */ }
    const pending = machine.approvals.find(entry => entry.root === project.root);
    return [{ code: pending ? 'PHONE_APPROVAL_PENDING' : 'RELAY_NOT_LINKED', message: pending ? 'waiting for phone approval: ' + project.name + '; expires ' + new Date(pending.context.expires).toISOString() : 'not linked: ' + project.name + '; run pullboard relay on --all', next: pending && Date.now() < pending.context.expires ? 'Approve the named link on your paired phone.' : 'pullboard relay on --all' }];
  });
}

/** Read the registered local board identity without executing any person action. */
function projectBoard(root) {
  const board = store.openBoard(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite'), undefined, { isMain: codeIsFromMain() });
  try { return store.boardId(board); } finally { store.closeBoard(board); }
}

/** Link a new project only after the paired phone explicitly approves its one durable proposal. */
export async function autoLinkProject(root, io) {
  const machine = readRelayMachine();
  if (!machine.autoLink) return;
  const project = repoInfo(root).root;
  if (machine.excluded.includes(project) || relayStatus(project).linked) return;
  const name = listApiProjects().find(entry => entry.root === project)?.name ?? project;
  let pending = machine.approvals.find(entry => entry.root === project);
  try {
    if (pending && Date.now() >= pending.context.expires) throw new Refused('PHONE_APPROVAL_EXPIRED', 'Link approval expired; run pullboard relay on --all explicitly to link this project.');
    let source;
    if (pending) source = relayMachineContext(pending.publisherRoot);
    else {
      const candidate = listApiProjects().map(entry => ({ ...entry, state: relayMachineContext(entry.root) }))
        .find(entry => entry.state?.token?.startsWith('pm_') && entry.state.account === machine.owner?.account && entry.state.url === machine.owner?.url);
      if (!candidate) throw new Refused('RELAY_SESSION', 'Run pullboard relay on --all to link this project and pair the phone.');
      source = candidate.state;
      const proposal = await phoneProposal(source, 'link', originRepository(project),
        { board: projectBoard(project), command: 'Link ' + name + '? (pullboard init)', link: true });
      const value = { root: project, publisherRoot: candidate.root, context: proposal.context, sealed: proposal.sealed, replyKey: proposal.reply.storedKey, published: false };
      pending = updateRelayMachine(state => {
        const existing = state.approvals.find(entry => entry.root === project);
        if (existing) return existing;
        state.approvals.push(value); return value;
      });
      source = relayMachineContext(pending.publisherRoot);
    }
    if (!source?.token?.startsWith('pm_')) throw new Refused('RELAY_SESSION', 'Restore the publishing board link or run pullboard relay on --all.');
    if (!pending.published) {
      await publishPhoneApproval(source, pending, io, relayDeviceRequest);
      updateRelayMachine(state => { const entry = state.approvals.find(value => value.context.id === pending.context.id); if (entry) entry.published = true; });
    }
    const document = await relayDeviceRequest(source, '/api/v1/devices/approvals/' + pending.context.id, {}, io);
    if (document.approval.state !== 'approved') {
      io.err('waiting for phone approval: ' + name + '; expires ' + new Date(pending.context.expires).toISOString() + '; local work continues.'); return;
    }
    const privateKey = await restoreLinkReply(pending.replyKey);
    const result = await openApproval(privateKey, JSON.parse(Buffer.from(document.approval.response, 'base64url').toString('utf8')), pending.context, 'reply');
    const credential = { ...result.credential, account: pending.context.account, url: source.url };
    await relayOn(project, source.url, io, { credential, quiet: true, strict: true });
    updateRelayMachine(state => { state.approvals = state.approvals.filter(entry => entry.context.id !== pending.context.id); });
  } catch (error) {
    if (pending) {
      warnPhoneApproval(pending, error, io, 'Local registration is complete; run pullboard relay on --all explicitly to link this project.');
      return;
    }
    io.err('not linked: ' + name + '; ' + (error instanceof Refused ? error.message : 'Restore the pending phone approval or run pullboard relay on --all.'));
  }
}

/** Retry only old deletion intents during an explicit foreground sign-in; never retain that session. */
async function flushRevocations(session, io) {
  for (const intent of readRelayMachine().revocations) {
    if (session.account !== intent.account || session.url !== intent.url) continue;
    await relayDeviceRequest(session, '/api/v1/devices/' + intent.deviceId, { method: 'DELETE' }, io);
    updateRelayMachine(state => { state.revocations = state.revocations.filter(entry => entry.deviceId !== intent.deviceId); });
  }
}

/** The native device revocation uses the same one-tap grant path as token revocation. */
export async function revokeRelayDevice(deviceId, io) {
  requirePersonChannel(io.personChannel);
  const device = readRelayMachine().devices.find(entry => entry.deviceId === deviceId);
  if (!device) throw new Refused('DEVICE_NOT_ENROLLED', 'Name a paired device from pullboard relay devices.');
  const roots = [io.cwd, ...listApiProjects().map(entry => entry.root)];
  for (const root of roots) {
    let state;
    try { state = relayMachineContext(root); } catch { continue; }
    if (state?.token?.startsWith('pm_') && state.account === device.account && state.url === device.url) return relayRevokeDevice(root, deviceId, io);
  }
  throw new Refused('RELAY_NOT_LINKED', 'Link a board and pair the phone with pullboard relay on --all.');
}

/** Link every non-excluded registry entry, collecting project-specific partial failures. */
async function linkProjects(session, io, { onBoardOutcome } = {}) {
  const machine = readRelayMachine();
  const linked = [];
  const failed = [];
  for (const project of listApiProjects()) {
    if (machine.excluded.includes(project.root)) continue;
    try {
      const result = await relayOn(project.root, session.url, io, { session, quiet: true, strict: true });
      linked.push({ project: project.name, root: project.root, board: result.board });
      onBoardOutcome?.({ root: project.root, name: project.name, outcome: 'linked', reason: '' });
      io.say(`linked: ${project.name}`);
    } catch (error) {
      const reason = error instanceof Refused ? error.message : 'Restore this registered project and retry.';
      failed.push({ project: project.name, root: project.root, reason });
      onBoardOutcome?.({ root: project.root, name: project.name, outcome: 'failed', reason });
      io.err(`not linked: ${project.name}; ${reason}`);
    }
  }
  return { linked, failed };
}

/** Wait for the next pairing poll or an abort without leaving an abort listener behind. */
function waitForPairingPoll(signal) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, 500);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Publish a one-use locator and wait in this command; cancellation never undoes linked boards. */
async function pairFirstDevice(session, board, linked, io, { signal, onPairingURL } = {}) {
  if (signal?.aborted) {
    io.say('Boards linked; phone pairing cancelled. Run pullboard relay on --all for a fresh code.');
    return { paired: false, interrupted: false, pairingOutcome: 'cancelled', pairingCleanup: 'not-published' };
  }
  const pending = beginDeviceEnrollment(board, session);
  const path = '/api/v1/devices/enrollments/' + pending.locator;
  const link = session.url + '/#device=' + pending.locator + '.' + pending.secret;
  let interrupted = false;
  let pairingOutcome = 'expired';
  let pairingCleanup = 'not-published';
  let locatorMayExist = false;
  let deviceId;
  /** Stop foreground polling without discarding successful board links or saving a partial device. */
  const stop = () => { interrupted = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    locatorMayExist = true;
    try { await relayDeviceRequest(session, path, { method: 'POST', body: {}, signal }, io); }
    catch (error) {
      if (signal?.aborted && error.code === 'OAUTH_CANCELLED') pairingOutcome = 'cancelled';
      else throw error;
    }
    if (signal?.aborted || interrupted) pairingOutcome = 'cancelled';
    else if (onPairingURL) onPairingURL({ url: link, expires: pending.expires });
    else {
      io.say('Pair your phone once: ' + link);
      try { io.say(terminalQr(link)); }
      catch (error) { if (error.code !== 'PAIR_LINK_LONG') throw error; io.say('Open the pairing link above.'); }
    }
    while (!signal?.aborted && !interrupted && Date.now() < pending.expires) {
      let result;
      try { result = await relayDeviceRequest(session, path, { signal }, io); }
      catch (error) {
        if (signal?.aborted && error.code === 'OAUTH_CANCELLED') { pairingOutcome = 'cancelled'; break; }
        throw error;
      }
      if (signal?.aborted || interrupted) { pairingOutcome = 'cancelled'; break; }
      if (result.enrollment) {
        // Cancellation may prevent acceptance only before its asynchronous authentication starts.
        if (signal?.aborted) { pairingOutcome = 'cancelled'; break; }
        const device = await acceptDeviceEnrollment(result.enrollment);
        await relayDeviceRequest(session, '/api/v1/devices/' + device.deviceId, { method: 'POST', body: {} }, io);
        await relayDeviceRequest(session, path, { method: 'DELETE' }, io);
        locatorMayExist = false;
        pairingCleanup = 'confirmed';
        for (const project of linked) await deliverDeviceWraps(project.root, io);
        io.say('Phone paired; current and future linked boards will appear here.');
        deviceId = device.deviceId;
        pairingOutcome = 'paired';
        break;
      }
      await waitForPairingPoll(signal);
    }
    if (pairingOutcome !== 'paired' && (signal?.aborted || interrupted)) pairingOutcome = 'cancelled';
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    try { updateRelayMachine(state => { if (state.pending?.locator === pending.locator) state.pending = null; }); }
    finally {
      if (locatorMayExist) {
        // Cleanup is independent of the caller's aborted signal; never claim deletion if unconfirmed.
        try {
          await relayDeviceRequest(session, path, { method: 'DELETE' }, io);
          pairingCleanup = 'confirmed';
        } catch { pairingCleanup = 'unconfirmed'; }
      }
    }
  }
  if (pairingOutcome === 'paired') return { paired: true, deviceId, pairingOutcome, pairingCleanup };
  io.say((onPairingURL
    ? `Boards linked; phone pairing ${pairingOutcome}. Run pullboard relay on --all for a fresh code.`
    : 'Boards linked; phone pairing stopped. Run pullboard relay on --all for a fresh code.')
    + (pairingCleanup === 'unconfirmed' ? ' The relay may retain this request until it expires.' : ''));
  return { paired: false, interrupted: interrupted || Boolean(signal?.aborted), pairingOutcome, pairingCleanup };
}

/** Explicit foreground sign-in repairs links; only board machine credentials survive this command. */
export async function relayOnAll(address, io, { signal, onPairingURL, onSignIn, onLinking, onBoardOutcome } = {}) {
  requirePersonChannel(io.personChannel);
  // A cancelled or declined sign-in must not migrate machine state or scrub existing board links.
  const owner = relayMachineOwner();
  const session = await relayMachineSignIn(address || owner?.url, io, { signal, onSignIn });
  if (session.outcome) return session;
  if (signal?.aborted) {
    await revokeRelayPersonSession(session, io);
    return { outcome: 'cancelled' };
  }
  try { await flushRevocations(session, io); }
  catch (error) {
    if (!signal?.aborted) throw error;
    await revokeRelayPersonSession(session, io);
    return { outcome: 'cancelled' };
  }
  if (signal?.aborted) {
    await revokeRelayPersonSession(session, io);
    return { outcome: 'cancelled' };
  }
  // From this synchronous commit point onward the first board-link attempt is underway; later
  // cancellation must not claim that already-started link writes were rolled back.
  onLinking?.();
  updateRelayMachine(state => { state.autoLink = true; state.owner = { account: session.account, url: session.url }; state.approvals = []; });
  const result = await linkProjects(session, io, { onBoardOutcome });
  const devices = readRelayMachine().devices.filter(device => device.account === session.account && device.url === session.url);
  const pairing = devices.length || !result.linked.length ? { paired: devices.length > 0 }
    : await pairFirstDevice(session, result.linked[0].board, result.linked, io, { signal, onPairingURL });
  return { ...result, ...pairing, autoLink: true };
}

// These operations belong to this view process. No ticket, person session, or pairing URL is
// serialized into the machine record or returned as part of an operation's public status.
const viewSignIns = new Map();
const VIEW_INTENT_LIMIT = 32;
const VIEW_RESULT_LIFETIME_MS = 10 * 60_000;
const VIEW_TERMINAL_STATES = new Set(['done', 'declined', 'expired', 'cancelled', 'pairing-stopped']);

/** Forget finished operations after a bounded retention period without disturbing live cleanup. */
function pruneViewSignIns() {
  const now = Date.now();
  for (const [id, operation] of viewSignIns) {
    if (operation.finishedAt && now - operation.finishedAt >= VIEW_RESULT_LIFETIME_MS) viewSignIns.delete(id);
  }
  while (viewSignIns.size >= VIEW_INTENT_LIMIT) {
    const finished = [...viewSignIns].find(([, operation]) => operation.finishedAt);
    if (!finished) break;
    viewSignIns.delete(finished[0]);
  }
}

/** Read a process-local operation without accepting an arbitrary relay ticket or person credential. */
function viewSignInIntent(intentId) {
  pruneViewSignIns();
  const operation = typeof intentId === 'string' && viewSignIns.get(intentId);
  if (!operation) throw new Refused('VIEW_SIGN_IN_UNKNOWN', 'this view sign-in is no longer available; start sign-in again');
  return operation;
}

/** Return only public outcomes, never the private controller, ticket, or pairing capability. */
function viewSignInPublic(operation) {
  return {
    state: operation.state,
    boards: operation.boards.map(board => ({ ...board })),
    ...(operation.error ? { error: { ...operation.error } } : {}),
    ...(operation.pairingCleanup ? { pairingCleanup: operation.pairingCleanup } : {}),
  };
}

/** Keep upstream diagnostics useful without reflecting a bearer accidentally included in an error. */
function viewSignInReason(message) {
  return String(message).replace(/\b(?:ps_|pa_|pm_|pd_|pg_|ghu_|ghs_)[A-Za-z0-9_-]{20,}\b/gu, '[redacted credential]');
}

/** Validate the provider's public device instructions before the view opens a browser address. */
function viewDeviceInstructions(flow) {
  let verification;
  let relay;
  try { verification = new URL(flow.verificationURL); relay = new URL(flow.relayUrl); } catch { /* Refuse below. */ }
  const loopback = hostname => ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
  if (!verification || !relay || verification.username || verification.password || verification.hash
    || !((verification.protocol === 'https:' && verification.hostname === 'github.com'
      && verification.port === '' && verification.pathname === '/login/device' && !verification.search)
      || (verification.protocol === 'http:' && loopback(verification.hostname)
        && relay.protocol === 'http:' && loopback(relay.hostname) && verification.pathname === '/login/device' && !verification.search))
    || typeof flow.userCode !== 'string' || !/^[\x21-\x7e]{1,128}$/u.test(flow.userCode)
    || !Number.isSafeInteger(flow.expiresAt) || flow.expiresAt <= Date.now()) {
    throw new Refused('VIEW_SIGN_IN_RESPONSE', 'the relay returned invalid sign-in instructions; check its address and start again');
  }
  return { verificationURL: verification.href, userCode: flow.userCode, expiresAt: flow.expiresAt };
}

/** Start the existing device flow in RAM; the view receives only its public link, code and id. */
export async function startViewSignIn({ relayUrl, signal } = {}) {
  if (signal?.aborted) throw new Refused('OAUTH_CANCELLED', 'sign-in was cancelled before it started; no board was linked');
  pruneViewSignIns();
  if ([...viewSignIns.values()].some(operation => !operation.finishedAt)) {
    throw new Refused('VIEW_SIGN_IN_BUSY', 'this view is already signing in; finish or cancel that sign-in first');
  }
  const intentId = randomUUID();
  const operation = { state: 'waiting', boards: [], controller: new AbortController(), pairing: null, finishedAt: null };
  const abortStarting = () => operation.controller.abort();
  signal?.addEventListener('abort', abortStarting, { once: true });
  viewSignIns.set(intentId, operation);
  let resolveReady;
  let rejectReady;
  let published = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // The established linking path still owns authorization and pairing. Its terminal IO is a
  // sink; progress enters this operation only through typed callbacks, never parsed text.
  const io = { personChannel: 'view', say() {}, err() {}, stderr: { write() {} } };
  operation.finished = Promise.resolve().then(() => relayOnAll(relayUrl, io, {
    signal: operation.controller.signal,
    onSignIn(flow) {
      let instructions;
      try { instructions = viewDeviceInstructions(flow); }
      catch (error) { operation.controller.abort(); rejectReady(error); throw error; }
      published = true;
      resolveReady({ intentId, ...instructions });
    },
    onLinking() { operation.state = 'linking'; },
    onBoardOutcome(board) {
      operation.boards = operation.boards.filter(prior => prior.root !== board.root);
      operation.boards.push({ ...board, reason: viewSignInReason(board.reason) });
    },
    onPairingURL(pairing) { operation.state = 'pairing'; operation.pairing = { ...pairing }; },
  })).then(result => {
    operation.state = result.outcome ?? (result.pairingOutcome && result.pairingOutcome !== 'paired' ? 'pairing-stopped' : 'done');
    if (result.pairingCleanup) operation.pairingCleanup = result.pairingCleanup;
    if (result.pairingCleanup === 'unconfirmed') operation.error = { code: 'VIEW_PAIRING_CLEANUP',
      message: 'boards remain linked; the relay could not confirm phone-pairing cleanup and may retain the request until it expires' };
    if (!published) rejectReady(new Refused(result.outcome === 'cancelled' ? 'OAUTH_CANCELLED' : 'VIEW_SIGN_IN_STOPPED',
      'sign-in stopped before instructions were available; no board was linked'));
  }, error => {
    operation.state = 'done';
    operation.error = { code: error instanceof Refused ? error.code : 'VIEW_SIGN_IN_FAILED',
      message: error instanceof Refused ? viewSignInReason(error.message) : 'sign-in could not finish; check the relay and try again' };
    if (!published) rejectReady(error);
  }).finally(() => {
    operation.pairing = null;
    operation.finishedAt = Date.now();
  });
  try { return await ready; }
  catch (error) {
    // A rejected instruction response must not hide a later failure to cancel its real ticket.
    await operation.finished;
    if (operation.error?.code === 'OAUTH_CLEANUP') throw new Refused(operation.error.code, operation.error.message);
    throw error;
  } finally { signal?.removeEventListener('abort', abortStarting); }
}

/** Poll only public operation progress; core, not the browser, polls the private relay ticket. */
export function viewSignInStatus(intentId) {
  return viewSignInPublic(viewSignInIntent(intentId));
}

/** Give the authenticated view server a transient pairing redirect, never a JSON status field. */
export function viewSignInPairingNavigation(intentId) {
  const operation = viewSignInIntent(intentId);
  if (operation.controller.signal.aborted || operation.state !== 'pairing' || !operation.pairing || operation.pairing.expires <= Date.now()) {
    throw new Refused('VIEW_PAIRING_NOT_READY', 'phone pairing is not waiting; read this sign-in’s current status');
  }
  return { ...operation.pairing };
}

/** Cancel and await actual cleanup, preserving linked boards if linking already began. */
export async function cancelViewSignIn(intentId) {
  const operation = viewSignInIntent(intentId);
  if (operation.state === 'linking') {
    throw new Refused('VIEW_SIGN_IN_LINKING', 'board linking has started and will finish as one batch; stop phone pairing when it begins');
  }
  if (!VIEW_TERMINAL_STATES.has(operation.state)) {
    // Stop publishing the capability synchronously; remote deletion may still be pending.
    operation.pairing = null;
    operation.controller.abort();
  }
  await operation.finished;
  return viewSignInPublic(operation);
}
