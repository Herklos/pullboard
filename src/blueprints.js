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
 * Work out what adding a blueprint changes, without writing anything: the section (found or new),
 * the rows not already in the spec with their new ids, the new SPEC.md text, and the items not
 * already on the board, each citing real row ids. A repeat of the same version plans nothing.
 *
 * @param {Blueprint} blueprint
 * @param {{ source: string, spec: any, doctrine: any, itemTitles: Iterable<string>, gate: string }} board
 *   source is SPEC.md's text and spec its parse; doctrine is loadDoctrine's result; itemTitles are
 *   every item title on the board; gate is pullboard.json's gate now.
 * @returns {{ marked: boolean, section: { prefix: string, name: string, isNew: boolean }, rows: { key: string, id: string, status: string, text: string, line: string }[], specRows: string, specAfter: string, ids: Record<string, string>, items: { key: string, title: string, specIds: string[], after: string[], lane?: string, route: string, criterion: string, brief: string }[], gate: string | null }}
 */
export function planBlueprint(blueprint, { source, spec, doctrine, itemTitles, gate }) {
  const marker = blueprintMarker(blueprint);
  const lines = source.split(/\r?\n/u);
  const marked = lines.some((text) => text.trim() === marker);
  const allRows = [...spec.rows, ...(doctrine?.rows ?? []), ...(doctrine?.repo?.rows ?? [])];
  const prefixOf = (name) => /^([A-Z][A-Z0-9]*)\s*[·.:-]/u.exec(name)?.[1];
  const existing = spec.sections.find((section) => section.name.replace(/^[A-Z][A-Z0-9]*\s*[·.:-]\s*/u, '') === blueprint.title.trim() && prefixOf(section.name));
  const taken = new Set([
    ...allRows.map((row) => /^[A-Za-z]+/u.exec(row.id)?.[0].toUpperCase()),
    ...spec.sections.map((section) => prefixOf(section.name)),
    ...(doctrine?.sections ?? []).map((section) => prefixOf(section.name)),
  ].filter(Boolean));
  const prefix = existing ? prefixOf(existing.name) : freePrefix(blueprint, taken);
  const name = existing ? existing.name : `${prefix} · ${blueprint.title.trim()}`;
  // Only the blueprint's own section counts as already filed: a row elsewhere with the same words,
  // approved or not, belongs to the person's own spec, and the blueprint still files its drafts.
  const own = existing ? spec.rows.filter((row) => row.section === existing.name) : [];
  const byText = new Map(own.map((row) => [row.text, row.id]));
  const askedIds = new Map(own.map((row) => [row.text.split(': ')[0], row.id]));
  // The same rows spec draft numbers against: SPEC.md and the repo's own doctrine.
  const numberedRows = [...spec.rows, ...(doctrine?.repo?.rows ?? [])];
  const ids = {};
  const rows = [];
  const allocate = () => {
    const id = nextRowId(prefix, numberedRows);
    numberedRows.push({ id });
    return id;
  };
  for (const rule of blueprint.rules) {
    const text = ruleText(rule);
    if (byText.has(text)) { ids[rule.key] = byText.get(text); continue; }
    if (marked) continue;
    const id = allocate();
    ids[rule.key] = id;
    rows.push({ key: rule.key, id, status: 'draft', text, line: `- ${id} [draft, ${rule.tier}] ${text} | gate: ${rule.gate}` });
  }
  for (const question of blueprint.questions) {
    const asked = askedIds.get(question.ask.trim());
    if (asked) { ids[question.key] = asked; continue; }
    if (marked) continue;
    const id = allocate();
    const text = questionText(question);
    ids[question.key] = id;
    rows.push({ key: question.key, id, status: 'pending', text, line: `- ${id} [pending, must] ${text} | gate: review` });
  }
  const titles = new Set(itemTitles);
  const items = marked ? [] : blueprint.items.filter((item) => !titles.has(item.title.trim())).map((item) => ({
    key: item.key, title: item.title.trim(), specIds: item.cites.map((cited) => ids[cited]).filter(Boolean), after: item.after,
    ...(item.lane ? { lane: item.lane } : {}), route: item.route, criterion: item.criterion, brief: item.brief,
  }));
  const rowLines = rows.map((row) => row.line);
  // Rows first, marker last: the caller writes specRows, adds the items, then writes specAfter, so a
  // failure part way leaves no marker and a retry adds what is missing.
  const specRows = marked || !rows.length ? source : insertSection(source, spec, { existing, name, lines: rowLines });
  const specAfter = marked ? source : insertSection(source, spec, { existing, name, lines: [...rowLines, marker] });
  return { marked, section: { prefix, name, isNew: !existing }, rows, specRows, specAfter, ids, items, gate: !gate?.trim() && blueprint.gate ? blueprint.gate : null };
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
