/**
 * Split one SVG that carries prefers-color-scheme blocks into the two files a README picture needs
 * (I10, I13). GitHub resolves a <picture> source from the reader's theme, while an SVG drawn with
 * its own media query follows the operating system instead, so each figure ships a light file and
 * a dark file and the README picks between them.
 *
 * The split keeps the cascade exact: the dark file is the same CSS a dark browser applies, with each
 * dark block unwrapped in place (later rules win, as they did under the media query), and the light
 * file is the same CSS a light browser applies, with the dark blocks removed.
 */

const DARK_BLOCK = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/gu;

/**
 * Find the brace that closes the block opened at `open`, so nested rules stay inside it.
 *
 * @param {string} svg the whole SVG text
 * @param {number} open the index of the `{` that opens the block
 * @returns {number} the index of the matching `}`
 */
function closingBrace(svg, open) {
  let depth = 0;
  for (let index = open; index < svg.length; index += 1) {
    if (svg[index] === '{') depth += 1;
    else if (svg[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error('A prefers-color-scheme block in the figure is not closed.');
}

/**
 * Rewrite every dark block in an SVG: keep its rules unwrapped, or drop them.
 *
 * @param {string} svg a figure as draw.mjs or tour-renderer.mjs returns it
 * @param {boolean} keep true to unwrap the dark rules, false to remove them
 * @returns {string} the SVG with its dark blocks rewritten
 */
function rewriteDarkBlocks(svg, keep) {
  const pattern = new RegExp(DARK_BLOCK.source, 'gu');
  let out = '';
  let last = 0;
  for (let match = pattern.exec(svg); match; match = pattern.exec(svg)) {
    const open = match.index + match[0].length - 1;
    const close = closingBrace(svg, open);
    out += svg.slice(last, match.index) + (keep ? svg.slice(open + 1, close) : '');
    last = close + 1;
    pattern.lastIndex = last;
  }
  return out + svg.slice(last);
}

/**
 * The light and dark files of one figure, so a <picture> can show each to its reader.
 *
 * @param {string} svg a figure with prefers-color-scheme blocks
 * @returns {{ light: string, dark: string }} the light file and the dark file
 */
export function themeVariants(svg) {
  return { light: rewriteDarkBlocks(svg, false), dark: rewriteDarkBlocks(svg, true) };
}
