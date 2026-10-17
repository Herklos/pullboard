/**
 * Several blueprints in one init or blueprint add [S1,I1]: --blueprint repeats, and the blueprints
 * land in the order given. A board takes at most one product blueprint and one architecture
 * blueprint, one per deployable (research U110), and any number of practice and beyond-code ones.
 * A rule or question text two of them share is drafted once, by the first, and the later blueprint
 * cites that row. Every starter item keeps the name of the blueprint that filed it.
 */
import { readBlueprint } from './blueprints.js';
import { Refused } from './refused.js';

/**
 * The kinds a board takes one of, by the slot each fills. Why infrastructure fills the
 * architecture slot: the bundled serverless and data-pipeline blueprints say infrastructure today,
 * and #719 renames that kind to architecture, so both spellings name the same slot.
 */
const ONE_PER_BOARD = { product: 'product', infrastructure: 'architecture', architecture: 'architecture' };

/**
 * The slot a blueprint fills, product or architecture, or null for a kind a board takes any number of.
 *
 * @param {{ kind?: string }} blueprint
 * @returns {string | null}
 */
export function blueprintSlot(blueprint) {
  return ONE_PER_BOARD[blueprint.kind] ?? null;
}

/**
 * Read every named blueprint, in the order given, before anything is written, so an unknown name
 * or a clash leaves the repository as it was. The same blueprint version named twice is read once.
 * A second product or architecture blueprint is refused with BLUEPRINT_KIND_TAKEN naming both.
 *
 * @param {string[]} references - Bundled names or paths, as --blueprint gave them.
 * @param {string} cwd
 * @param {string} command - The command to name in the next step, such as "init".
 * @returns {{ reference: string, blueprint: import('./blueprints.js').Blueprint }[]}
 */
export function readBlueprints(references, cwd, command) {
  const read = [];
  for (const reference of references) {
    const blueprint = readBlueprint(reference, cwd);
    if (read.some((entry) => entry.blueprint.name === blueprint.name && entry.blueprint.version === blueprint.version)) continue;
    const slot = blueprintSlot(blueprint);
    const holder = slot && read.find((entry) => blueprintSlot(entry.blueprint) === slot);
    if (holder) {
      const keep = read.map((entry) => `--blueprint ${entry.reference}`).join(' ');
      throw new Refused('BLUEPRINT_KIND_TAKEN',
        `${holder.blueprint.name} and ${blueprint.name} are both ${slot} blueprints, and a board takes one ${slot} blueprint; keep one of them: pullboard ${command} ${keep}`,
        `name one ${slot} blueprint: pullboard ${command} ${keep}`);
    }
    read.push({ reference, blueprint });
  }
  return read;
}

/**
 * The result blueprint add gives for several blueprints: the first blueprint's own fields, as one
 * add gives them, with the rows, items, lanes and stored checks of all of them, and each one's own
 * summary in blueprints, in the order they landed.
 *
 * @param {any[]} added - Each blueprint's summary from its add, in order.
 * @returns {any}
 */
export function combinedSummary(added) {
  return { ...added[0], rows: added.flatMap((entry) => entry.rows), items: added.flatMap((entry) => entry.items),
    gate: added.find((entry) => entry.gate)?.gate ?? null, marked: added.every((entry) => entry.marked),
    proposedLanes: [...new Map(added.flatMap((entry) => entry.proposedLanes).map((lane) => [lane.name, lane])).values()],
    checksNotRun: added.flatMap((entry) => entry.checksNotRun), blueprints: added };
}

/**
 * What init's JSON result says about one blueprint it added.
 *
 * @param {any} added - The blueprint's summary from its add.
 * @returns {any}
 */
export function initBlueprintResult(added) {
  return { name: added.blueprint.name, title: added.blueprint.title, section: added.section, waiting: added.rows.length,
    items: added.items.length, gate: added.gate, checksNotRun: added.checksNotRun, shared: added.shared ?? [] };
}

/**
 * The line init and blueprint add print for rows a blueprint shares with one added before it:
 * the rows it cites from there instead of drafting them again. Empty when it shares none.
 *
 * @param {any} added - The blueprint's summary from its add.
 * @returns {string[]}
 */
export function sharedRowLines(added) {
  const shared = added.shared ?? [];
  if (!shared.length) return [];
  return [`${added.blueprint.name} shares ${shared.map((row) => row.id).join(', ')} with an earlier blueprint, so each is drafted once`];
}

/**
 * The note fact blueprint add records on each starter item it files, so the item keeps the name of
 * its blueprint: the blueprint's name and version and the starter's key, as JSON after a fixed
 * prefix. The text is the link #734 reads back with blueprint starters, so either reads the other.
 *
 * @param {{ name: string, version: number }} blueprint
 * @param {string} key - The starter's key in the blueprint.
 * @returns {string}
 */
export function blueprintStarterNote(blueprint, key) {
  return `blueprint starter: ${JSON.stringify({ blueprint: blueprint.name, version: blueprint.version, key })}`;
}
