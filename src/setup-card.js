/**
 * The first-run setup card and its receipts (N19, I1): which of the five setup steps comes next for
 * this board, and the typed setup and view-bind receipts that prove a step happened. Each receipt is
 * scoped to the board's current coordinator enrollment, so a re-initialised board starts over.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import * as store from './board.js';
import { COORDINATOR } from './config.js';
import { detectGate } from './init.js';
import { laneNames } from './lanes.js';
import { loadSpec } from './spec.js';

/** Identify setup from this board's coordinator enrollment, independently of agent flags. */
export function setupIdentity(board) {
  return { boardId: store.boardId(board),
    setupStartedAt: store.listAgents(board).find(agent => agent.agent_id === COORDINATOR)?.agent_created_at };
}

/** Read only the view's typed successful-bind receipt for this board and setup. */
function viewBindComplete(ctx, board) {
  let receipt;
  try { receipt = JSON.parse(readFileSync(join(ctx.info.commonDir, 'pullboard', 'view-bind.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  const identity = setupIdentity(board);
  return receipt?.type === 'pullboard.view.bound' && receipt.version === 1
    && receipt.boardId === identity.boardId && receipt.setupStartedAt === identity.setupStartedAt
    && Number.isFinite(Date.parse(receipt.boundAt))
    && Date.parse(receipt.boundAt) >= Date.parse(identity.setupStartedAt);
}

/** A separately typed, authenticated reuse also proves that this board's view was opened. */
export function viewSetupComplete(ctx, board) {
  if (viewBindComplete(ctx, board)) return true;
  let receipt;
  try { receipt = JSON.parse(readFileSync(join(ctx.info.commonDir, 'pullboard', 'view-reuse.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  const identity = setupIdentity(board);
  return receipt?.type === 'pullboard.view.reused' && receipt.version === 1
    && receipt.boardId === identity.boardId && receipt.setupStartedAt === identity.setupStartedAt
    && Number.isFinite(Date.parse(receipt.openedAt))
    && Date.parse(receipt.openedAt) >= Date.parse(identity.setupStartedAt);
}

/** Atomically record a successful real view bind, scoped to this board's current setup. */
export function recordViewBind(ctx, board, boundAt) {
  const file = join(ctx.info.commonDir, 'pullboard', 'view-bind.json');
  const temporary = file + '.' + randomUUID() + '.tmp';
  const receipt = { type: 'pullboard.view.bound', version: 1, ...setupIdentity(board), boundAt };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temporary, JSON.stringify(receipt) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/** Record this board's authenticated reuse without claiming that its existing listener bound again. */
export function recordViewReuse(ctx, board, view) {
  const file = join(ctx.info.commonDir, 'pullboard', 'view-reuse.json');
  const temporary = file + '.' + randomUUID() + '.tmp';
  const receipt = { type: 'pullboard.view.reused', version: 1, ...setupIdentity(board),
    openedAt: new Date().toISOString(), boundAt: view.boundAt, port: view.port, pid: view.pid };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temporary, JSON.stringify(receipt) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/** Read a typed setup receipt only for this board's current coordinator enrollment. */
function setupReceiptMatches(ctx, identity, state) {
  let receipt;
  try { receipt = JSON.parse(readFileSync(join(ctx.info.commonDir, 'pullboard', `setup-${state}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  return receipt?.type === `pullboard.setup.${state === 'complete' ? 'completed' : state}` && receipt.version === 1
    && receipt.boardId === identity.boardId && receipt.setupStartedAt === identity.setupStartedAt;
}

/** Atomically record a setup transition, scoped to this board enrollment. */
export function recordSetupState(ctx, identity, state) {
  const file = join(ctx.info.commonDir, 'pullboard', `setup-${state}.json`);
  const temporary = file + '.' + randomUUID() + '.tmp';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temporary, JSON.stringify({ type: `pullboard.setup.${state === 'complete' ? 'completed' : state}`, version: 1, ...identity }) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/** Derive the next setup question from the real requirements, config, items and view receipt. */
export function boardSetup(ctx, card, identity) {
  const rows = loadSpec(ctx.info.root, ctx.config).rows;
  const approved = rows.filter(row => row.status === 'approved');
  const drafted = rows.filter(row => row.status === 'draft' || row.status === 'pending');
  const recordedComplete = setupReceiptMatches(ctx, identity, 'complete');
  const started = setupReceiptMatches(ctx, identity, 'started');
  const lanes = laneNames(ctx.config).filter(lane => !['review', COORDINATOR].includes(lane));
  const folders = readdirSync(ctx.info.root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map(entry => entry.name).sort();
  const lane = lanes[0] ?? folders[0] ?? 'app';
  // Older installations had no setup marker. Preserve their completed five-step state on upgrade.
  const legacyUnmarked = !existsSync(join(ctx.info.commonDir, 'pullboard', 'setup-started.json'))
    && !existsSync(join(ctx.info.commonDir, 'pullboard', 'setup-complete.json'));
  const legacyComplete = legacyUnmarked && approved.length > 0 && lanes.length > 0
    && Boolean(ctx.config.gate?.trim()) && card.all.length > 0 && card.viewOpened;
  const completed = recordedComplete || legacyComplete;
  const detectedGate = detectGate(ctx.info.root);
  /** Quote the exact suggested command safely for a shell. */
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
  /** Quote one shell word only when it needs it, so a plain lane command reads as typed. */
  const word = value => /^[A-Za-z0-9._/-]+$/u.test(String(value)) ? String(value) : quote(value);
  /** Preserve all existing configuration when recording one setup answer. */
  const configure = patch => `node -e ${quote(`const fs=require('node:fs');const p='pullboard.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));${patch};fs.writeFileSync(p,JSON.stringify(c,null,2)+${JSON.stringify('\n')})`)}`;
  const steps = [
    { number: 1, done: approved.length > 0 && (!drafted.length || completed), question: 'Ask the person: what are we building, and who will use it? Draft a few requirements, then ask the person to approve them.',
      command: 'pullboard spec draft "<text>"',
      afterAnswer: 'Record each answer with pullboard spec draft "<text>"; the person approves the returned ids in Pullboard View or runs pullboard spec approve <ids> in their own terminal; then the coordinator runs pullboard spec apply.' },
    { number: 2, done: lanes.length > 0, question: `Ask the person: how should we divide the work? Suggested folders: ${folders.join(', ') || 'app/ (create it for the app)'}.`,
      command: `pullboard lane add ${word(lane)} --owns ${word(lane + '/')}` },
    { number: 3, done: Boolean(ctx.config.gate?.trim()),
      question: detectedGate
        ? `Ask the person: which command proves the build works? Suggested: ${detectedGate}.`
        : 'Ask the person: if this board has no build, use `pullboard spec check` to check its spec and practice files; a second agent review checks the actual work. Or choose a custom gate command.',
      command: configure(`c.gate=${JSON.stringify(detectedGate || 'pullboard spec check')}`) },
    { number: 4, done: card.all.length > 0, question: 'Ask the person: what is the first small piece we should build?',
      command: `pullboard add ${quote(lane)} 'First small piece' --specs ${quote(approved[0]?.id ?? 'G1')} --criterion 'Describe what the person will be able to do'` },
    { number: 5, done: card.viewOpened,
      question: 'Ask the person: shall we open the board so you can follow the work?', command: 'pullboard view',
      afterAnswer: 'Run this in the person’s own terminal, or start it in the background as the agent so setup can continue. The view records its successful bind or authenticated reuse for this board.' },
  ];
  const current = steps.find(step => !step.done);
  if (!current && !recordedComplete) recordSetupState(ctx, identity, 'complete');
  else if (current && !completed && !started) recordSetupState(ctx, identity, 'started');
  if (current?.number === 1 && drafted.length) {
    const rowIds = drafted.map(row => row.id);
    const names = rowIds.join(', ');
    const command = `pullboard spec show ${rowIds[0]}`;
    return { step: 1, total: 5, ...current, steps, waitingOn: 'person-approval', rowIds,
      question: `Waiting for the person to approve ${names}.`, command,
      personCommand: `pullboard spec approve ${rowIds.join(',')}`,
      afterAnswer: 'The person approves these rows in Pullboard View or their own terminal; then the coordinator runs pullboard spec apply.',
      meanwhile: 'While waiting, the agent may review independent approved work or prepare questions for the person.',
      agentNext: `wait for the person to approve ${names}; meanwhile ${command}` };
  }
  return current ? { step: current.number, total: 5, ...current, steps } : null;
}
