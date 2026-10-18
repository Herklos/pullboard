/**
 * The Roadmap's blocked mark (N26, #605). An item that cannot move on its own, because it waits on an
 * item that is not verified or its lane is held, gets a small red dot, and its row unfolds in place to
 * say why. Everything here comes from the board summaries the page already holds, so the unfolded row
 * needs no detail request.
 */

/**
 * A compact detail for every roadmap item, with an optional mark when it cannot move on its own.
 *
 * The page embeds this function's source, so it reads nothing outside itself, its own escaping
 * included; the page passes in the item lookup, agent names and item addresses it already uses.
 *
 * @param {{id: number, status: string, lane?: string, blockedBy?: number[], claim?: {by?: string|null}|null, builtBy?: string|null, verdict?: {decision?: string, note?: string}|null}|null} item
 * @param {{holds?: {hold_lane: string, hold_reason?: string}[], items?: {id: number, title?: string, status: string}[], name?: (id: string) => string, address?: (id: number) => string, board?: string|null}} context
 * @returns {{label: string, dot: string, detail: string}|null} The dot, its accessible label and the unfolded detail.
 */
export function roadmapBlock(item, context = {}) {
  if (!item) return null;
  const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const statusOf = (id) => (context.items || []).find((other) => other.id === id)?.status || 'not on this board';
  const waits = (item.blockedBy || []).map((id) => ({ id, status: statusOf(id) }));
  const hold = (context.holds || []).find((h) => h.hold_lane === item.lane) || null;
  const blocked = item.status === 'open' && Boolean(waits.length || hold);
  const parts = waits.map((w) => '#' + w.id + ' (' + w.status + ')');
  const label = !blocked ? '' : 'Blocked: ' + [parts.length ? 'waits on ' + parts.join(', ') : '', hold ? 'lane ' + item.lane + ' held' : ''].filter(Boolean).join('; ');
  const name = context.name || ((id) => id);
  // Only a live claim holds an item; a sent-back item's past builder holds nothing (#605 review).
  const holder = item.claim?.by || null;
  // A send-back note's first line, the way the Items list shows it.
  const sentBack = item.verdict && item.verdict.decision === 'REJECT' && item.verdict.note ? String(item.verdict.note).split('\n')[0].trim() : '';
  const address = context.address || ((id) => '#items/' + id);
  const rows = [
    '<dt>state</dt><dd>' + escape(item.status) + (holder ? ', held by ' + escape(name(holder)) : ', nobody holds it') + '</dd>',
    waits.length ? '<dt>waits on</dt><dd>' + waits.map((w) => '#' + w.id + ' <span class="block-state">' + escape(w.status) + '</span>').join(', ') + '</dd>' : '',
    hold ? '<dt>lane held</dt><dd>' + escape(item.lane) + (hold.hold_reason ? ': ' + escape(hold.hold_reason) : '') + '</dd>' : '',
    sentBack ? '<dt>sent back</dt><dd>' + escape(sentBack) + '</dd>' : '',
  ].join('');
  return {
    label,
    dot: !blocked ? '' : '<span class="block-dot" role="img" aria-label="' + escape(label) + '" title="' + escape(label) + '"></span>',
    detail: '<dl class="kv">' + rows + '</dl><a class="ref" href="' + escape(address(item.id)) + '" data-go="item:' + item.id + '"' + (context.board ? ' data-board="' + escape(context.board) + '"' : '') + '>Open #' + item.id + ' in Items</a>',
  };
}
