/**
 * Blueprints: a starter spec as one JSON file (I1). A blueprint's rules become draft rows with their
 * reasons, its questions become pending rows with their defaults filled in, and its starter items
 * become open items citing those rows, all in one new SPEC.md section named after it. Nothing is
 * approved: the person approves rows the usual way.
 *
 * Format 1, one JSON object:
 *
 *   blueprint  1                       required, the format version
 *   name       "web-app"               required, lowercase letters, digits and dashes
 *   title      "Web app"               required, one line; the section heading
 *   version    1                       required, a positive integer, the blueprint's own version
 *   kind       "product"               optional: product, infrastructure, practice or beyond-code
 *   by         "Pullboard"             optional, who made it
 *   summary    "..."                   optional, one line
 *   prefix     "W"                     optional, the row id prefix it prefers; a free one is used if taken
 *   gate       "npm test"              optional, set in pullboard.json only when it has no gate
 *   rules      [{ key, text, why, tier?, gate? }]          tier must|aim (must), gate (review)
 *   questions  [{ key, ask, choices, default }]            default is one of choices
 *   items      [{ key, title, cites?, after?, lane?, route?, criterion?, brief? }]   route is strong
 *
 * Rule and question keys ("W1", "Q1") are unique within the file; an item cites them by key and
 * waits on other items by their keys. On a board they get real ids from the section's prefix.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refused } from './refused.js';
import { insertSectionRows, nextRowId } from './spec.js';

/** The blueprint file format this Pullboard reads and writes. */
export const BLUEPRINT_FORMAT = 1;

/** The kinds the gallery files blueprints under. */
export const BLUEPRINT_KINDS = ['product', 'infrastructure', 'practice', 'beyond-code'];

const BUNDLED_DIR = fileURLToPath(new URL('./blueprints/', import.meta.url));
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const KEY_RE = /^[A-Za-z0-9]+$/u;
const PREFIX_RE = /^[A-Z][A-Z0-9]*$/u;

/**
 * The names of the blueprints shipped with Pullboard, sorted.
 *
 * @returns {string[]}
 */
export function bundledBlueprints() {
  if (!existsSync(BUNDLED_DIR)) return [];
  return readdirSync(BUNDLED_DIR).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5)).sort();
}

/**
 * Read and check a blueprint: a bundled name such as web-app, or a path to a JSON file.
 * A bare name is looked up among the bundled ones first, so a stray file cannot shadow it.
 *
 * @param {string} reference
 * @param {string} cwd
 * @returns {Blueprint}
 */
export function readBlueprint(reference, cwd) {
  const text = String(reference ?? '').trim();
  if (!text) throw new Refused('USAGE', `name a blueprint: pullboard blueprint add <name or file>; bundled: ${bundledBlueprints().join(', ')}`);
  const bundled = NAME_RE.test(text) && bundledBlueprints().includes(text);
  const file = bundled ? resolve(BUNDLED_DIR, `${text}.json`) : resolve(cwd, text);
  if (!bundled && !existsSync(file)) {
    throw new Refused('NO_BLUEPRINT', `no blueprint "${text}"; use a bundled one (${bundledBlueprints().join(', ')}) or a path to a blueprint JSON file`);
  }
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    throw new Refused('BAD_BLUEPRINT', `${bundled ? text : file} is not readable JSON (${error.message.split('\n')[0]}); fix the file and run pullboard blueprint add again`);
  }
  const blueprint = validateBlueprint(value, bundled ? text : basename(file));
  if (bundled && blueprint.name !== text) throw new Refused('BAD_BLUEPRINT', `${text}.json names itself "${blueprint.name}"; its name and file name must match`);
  return blueprint;
}

/**
 * @typedef {object} Blueprint
 * @property {number} blueprint
 * @property {string} name
 * @property {string} title
 * @property {number} version
 * @property {string} [kind]
 * @property {string} [by]
 * @property {string} [summary]
 * @property {string} [prefix]
 * @property {string} [gate]
 * @property {{ key: string, text: string, why: string, tier: string, gate: string }[]} rules
 * @property {{ key: string, ask: string, choices: string[], default: string }[]} questions
 * @property {{ key: string, title: string, cites: string[], after: string[], lane?: string, route: string, criterion: string, brief: string }[]} items
 */

/**
 * Check a parsed blueprint against format 1 and return it with optional fields filled in.
 * Every problem is named with its field path, so a hand-written file can be fixed in one pass.
 *
 * @param {any} value
 * @param {string} source - How to name the file in a refusal.
 * @returns {Blueprint}
 */
export function validateBlueprint(value, source = 'blueprint') {
  const problems = [];
  const fail = (path, message) => problems.push(`${path} ${message}`);
  const line = (path, text, { required = true } = {}) => {
    if (text === undefined && !required) return;
    if (typeof text !== 'string' || !text.trim()) fail(path, 'must be nonempty text');
    else if (/[\r\n|]/u.test(text)) fail(path, 'must be one line without a | character');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Refused('BAD_BLUEPRINT', `${source} is not a blueprint: it must be one JSON object with blueprint, name, title, version and rules or questions; fix it and run pullboard blueprint add again`);
  }
  if (value.blueprint !== BLUEPRINT_FORMAT) fail('blueprint', `must be ${BLUEPRINT_FORMAT}, the format this Pullboard reads`);
  if (typeof value.name !== 'string' || !NAME_RE.test(value.name)) fail('name', 'must be lowercase letters, digits and dashes, such as web-app');
  line('title', value.title);
  if (!Number.isInteger(value.version) || value.version < 1) fail('version', 'must be a positive integer');
  if (value.kind !== undefined && !BLUEPRINT_KINDS.includes(value.kind)) fail('kind', `must be one of ${BLUEPRINT_KINDS.join(', ')}`);
  line('by', value.by, { required: false });
  line('summary', value.summary, { required: false });
  line('gate', value.gate, { required: false });
  if (value.prefix !== undefined && (typeof value.prefix !== 'string' || !PREFIX_RE.test(value.prefix))) fail('prefix', 'must be capital letters, such as W');
  const rules = Array.isArray(value.rules) ? value.rules : (value.rules === undefined ? [] : (fail('rules', 'must be an array'), []));
  const questions = Array.isArray(value.questions) ? value.questions : (value.questions === undefined ? [] : (fail('questions', 'must be an array'), []));
  const items = Array.isArray(value.items) ? value.items : (value.items === undefined ? [] : (fail('items', 'must be an array'), []));
  if (!rules.length && !questions.length) fail('rules', 'or questions must hold at least one entry');
  const keys = new Set();
  const key = (path, text, seen) => {
    if (typeof text !== 'string' || !KEY_RE.test(text)) fail(path, 'must be letters and digits, such as W1');
    else if (seen.has(text)) fail(path, `repeats the key ${text}`);
    else seen.add(text);
  };
  rules.forEach((rule, index) => {
    const at = `rules[${index}]`;
    if (!rule || typeof rule !== 'object') return fail(at, 'must be an object');
    key(`${at}.key`, rule.key, keys);
    line(`${at}.text`, rule.text);
    line(`${at}.why`, rule.why);
    if (rule.tier !== undefined && !['must', 'aim'].includes(rule.tier)) fail(`${at}.tier`, 'must be must or aim');
    line(`${at}.gate`, rule.gate, { required: false });
  });
  questions.forEach((question, index) => {
    const at = `questions[${index}]`;
    if (!question || typeof question !== 'object') return fail(at, 'must be an object');
    key(`${at}.key`, question.key, keys);
    line(`${at}.ask`, question.ask);
    if (!Array.isArray(question.choices) || question.choices.length < 2) fail(`${at}.choices`, 'must list at least two answers');
    else question.choices.forEach((choice, n) => line(`${at}.choices[${n}]`, choice));
    line(`${at}.default`, question.default);
    if (Array.isArray(question.choices) && !question.choices.includes(question.default)) fail(`${at}.default`, 'must be one of its choices');
  });
  const itemKeys = new Set();
  items.forEach((item, index) => {
    const at = `items[${index}]`;
    if (!item || typeof item !== 'object') return fail(at, 'must be an object');
    key(`${at}.key`, item.key, itemKeys);
    line(`${at}.title`, item.title);
    if (item.cites !== undefined && !Array.isArray(item.cites)) fail(`${at}.cites`, 'must be an array of rule or question keys');
    for (const cited of item.cites ?? []) if (!keys.has(cited)) fail(`${at}.cites`, `names ${JSON.stringify(cited)}, which is no rule or question key here`);
    if (item.after !== undefined && !Array.isArray(item.after)) fail(`${at}.after`, 'must be an array of earlier item keys');
    for (const before of item.after ?? []) {
      if (!itemKeys.has(before) || before === item.key) fail(`${at}.after`, `names ${JSON.stringify(before)}, which is no earlier item key`);
    }
    line(`${at}.lane`, item.lane, { required: false });
    // A light or mid item needs a coordinator's check and a cold brief, which a blueprint cannot carry.
    if (item.route !== undefined && item.route !== 'strong') fail(`${at}.route`, 'must be strong or left out; add a light or mid item later with pullboard add and its check');
    line(`${at}.criterion`, item.criterion, { required: false });
    if (item.brief !== undefined && typeof item.brief !== 'string') fail(`${at}.brief`, 'must be text');
  });
  if (problems.length) {
    throw new Refused('BAD_BLUEPRINT', `${source} is not a valid blueprint: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; and ${problems.length - 5} more` : ''}; fix the file and run pullboard blueprint add again`);
  }
  return {
    ...value,
    rules: rules.map((rule) => ({ ...rule, tier: rule.tier ?? 'must', gate: rule.gate ?? 'review' })),
    questions,
    items: items.map((item) => ({ ...item, cites: item.cites ?? [], after: item.after ?? [], route: item.route ?? 'strong', criterion: item.criterion ?? '', brief: item.brief ?? '' })),
  };
}

/**
 * The marker line a blueprint leaves after its rows once everything is added, so the same version
 * adds nothing twice even after the person rewords or declines its rows.
 *
 * @param {{ name: string, version: number }} blueprint
 * @returns {string}
 */
export function blueprintMarker(blueprint) {
  return `<!-- pullboard-blueprint ${blueprint.name} ${blueprint.version} -->`;
}

/**
 * The marker line written with the rows while an add is under way: it records which row id each
 * rule and question key got, so a retry after a failure part way files no row twice and finds the
 * starter items already added by those ids. The finished add replaces it with blueprintMarker.
 *
 * @param {{ name: string, version: number }} blueprint
 * @param {Record<string, string>} ids - Row id by rule or question key.
 * @returns {string}
 */
export function blueprintAddingMarker(blueprint, ids) {
  return `<!-- pullboard-blueprint ${blueprint.name} ${blueprint.version} adding ${Object.entries(ids).map(([key, id]) => `${key}=${id}`).join(' ')} -->`;
}

/**
 * Read an under-way marker line for this blueprint version, or null.
 *
 * @param {string} line
 * @param {{ name: string, version: number }} blueprint
 * @returns {Record<string, string> | null}
 */
function addingIds(line, blueprint) {
  const match = /^<!-- pullboard-blueprint (\S+) (\d+) adding ((?:[A-Za-z0-9]+=[A-Za-z0-9.]+ ?)+) -->$/u.exec(line.trim());
  if (!match || match[1] !== blueprint.name || Number(match[2]) !== blueprint.version) return null;
  return Object.fromEntries(match[3].trim().split(' ').map((pair) => pair.split('=')));
}

/**
 * One rule's row text: the rule, then its reason.
 *
 * @param {{ text: string, why: string }} rule
 * @returns {string}
 */
export function ruleText(rule) {
  return `${rule.text.trim()} Why: ${rule.why.trim()}`;
}

/**
 * One question's row text: the question with its default as the answer, then every choice.
 *
 * @param {{ ask: string, choices: string[], default: string }} question
 * @returns {string}
 */
export function questionText(question) {
  return `${question.ask.trim()}: ${question.default.trim()}. Choices: ${question.choices.map((choice) => choice.trim()).join(', ')}.`;
}

/**
 * Work out what adding a blueprint changes, without writing anything. A first add files every rule
 * as a new draft row and every question as a new pending row, whatever the spec already says, in
 * the blueprint's section (found by title, or new), and plans every starter item. A retry after a
 * failure part way (the under-way marker is there) files no rows and plans only the starters not
 * yet on the board, found by title and the row ids they cite. A finished add (the marker is there)
 * plans nothing.
 *
 * @param {Blueprint} blueprint
 * @param {{ source: string, spec: any, doctrine: any, existingItems: { id: number, title: string, specIds: string[] }[], gate: string }} board
 *   source is SPEC.md's text and spec its parse; doctrine is loadDoctrine's result; existingItems
 *   are the items on the board; gate is pullboard.json's gate now.
 * @returns {{ marked: boolean, resumed: boolean, section: { prefix: string, name: string, isNew: boolean }, rows: { key: string, id: string, status: string, text: string, line: string }[], specRows: string, specAfter: string, ids: Record<string, string>, items: { key: string, title: string, specIds: string[], after: string[], lane?: string, route: string, criterion: string, brief: string }[], existing: Record<string, number>, gate: string | null }}
 *   specRows is the text to write before the items (rows and the under-way marker), specAfter the
 *   text once they are all added (the finished marker); existing maps starter keys already on the
 *   board to their item ids.
 */
export function planBlueprint(blueprint, { source, spec, doctrine, existingItems = [], gate }) {
  const marker = blueprintMarker(blueprint);
  const lines = source.split(/\r?\n/u);
  const marked = lines.some((text) => text.trim() === marker);
  const addingLine = lines.find((text) => addingIds(text, blueprint));
  const resumed = !marked && Boolean(addingLine);
  const allRows = [...spec.rows, ...(doctrine?.rows ?? []), ...(doctrine?.repo?.rows ?? [])];
  const prefixOf = (name) => /^([A-Z][A-Z0-9]*)\s*[·.:-]/u.exec(name)?.[1];
  const existingSection = spec.sections.find((section) => section.name.replace(/^[A-Z][A-Z0-9]*\s*[·.:-]\s*/u, '') === blueprint.title.trim() && prefixOf(section.name));
  const taken = new Set([
    ...allRows.map((row) => /^[A-Za-z]+/u.exec(row.id)?.[0].toUpperCase()),
    ...spec.sections.map((section) => prefixOf(section.name)),
    ...(doctrine?.sections ?? []).map((section) => prefixOf(section.name)),
  ].filter(Boolean));
  const prefix = existingSection ? prefixOf(existingSection.name) : freePrefix(blueprint, taken);
  const name = existingSection ? existingSection.name : `${prefix} · ${blueprint.title.trim()}`;
  const section = { prefix, name, isNew: !existingSection };
  const gateToSet = !gate?.trim() && blueprint.gate ? blueprint.gate : null;
  if (marked) return { marked, resumed: false, section, rows: [], specRows: source, specAfter: source, ids: {}, items: [], existing: {}, gate: null };
  const rows = [];
  let ids;
  let specRows = source;
  if (resumed) ids = addingIds(addingLine, blueprint);
  else {
    // The same rows spec draft numbers against: SPEC.md and the repo's own doctrine.
    const numberedRows = [...spec.rows, ...(doctrine?.repo?.rows ?? [])];
    const allocate = () => {
      const id = nextRowId(prefix, numberedRows);
      numberedRows.push({ id });
      return id;
    };
    ids = {};
    for (const rule of blueprint.rules) {
      const id = allocate();
      const text = ruleText(rule);
      ids[rule.key] = id;
      rows.push({ key: rule.key, id, status: 'draft', text, line: `- ${id} [draft, ${rule.tier}] ${text} | gate: ${rule.gate}` });
    }
    for (const question of blueprint.questions) {
      const id = allocate();
      const text = questionText(question);
      ids[question.key] = id;
      rows.push({ key: question.key, id, status: 'pending', text, line: `- ${id} [pending, must] ${text} | gate: review` });
    }
    specRows = insertSection(source, spec, { existing: existingSection, name, lines: [...rows.map((row) => row.line), blueprintAddingMarker(blueprint, ids)] });
  }
  const underWay = blueprintAddingMarker(blueprint, ids);
  const specAfter = specRows.split(/(\r?\n)/u).map((part) => (part.trim() === underWay || (resumed && part === addingLine) ? part.replace(part.trim(), marker) : part)).join('');
  const existing = {};
  const items = [];
  for (const item of blueprint.items) {
    const specIds = item.cites.map((cited) => ids[cited]).filter(Boolean);
    const found = resumed && existingItems.find((entry) => entry.title === item.title.trim() && entry.specIds.join(',') === specIds.join(','));
    if (found) { existing[item.key] = found.id; continue; }
    items.push({ key: item.key, title: item.title.trim(), specIds, after: item.after,
      ...(item.lane ? { lane: item.lane } : {}), route: item.route, criterion: item.criterion, brief: item.brief });
  }
  return { marked, resumed, section, rows, specRows, specAfter, ids, items, existing, gate: gateToSet };
}

/**
 * Choose the section's id prefix: the blueprint's own if free, then the title's initials, then any
 * free capital letter, then the preferred prefix with a letter added. Ids are unique across SPEC.md
 * and the doctrine, so a prefix either file uses is taken.
 *
 * @param {{ prefix?: string, title: string }} blueprint
 * @param {Set<string>} taken
 * @returns {string}
 */
function freePrefix(blueprint, taken) {
  const initials = blueprint.title.split(/\s+/u).map((word) => word[0]?.toUpperCase()).filter((letter) => /[A-Z]/u.test(letter ?? ''));
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const base = blueprint.prefix ?? initials[0] ?? 'B';
  const candidates = [blueprint.prefix, ...initials, initials.join(''), ...letters, ...letters.map((letter) => `${base}${letter}`)];
  return candidates.find((candidate) => candidate && !taken.has(candidate)) ?? `${base}${taken.size}`;
}

/**
 * Put lines into SPEC.md text: into the blueprint's existing section the way spec draft does, or
 * as a new section at the end.
 *
 * @param {string} source
 * @param {any} spec
 * @param {{ existing: any, name: string, lines: string[] }} change
 * @returns {string}
 */
function insertSection(source, spec, { existing, name, lines: added }) {
  if (existing) return insertSectionRows(source, spec, existing, added);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/u);
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  lines.push('', `## ${name}`, '', ...added, '');
  return lines.join(newline);
}

// A row naming a file or a place on disk: any token with a slash or backslash between characters,
// or a home-relative path. Bare names such as Next.js are words, not paths.
const PATH_RE = /(?:^|[\s(`'"[])(?:~\/|\.{1,2}\/|\/)?[^\s/\\`'"()[\]]+[/\\][^\s`'"()[\]]+|(?:^|[\s(`'"[])~\//u;
const EMAIL_RE = /[^\s@<>()[\]`'"]+@[^\s@<>()[\]`'"]+\.[^\s@<>()[\]`'"]+/u;
const QUESTION_RE = /^(.+?): (.+)\. Choices: (.+)\.$/u;
const RULE_RE = /^(.+?) Why: (.+)$/u;

/**
 * Name why a piece of text may not leave this board, or return null when it may. Text that holds
 * a path, an email or any private name (a person, an agent, a model label or a machine) stays.
 *
 * @param {string} text
 * @param {string[]} names - Every private name known on this board and machine.
 * @returns {string | null}
 */
export function privateTextReason(text, names) {
  if (PATH_RE.test(text)) return 'a file path';
  if (EMAIL_RE.test(text)) return 'an email address';
  const lower = text.toLowerCase();
  for (const name of names) {
    const wanted = String(name ?? '').trim().toLowerCase();
    if (wanted.length < 3) continue;
    const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (new RegExp(`(?:^|[^\\p{L}\\p{N}_-])${escaped}(?:$|[^\\p{L}\\p{N}_-])`, 'u').test(lower)) return 'a private name';
  }
  return null;
}

/**
 * Turn a board's approved spec rows into a blueprint, writing only fields on an explicit
 * allow-list: the format, a name and title, a version, the gate when it is clean, each approved
 * rule's text, reason, tier and a review gate, and each answered question's ask, choices and
 * answer. Items, shouts, notes, decisions, signers, row gates, files, emails and the names of
 * people, agents and machines are never read into it. A row that would carry any of them, or a
 * rule with no "Why:" reason to carry, is left out and named in `left`, never rewritten [S1].
 *
 * @param {{ rows: any[] }} spec - The parsed SPEC.md.
 * @param {{ name: string, title: string, gate?: string, names: string[] }} board
 * @returns {{ blueprint: Blueprint, left: { id: string, reason: string }[] }}
 */
export function saveBlueprint(spec, { name, title, gate, names }) {
  const rules = [];
  const questions = [];
  const left = [];
  for (const row of spec.rows) {
    if (row.status !== 'approved') continue;
    const text = String(row.text ?? '').trim();
    const privacy = privateTextReason(text, names);
    if (privacy) { left.push({ id: row.id, reason: `it holds ${privacy}` }); continue; }
    const question = QUESTION_RE.exec(text);
    if (question) {
      const choices = question[3].split(', ').map((choice) => choice.trim()).filter(Boolean);
      const answer = question[2].trim();
      if (!choices.includes(answer)) choices.push(answer);
      if (choices.length < 2) { left.push({ id: row.id, reason: 'its question has fewer than two choices' }); continue; }
      questions.push({ key: row.id, ask: question[1].trim(), choices, default: answer });
      continue;
    }
    const rule = RULE_RE.exec(text);
    if (!rule) { left.push({ id: row.id, reason: 'it has no "Why:" reason to carry' }); continue; }
    rules.push({ key: row.id, text: rule[1].trim(), why: rule[2].trim(), tier: row.tier === 'aim' ? 'aim' : 'must', gate: 'review' });
  }
  const slug = String(name ?? '').normalize('NFKD').toLowerCase().replace(/[̀-ͯ]/gu, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'board';
  const cleanTitle = String(title ?? '').trim();
  const value = {
    blueprint: BLUEPRINT_FORMAT,
    name: slug,
    title: cleanTitle && !/[\r\n|]/u.test(cleanTitle) && !privateTextReason(cleanTitle, names) ? cleanTitle : slug,
    version: 1,
    ...(gate?.trim() && !/[\r\n|]/u.test(gate) && !privateTextReason(gate.trim(), names) ? { gate: gate.trim() } : {}),
    ...(rules.length ? { rules } : {}),
    ...(questions.length ? { questions } : {}),
  };
  if (!rules.length && !questions.length) {
    throw new Refused('EMPTY_BLUEPRINT', `no approved row can leave this board${left.length ? ` (${left.length} left out: ${left.slice(0, 3).map((entry) => `${entry.id}, ${entry.reason}`).join('; ')})` : ''}; approve rules written as "<rule> Why: <reason>", then run pullboard blueprint save again`);
  }
  // Checked against the format blueprint add reads, then written exactly as allow-listed above.
  validateBlueprint(value, `${slug}.blueprint.json`);
  return { blueprint: value, left };
}
