/** Read milestone references across the boards registered on this machine. */
import {
  basename,
  resolve,
  join,
} from 'node:path';
import {
  closeBoard,
  getItem,
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
        return { id: reference, title: item.item_title, status: item.item_status };
      } finally {
        if (other !== board) closeBoard(other);
      }
    } catch {
      return options.hideOutOfScope ? hidden() : { id: reference, title: `#${number} (${repo})`, status: 'unavailable' };
    }
  };
  return roadmap(board, resolveExternal);
}
