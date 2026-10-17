/** What blueprint commands report back: a blueprint's starters on this board and the rows that wait [S1,I1]. */

/**
 * @typedef {object} StarterState
 * @property {string} key - The starter's key in the blueprint.
 * @property {string} title - The starter's title.
 * @property {boolean} filed - The blueprint's own add filed this starter on the board.
 * @property {number | null} id - The filed item's id, or null when it is not filed.
 * @property {string | null} status - The filed item's status, or null when it is not filed.
 */

/**
 * The row id each rule and question key of a blueprint got on this board, read from its SPEC.md
 * section. Blueprint add numbers the rules, then the questions, in blueprint order, as the first
 * rows of a section named after the blueprint's title; a row the person rewords or declines keeps
 * its id, so the positions still name the same keys. Empty when the blueprint has no section here.
 *
 * @param {{ title: string, rules: { key: string }[], questions: { key: string }[] }} blueprint
 * @param {{ sections: { name: string }[], rows: { id: string, section: string }[] }} spec - loadSpec's result.
 * @returns {Record<string, string>}
 */
export function blueprintRowIds(blueprint, spec) {
  const section = spec.sections.find((entry) => /^[A-Z][A-Z0-9]*\s*[·.:-]/u.test(entry.name)
    && entry.name.replace(/^[A-Z][A-Z0-9]*\s*[·.:-]\s*/u, '') === blueprint.title.trim());
  if (!section) return {};
  const rows = spec.rows.filter((row) => row.section === section.name);
  const keys = [...blueprint.rules, ...blueprint.questions].map((entry) => entry.key);
  return Object.fromEntries(keys.flatMap((key, index) => (rows[index] ? [[key, rows[index].id]] : [])));
}

/** The start of the note fact blueprint add records on each starter item it files. */
const STARTER_LINK = 'blueprint starter: ';

/**
 * The note fact text blueprint add records on a starter item it files: the blueprint's name and
 * version and the starter's key, as JSON after a fixed prefix. Why a fact: an item's title and
 * citations can repeat across blueprint versions and unrelated items, so the add itself records
 * which starter of which version this item is, and blueprint starters reads that record back.
 *
 * @param {{ name: string, version: number }} blueprint
 * @param {string} key - The starter's key in the blueprint.
 * @returns {string}
 */
export function starterLinkText(blueprint, key) {
  return `${STARTER_LINK}${JSON.stringify({ blueprint: blueprint.name, version: blueprint.version, key })}`;
}

/**
 * The starter link an item's thread records, or null when its add recorded none, as on an item
 * filed by hand or by an add from before links were recorded.
 *
 * @param {{ type: string, kind?: string, text?: string }[]} thread - The item's thread, from store.itemThread.
 * @returns {{ blueprint: string, version: number, key: string } | null}
 */
export function starterLink(thread) {
  for (const entry of thread) {
    if (entry.type !== 'fact' || entry.kind !== 'note' || !entry.text?.startsWith(STARTER_LINK)) continue;
    try {
      const link = JSON.parse(entry.text.slice(STARTER_LINK.length));
      if (typeof link?.blueprint === 'string' && Number.isInteger(link.version) && typeof link.key === 'string') return link;
    } catch (error) {
      // A note that only starts like a link is someone's own words; it links nothing.
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return null;
}

/**
 * Each of a blueprint's starter items and whether its add filed it on this board. An item is the
 * starter when the link its add recorded names this blueprint, this version and the starter's key.
 * An item with no recorded link at all, filed before adds recorded one, counts only when it carries
 * the starter's title and cites exactly the rows this blueprint's add gave the starter's keys, the
 * identity a resumed add uses; a starter that cites no rows must also match its criterion. That
 * fallback is used only when no linked item names the starter, and an item linked to another
 * blueprint, version or starter never counts. When several items match, a live one is named
 * before a withdrawn one, then the oldest.
 *
 * @param {{ name: string, version: number, items: { key: string, title: string, cites?: string[], criterion?: string }[] }} blueprint
 * @param {Record<string, any>[]} items - Every item on the board, as store.listItems returns them.
 * @param {Record<string, string>} rowIds - Row id by rule or question key, from blueprintRowIds.
 * @param {Map<number, { blueprint: string, version: number, key: string } | null>} links - Each item's recorded link, by item id.
 * @returns {StarterState[]}
 */
export function starterStates(blueprint, items, rowIds, links) {
  const order = (a, b) => Number(a.item_status === 'withdrawn') - Number(b.item_status === 'withdrawn') || a.item_id - b.item_id;
  return blueprint.items.map((starter) => {
    const title = starter.title.trim();
    const own = items.filter((item) => {
      const link = links.get(item.item_id);
      return link && link.blueprint === blueprint.name && link.version === blueprint.version && link.key === starter.key;
    });
    const cites = starter.cites ?? [];
    const specIds = cites.map((key) => rowIds[key]).filter(Boolean).join(',');
    const cited = cites.length
      ? (item) => specIds.length > 0 && item.item_spec_ids === specIds
      : (item) => item.item_spec_ids === '' && item.item_criterion === (starter.criterion ?? '');
    const unlinked = items.filter((item) => !links.get(item.item_id) && item.item_title === title && cited(item));
    const found = (own.length ? own : unlinked).sort(order)[0];
    const status = found?.item_status ?? null;
    return { key: starter.key, title, filed: Boolean(found), id: found?.item_id ?? null, status };
  });
}

/**
 * The lines pullboard blueprint starters prints: a heading with the count filed, then one line per
 * starter that names its item id and status when it is filed.
 *
 * @param {{ name: string, title: string, version: number }} blueprint
 * @param {StarterState[]} starters
 * @returns {string[]}
 */
export function starterLines(blueprint, starters) {
  const filed = starters.filter((starter) => starter.filed).length;
  const lines = [`${blueprint.title} (version ${blueprint.version}) has ${starters.length} starter ${starters.length === 1 ? 'item' : 'items'}; ${filed} filed on this board`];
  for (const starter of starters) {
    lines.push(starter.filed ? `  #${starter.id} ${starter.status}  ${starter.title}` : `  not filed  ${starter.title}`);
  }
  if (filed < starters.length) lines.push(`next: file the rest with pullboard blueprint add ${blueprint.name}`);
  return lines;
}

/**
 * Every row that waits for the person after init --blueprint: the blueprint's new rows in SPEC.md
 * and each doctrine row still draft or pending, such as a standard rule the repo inherits. Why the
 * doctrine rows: init writes the doctrine file too, and a pending rule there waits for the same
 * person, so a summary of the blueprint's rows alone hides one (the blueprint trial missed PB7).
 *
 * @param {{ id: string, status: string, text: string }[]} rows - The rows the blueprint added.
 * @param {{ rows: { id: string, status: string, text: string, file?: string }[] }} doctrine - loadDoctrine's result.
 * @param {string} specFile - The spec file's name, such as SPEC.md.
 * @returns {{ id: string, status: string, text: string, file: string }[]}
 */
export function waitingRows(rows, doctrine, specFile) {
  return [
    ...rows.map(({ id, status, text }) => ({ id, status, text, file: specFile })),
    ...doctrine.rows.filter((row) => ['draft', 'pending'].includes(row.status))
      .map(({ id, status, text, file }) => ({ id, status, text, file: file ?? 'doctrine' })),
  ];
}

/**
 * The lines init prints for the rows that wait: a count, then one line per row with its file.
 *
 * @param {{ id: string, status: string, text: string, file: string }[]} waiting
 * @returns {string[]}
 */
export function waitingRowLines(waiting) {
  if (!waiting.length) return [];
  return [`  ${waiting.length} ${waiting.length === 1 ? 'row waits' : 'rows wait'} for the person:`,
    ...waiting.map((row) => `    ${row.id} ${row.status}  ${row.text}  (${row.file})`)];
}
