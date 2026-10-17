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

/**
 * Each of a blueprint's starter items and whether its add filed it on this board. An item is the
 * starter only when it carries the starter's title and cites exactly the rows this blueprint's add
 * gave the starter's keys, the same identity a resumed add uses to find starters already filed.
 * Why both: a title alone also names an unrelated item someone filed under the same words, and
 * that item must never be reported as the starter. A starter that cites no rows has no citation
 * to link it, so its item must also carry the starter's criterion, which add stores as written.
 * When several items match, a live one is named before a withdrawn one, then the oldest.
 *
 * @param {{ items: { key: string, title: string, cites?: string[], criterion?: string }[] }} blueprint
 * @param {Record<string, any>[]} items - Every item on the board, as store.listItems returns them.
 * @param {Record<string, string>} rowIds - Row id by rule or question key, from blueprintRowIds.
 * @returns {StarterState[]}
 */
export function starterStates(blueprint, items, rowIds) {
  return blueprint.items.map((starter) => {
    const title = starter.title.trim();
    const cites = starter.cites ?? [];
    const specIds = cites.map((key) => rowIds[key]).filter(Boolean).join(',');
    const linked = cites.length
      ? (item) => specIds.length > 0 && item.item_spec_ids === specIds
      : (item) => item.item_spec_ids === '' && item.item_criterion === (starter.criterion ?? '');
    const matches = items.filter((item) => item.item_title === title && linked(item))
      .sort((a, b) => Number(a.item_status === 'withdrawn') - Number(b.item_status === 'withdrawn') || a.item_id - b.item_id);
    const found = matches[0];
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
