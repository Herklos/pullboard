/** Read milestone references across the boards registered on this machine. */
import {
  basename,
  resolve,
  join,
} from 'node:path';
import {
  closeBoard,
  getItem,
  events,
  laneHolds,
  listItems,
  openDecisions,
  PERSON,
  openBoard,
  roadmap,
} from './board.js';
import {
  codeIsFromMain,
  repoInfo,
} from './git.js';
import { listApiProjects } from './projects.js';

/** Resolve a repo-qualified milestone item against registered boards, optionally within an API scope.
 * @param {string} root
 * @param {any} board
 * @param {{ projects?: () => any[], hideOutOfScope?: boolean }} [options]
 * @returns {any[]}
 */
export function milestoneRoadmap(root, board, options = {}) {
  const projects = (options.projects ?? listApiProjects)();
  let hiddenExternal = 0;
  const externalItems = new Map();
  const hidden = () => ({ id: `external-${++hiddenExternal}`, title: 'External item', status: 'unavailable' });
  const resolveExternal = (reference) => {
    const match = /^(.+)#([1-9]\d*)$/.exec(reference);
    if (!match) return options.hideOutOfScope ? hidden() : { id: reference, title: reference, status: 'unavailable' };
    const [, repo, number] = match;
    const candidates = projects.filter((project) => project.name === repo || basename(project.root) === repo);
    if (candidates.length !== 1) return options.hideOutOfScope ? hidden() : { id: reference, title: `#${number} (${repo})`, status: 'unavailable' };
    try {
      const info = repoInfo(candidates[0].root);
      const other = resolve(candidates[0].root) === resolve(root)
        ? board
        : openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'), undefined, { isMain: codeIsFromMain() });
      try {
        const item = getItem(other, Number(number));
        externalItems.set(reference, { item, held: Boolean(item.item_hold_reason)
          || laneHolds(other).some(hold => hold.hold_lane === item.item_lane) });
        return { id: reference, title: item.item_title, status: item.item_status, landed: Boolean(item.item_merged_commit) };
      } finally {
        if (other !== board) closeBoard(other);
      }
    } catch {
      return options.hideOutOfScope ? hidden() : { id: reference, title: `#${number} (${repo})`, status: 'unavailable' };
    }
  };
  const milestones = roadmap(board, resolveExternal);
  const items = new Map(listItems(board, { all: true }).map(item => [item.item_id, item]));
  const holds = new Set(laneHolds(board).map(hold => hold.hold_lane));
  const now = board.clock.now().getTime();
  const pace = landingPace(board, items, now);
  const needsYou = personDecisionItems(board);
  return milestones.map(milestone => {
    const active = milestone.items.filter(entry => entry.status !== 'withdrawn');
    const summary = { total: active.length, left: active.length - milestone.landed,
      landed: 0, landing: 0, review: 0, building: 0, held: 0, waiting: 0,
      needsYou: active.filter(entry => typeof entry.id === 'number' && needsYou.has(entry.id)).map(entry => entry.id),
      pace: { ...pace }, estimate: null };
    for (const entry of active) {
      const local = typeof entry.id === 'number' ? items.get(entry.id) : null;
      const external = externalItems.get(entry.id);
      const item = local ?? external?.item;
      const held = local ? Boolean(local.item_hold_reason) || holds.has(local.item_lane) : external?.held;
      const state = entry.state === 'landed' ? 'landed'
        : entry.state === 'accepted' ? 'landing'
          : entry.status === 'submitted' ? 'review'
            : item?.item_status === 'claimed' && Date.parse(item.item_lease_until) > now ? 'building'
              : held ? 'held' : 'waiting';
      summary[state]++;
    }
    if (!milestone.shipped && pace.last6h >= 3) {
      const six = summary.left / (pace.last6h / 6);
      const two = pace.last2h ? summary.left / (pace.last2h / 2) : six;
      summary.estimate = { low: Math.round(Math.min(six, two) * 2) / 2,
        high: Math.round(Math.max(six, two) * 2) / 2 };
    }
    return { ...milestone, summary };
  });
}

/** Count distinct currently landed local items at their first recording of the current merge. */
function landingPace(board, items, now) {
  const first = new Map();
  for (const event of events(board)) {
    if (event.event_kind !== 'merged') continue;
    const item = items.get(event.item_id);
    if (item?.item_status !== 'verified' || !item.item_merged_commit || first.has(event.item_id)) continue;
    if (JSON.parse(event.event_detail).commit !== item.item_merged_commit) continue;
    first.set(event.item_id, Date.parse(event.event_at));
  }
  const times = [...first.values()].filter(at => at <= now);
  return { last6h: times.filter(at => at > now - 6 * 3_600_000).length,
    last2h: times.filter(at => at > now - 2 * 3_600_000).length };
}

/** Associate open person questions with typed item evidence and explicit local item references. */
function personDecisionItems(board) {
  const ids = new Set();
  for (const question of openDecisions(board, PERSON)) {
    if (question.shout_evidence_item) ids.add(question.shout_evidence_item);
    // A local token is separate from a URL or repo-qualified reference.
    for (const match of question.shout_text.matchAll(/(?:^|[\s([{"'`,;:!?])#([1-9]\d*)\b/gu)) {
      const id = Number(match[1]);
      if (Number.isSafeInteger(id)) ids.add(id);
    }
  }
  return ids;
}
