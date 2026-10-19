/** One native snapshot with a small current presentation and separately addressed sealed history [H15,H17]. */
import { Refused } from './refused.js';
import { PAGE_FANOUT, pageReference, readSealedDescriptor, readSealedValue, writeSealedDescriptor, writeSealedValue } from './sealed-pages.js';

const FORMAT = 'pullboard-paged-snapshot/1';
const BATCH_BYTES = 131_072;
const encoder = new TextEncoder();
const DETAIL = new Set(['criterion', 'brief', 'verdicts', 'history', 'thread']);

/** Reject an authenticated but incompatible layout before installing any of its data. */
function invalid() { return new Refused('RELAY_SNAPSHOT', 'This paged board snapshot is invalid. Refresh it from a linked machine or upgrade Pullboard.'); }

/** Preserve the current item fields while making the existing cockpit request its omitted detail. */
function summary(item) { return Object.fromEntries(Object.entries(item).filter(([name]) => !DETAIL.has(name))); }

/** Match the local view's criteria search without making full item histories part of a search read. */
function searchText(item) { return ('#' + item.id + ' ' + item.title + ' ' + item.lane + ' ' + item.specs.join(' ') + ' ' + (item.criterion || '')).toLowerCase(); }

/** Validate the numeric keys used by an authenticated history range. */
function keyOf(row, field, ordinal) {
  const key = field ? row?.[field] : ordinal;
  if (!Number.isSafeInteger(key) || key < 0) throw invalid();
  return key;
}

/** Write stable row batches and bounded range directories; the native table order remains exact. */
async function writeRows(rows, field, context) {
  if (!Array.isArray(rows)) throw invalid();
  let previous = -1;
  const levels = [];
  /** Flush full directories upward without retaining an unbounded root list. */
  async function append(entry, level = 0) {
    if (level >= 32) throw invalid();
    const siblings = levels[level] ??= [];
    siblings.push(entry);
    if (siblings.length === PAGE_FANOUT) {
      levels[level] = [];
      await append(await directory(siblings), level + 1);
    }
  }
  /** Seal directory ranges and bind their refs through the codec's authenticated links. */
  async function directory(entries) {
    const value = { kind: 'rows', field, entries: entries.map(({ reference, ...range }) => range) };
    const reference = await writeSealedDescriptor(value, entries.map(entry => entry.reference), context);
    return { first: entries[0]?.first ?? 0, last: entries.at(-1)?.last ?? -1,
      count: entries.reduce((sum, entry) => sum + entry.count, 0), leaf: false, reference };
  }
  let batch = [], bytes = 0, first = 0, last = -1;
  /** Store one row batch; a single huge row still travels through bounded codec objects. */
  async function flush() {
    if (!batch.length) return;
    const reference = await writeSealedValue(batch, context);
    await append({ first, last, count: batch.length, leaf: true, reference });
    batch = []; bytes = 0;
  }
  for (const [ordinal, row] of rows.entries()) {
    const key = keyOf(row, field, ordinal);
    if (key <= previous) throw invalid();
    previous = key;
    const size = encoder.encode(JSON.stringify(row)).byteLength;
    if (batch.length && (bytes + size > BATCH_BYTES || batch.length === PAGE_FANOUT)) await flush();
    if (!batch.length) first = key;
    batch.push(row); bytes += size; last = key;
  }
  await flush();
  let highest = levels.length - 1;
  while (highest >= 0 && !levels[highest]?.length) highest -= 1;
  let tail = null;
  for (let level = 0; level <= highest; level += 1) {
    const entries = [...(levels[level] ?? []), ...(tail ? [tail] : [])];
    if (!entries.length) continue;
    tail = await directory(entries);
  }
  return (tail ?? await directory([])).reference;
}

/** Validate and bind every range to its encrypted child before a consumer follows that child. */
async function rowDirectory(reference, context, field) {
  const { value, links } = await readSealedDescriptor(reference, context);
  if (value?.kind !== 'rows' || value.field !== field || !Array.isArray(value.entries) || value.entries.length !== links.length) throw invalid();
  let previous = -1;
  const entries = value.entries.map((range, index) => {
    if (!range || !Number.isSafeInteger(range.first) || range.first <= previous || !Number.isSafeInteger(range.last) ||
        range.last < range.first || !Number.isSafeInteger(range.count) || range.count < 1 || typeof range.leaf !== 'boolean') throw invalid();
    previous = range.last;
    return { ...range, reference: pageReference(links[index]) };
  });
  return entries;
}

/** Read only selected numeric ranges; whole-table restore and point lookup use the same authenticated walk. */
async function* readRows(reference, field, context, target = null, depth = 0) {
  if (depth >= 32 || (context.parents ?? []).includes(reference.id)) throw invalid();
  const entries = await rowDirectory(reference, context, field);
  const childContext = { ...context, parents: [...(context.parents ?? []), reference.id] };
  for (const entry of entries) {
    if (target !== null && (target < entry.first || target > entry.last)) continue;
    let count = 0;
    if (entry.leaf) {
      const rows = await readSealedValue(entry.reference, childContext);
      if (!Array.isArray(rows) || rows.length !== entry.count) throw invalid();
      let previous = entry.first - 1;
      for (const [ordinal, row] of rows.entries()) {
        const key = keyOf(row, field, entry.first + ordinal);
        if (key <= previous || key > entry.last || (ordinal === 0 && key !== entry.first) || (ordinal === rows.length - 1 && key !== entry.last)) throw invalid();
        previous = key; count++;
        if (target === null || target === key) yield row;
      }
    } else {
      for await (const row of readRows(entry.reference, field, childContext, target, depth + 1)) { count++; yield row; }
    }
    if (target === null && count !== entry.count) throw invalid();
  }
}

/** Seal native tables once, current summaries separately, and detail/search indexes for on-demand phone reads. */
export async function writePagedSnapshot(document, context) {
  const tables = document?.tables;
  const state = document?.presentation?.state;
  const meta = new Map((tables?.board_meta ?? []).map(row => [row.meta_key, row.meta_value]));
  const engine = Number(meta.get('relay_engine_version'));
  if (document?.version !== 1 || meta.get('board_id') !== context.boardId || !Number.isSafeInteger(engine) || engine < 1 ||
      String(context.sequence) !== meta.get('relay_applied_sequence') || !Array.isArray(state?.items) || !Array.isArray(tables.shout)) throw invalid();
  const names = Object.keys(tables);
  if (!names.length || names.length > PAGE_FANOUT - 4 || names.some(name => !/^[a-z][a-z0-9_]*$/u.test(name))) throw invalid();
  const boot = { ...document.presentation, state: { ...state, items: state.items.map(summary) } };
  delete boot.shouts;
  const references = [await writeSealedValue(boot, context)];
  for (const name of names) references.push(await writeRows(tables[name], name === 'shout' ? 'shout_id' : null, context));
  const items = [...state.items].sort((a, b) => a.id - b.id);
  references.push(await writeRows(items, 'id', context));
  references.push(await writeRows(items.map(item => ({ id: item.id, text: searchText(item) })), 'id', context));
  const answers = new Map();
  for (const row of tables.shout) if (row.shout_answers !== null && !answers.has(row.shout_answers)) answers.set(row.shout_answers, row.shout_id);
  references.push(await writeRows([...answers].sort(([a], [b]) => a - b).map(([id, answer]) => ({ id, answer })), 'id', context));
  return writeSealedDescriptor({ format: FORMAT, version: 1, boardId: context.boardId, sequence: context.sequence, engine, tables: names }, references, context);
}

/** Open a snapshot directory without requesting its unrelated historical children. */
export async function openPagedSnapshot(rawReference, context, { maxEngine } = {}) {
  const reference = pageReference(rawReference);
  const { value, links } = await readSealedDescriptor(reference, context);
  if (value?.format !== FORMAT || value.version !== 1 || value.boardId !== context.boardId || value.sequence !== context.sequence ||
      !Number.isSafeInteger(value.engine) || value.engine < 1 || !Number.isSafeInteger(maxEngine) || !Array.isArray(value.tables) ||
      value.tables.length + 4 !== links.length || new Set(value.tables).size !== value.tables.length ||
      value.tables.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/u.test(name))) throw invalid();
  if (value.engine > maxEngine) throw new Refused('ENGINE_VERSION', `This snapshot needs engine ${value.engine}; this device reads ${maxEngine}. Upgrade Pullboard before reading the board.`);
  const childContext = { ...context, parents: [...(context.parents ?? []), reference.id] };
  const tableReferences = new Map(value.tables.map((name, index) => [name, links[index + 1]]));
  const [details, search, answers] = links.slice(value.tables.length + 1);
  if (!tableReferences.has('board_meta') || !tableReferences.has('shout')) throw invalid();
  let current;
  /** Cache only the current presentation, not arbitrary historical pages. */
  async function presentation() { return current ??= await readSealedValue(links[0], childContext); }
  /** Resolve one keyed row without reading sibling history pages. */
  async function find(ref, field, id) {
    if (!Number.isSafeInteger(id) || id < 0) throw invalid();
    for await (const row of readRows(ref, field, childContext, id)) return row;
    return null;
  }
  /** Restore the complete importable native document, retaining counters and original row order. */
  async function native() {
    const tables = {};
    for (const [name, ref] of tableReferences) {
      tables[name] = [];
      for await (const row of readRows(ref, name === 'shout' ? 'shout_id' : null, childContext)) tables[name].push(row);
    }
    const boot = await presentation();
    const allItems = new Map();
    for await (const row of readRows(details, 'id', childContext)) allItems.set(row.id, row);
    const items = boot.state.items.map(item => { const full = allItems.get(item.id); if (!full) throw invalid(); return full; });
    return { version: 1, tables, presentation: { ...boot, state: { ...boot.state, items }, shouts: tables.shout } };
  }
  /** Search the dedicated criteria index only when the person enters a query. */
  async function searchItems(query) {
    const text = String(query).trim().toLowerCase();
    const ids = [];
    for await (const row of readRows(search, 'id', childContext)) {
      if (typeof row.text !== 'string') throw invalid();
      if (row.text.includes(text)) ids.push(row.id);
    }
    return ids;
  }
  /** Resolve addressed shout history and its first answer from separate authenticated ranges. */
  async function shout(id) {
    const found = await find(tableReferences.get('shout'), 'shout_id', id);
    if (!found) throw new Refused('NO_SHOUT', `no shout #${id}`);
    const answered = found.shout_decision ? await find(answers, 'id', id) : null;
    const answer = answered ? await find(tableReferences.get('shout'), 'shout_id', answered.answer) : null;
    if (answered && !answer) throw invalid();
    return { ...found, decision_state: found.shout_decision ? (answer ? 'answered' : 'open') : null, decision_answer: answer };
  }
  /** Return the existing cockpit's full item projection on demand. */
  async function item(id) {
    const found = await find(details, 'id', id);
    if (!found) throw new Refused('NO_ITEM', `no item #${id}`);
    return found;
  }
  return { version: 1, engine: value.engine, presentation, native, item, shout, searchItems };
}
