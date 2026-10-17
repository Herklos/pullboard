/**
 * The hosted page's one star line [N26] (#727): "Like Pullboard? A GitHub star helps.", linking to the GitHub
 * repository. Why so quiet: the person asked for a star only from people who use the relay and never to be
 * annoying, so the line is one sentence under the board, shown only on pullboard.dev to a signed-in person with a
 * linked board, and gone for good on that device once dismissed. The local view, the CLI and MCP never carry it.
 */
import { readFileSync } from 'node:fs';

/** The line's words: a plain sentence, never an instruction. */
export const STAR_TEXT = 'Like Pullboard? A GitHub star helps.';

/** The page storage key that remembers a dismissal, beside the page's other pb. preferences. */
export const STAR_KEY = 'pb.star';

/**
 * The repository's web address, read from package.json's repository field so the link never goes stale.
 *
 * @returns {string}
 */
export function starRepository() {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const url = String(manifest.repository?.url || manifest.repository || '');
  return url.replace(/^git\+/u, '').replace(/\.git$/u, '');
}

/**
 * The line's markup, hidden until the page knows a signed-in person has a linked board.
 *
 * @returns {string}
 */
export function starMarkup() {
  const href = starRepository().replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
  return `<p class="star-line" id="star-line" hidden><a href="${href}" target="_blank" rel="noopener">${STAR_TEXT}</a>`
    + '<button class="star-dismiss" id="star-dismiss" type="button" aria-label="Dismiss the star line" title="Dismiss">×</button></p>';
}
