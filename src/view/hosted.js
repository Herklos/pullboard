/**
 * The hosted page's states at https://app.pullboard.dev [N26,H5]. Each state is a heading, one line on what it
 * means and the one next step, and a short "Ways in" panel lists every route to a board in plain words.
 * hostedMarkup builds the panel on the server; hostedState, hostedBrowser and drawHosted run in the page, which
 * inlines them by their source, so each reads nothing beyond its own arguments.
 */

/** The routes to a board, as the Ways in panel lists them: a title, then one line with its commands. */
const WAYS_IN = [
  ['The local view', 'Run <code>pullboard view</code> on the computer that holds your boards. It opens them in a browser tab.'],
  ['This computer through pullboard.dev', 'While <code>pullboard view</code> runs, this page opens the same boards, and their data stays on this computer.'],
  ['Your phone and other devices', 'Run <code>pullboard relay on --all</code> to link your boards, then scan the QR it prints and sign in.'],
  ['A second computer', 'Run <code>pullboard relay pair</code> on this one, then <code>pullboard relay join &lt;code&gt;</code> on the other.'],
];

/**
 * The hosted panel's markup: the state card, with its heading, line, command and buttons, and the Ways in panel.
 * The ids are the ones the page always had (local-note, local-note-text, local-note-links, local-note-view,
 * local-note-sign-in, local-note-retry), so what reads them keeps working.
 *
 * @param {string} localView - The local view's address, the default the page links before it knows another.
 * @returns {string}
 */
export function hostedMarkup(localView) {
  const ways = WAYS_IN.map(([title, line], n) => `<div class="way"><dt>${title}</dt><dd>${line}${n === 2 ? ' <a class="ghost" id="local-note-sign-in" hidden>Sign in with GitHub</a>' : ''}</dd></div>`).join('');
  return `<section class="hosted" id="local-note" role="status" hidden>
    <div class="card-panel hosted-card"><h2 id="local-note-title"></h2><p id="local-note-text"></p>
    <div class="hosted-cmd" id="local-note-cmd" hidden><code id="local-note-code"></code><button class="ghost" id="local-note-copy" type="button">Copy</button></div><p class="hosted-hint" id="local-note-hint" hidden></p>
    <p class="hosted-step" id="local-note-links" hidden><a class="go" id="local-note-view" href="${localView}/local/view" hidden>Open the local view</a><a class="go" id="local-note-go" hidden>Sign in with GitHub</a><button class="go" id="local-note-retry" type="button" hidden>Try again</button></p></div>
    <section class="card-panel hosted-ways" id="ways-in" aria-labelledby="ways-in-title" hidden><h2 id="ways-in-title">Ways in</h2><dl>${ways}</dl></section>
  </section>`;
}

/**
 * Name the browser the page runs in, for the step that lifts its block. Only Chromium browsers answer the
 * local network permission the page asks about, so they are the ones a block is ever reported from.
 *
 * @param {{userAgent?: string, userAgentData?: {brands?: {brand: string}[]}}} agent - The page's navigator.
 * @returns {string}
 */
export function hostedBrowser(agent) {
  const brands = (agent?.userAgentData?.brands || []).map((entry) => entry.brand).join(' ');
  const said = brands + ' ' + (agent?.userAgent || '');
  if (/Edge|Edg\//.test(said)) return 'Edge';
  if (/Opera|OPR\//.test(said)) return 'Opera';
  if (/Chrom/.test(said)) return 'Chrome';
  if (/Firefox\//.test(said)) return 'Firefox';
  if (/Safari\//.test(said)) return 'Safari';
  return 'This browser';
}

/**
 * What the hosted page says in one state, or null for none. A "state" stands in for the board; a "note" sits
 * over a list that shows; "wait" is the line on screen while the browser may ask its question.
 *
 * @param {string|null} state - asking, not-running, blocked, mismatch, problem, signed-out, no-linked, unpaired, linked-failed or local-failed.
 * @param {{browser?: string, linked?: string[], detail?: string}} [facts] - The browser's name, the linked boards this browser cannot open, and a refusal's own words.
 * @returns {null|{state: string, kind: string, heading: string, text: string, hint?: string, command?: string, button?: string, side?: string}}
 */
export function hostedState(state, facts = {}) {
  const browser = facts.browser || 'This browser';
  const linked = facts.linked || [];
  const chromium = ['Chrome', 'Edge', 'Opera'].includes(browser);
  const models = {
    'asking': { kind: 'wait', heading: 'Looking for Pullboard on this computer', text: 'Your browser may ask to let this page reach apps on this device. Allow it to open the boards running here.' },
    'not-running': { kind: 'state', heading: 'Start Pullboard on this computer', text: 'This page cannot reach a local view on this computer. Run this in a terminal, then try again.', command: 'pullboard view', hint: 'A Pullboard older than 0.8.29 cannot answer this page, so update it first with `npm i -g pullboard`.', button: 'retry', side: 'Boards on this computer show here once pullboard view runs.', offline: 'not connected' },
    'blocked': { kind: 'state', heading: 'Let this page reach Pullboard', text: browser + ' has refused this page access to apps on this device, so it cannot open the board running here.',
      hint: chromium ? 'In ' + browser + ', click the icon at the left of the address bar, turn on Local network access, then try again.' : 'Allow this site to reach apps on this device in the browser\'s site settings, then try again.',
      button: 'retry', side: 'Boards on this computer show here once ' + (browser === 'This browser' ? 'the browser' : browser) + ' allows it.', offline: 'not connected' },
    'mismatch': { kind: 'state', heading: 'Update Pullboard on this computer', text: 'The Pullboard view running here does not match this page. Update Pullboard, restart pullboard view, then try again.', command: 'npm i -g pullboard', button: 'retry', side: 'Boards on this computer show here once the versions match.', offline: 'not connected' },
    'problem': { kind: 'state', heading: 'Open the local view', text: facts.detail || 'This page could not take the connection the local view sent back.', button: 'view', side: 'Boards on this computer show in the local view.', offline: 'not connected' },
    'signed-out': { kind: 'state', heading: 'Sign in to pair this browser', text: 'This link pairs this browser with your boards. Sign in with GitHub to finish, and they open here.', button: 'sign-in', side: 'Your linked boards show here after you sign in.', offline: 'not signed in' },
    'no-linked': { kind: 'state', heading: 'No linked boards yet', text: 'Your account has no linked boards. Link them from the computer that runs them:', command: 'pullboard relay on --all', side: 'Linked boards show here.' },
    'unpaired': { kind: 'state', heading: 'Pair this browser', text: 'You are signed in, and your account has ' + (linked.length === 1 ? 'a linked board: ' : 'linked boards: ') + linked.join(', ') + '. Each browser pairs once before it can read ' + (linked.length === 1 ? 'it' : 'them') + '. On the computer that linked ' + (linked.length === 1 ? 'it' : 'them') + ', run this, then open the link it prints here or scan its QR:', command: 'pullboard relay on --all',
      side: linked.length + (linked.length === 1 ? ' linked board waits' : ' linked boards wait') + ' for this browser to pair.' },
    'linked-failed': { kind: 'note', heading: 'Linked boards did not load', text: facts.detail || 'The relay did not answer.', button: 'retry' },
    'local-failed': { kind: 'note', heading: 'This computer\'s boards did not load', text: facts.detail || 'The local view did not answer.', button: 'retry' },
  };
  const model = state ? models[state] : null;
  return model ? { state, ...model } : null;
}

/**
 * Draw one hosted state into the page, or clear it with null. A state stands in for the board, so it brings the
 * Ways in panel and a line in the empty sidebar, and the relay's own banner steps aside while it speaks for it.
 *
 * @param {Document} doc - The page.
 * @param {ReturnType<typeof hostedState>} model - What to show.
 * @param {{view: string, signIn: string|null, session: boolean}} place - The local view's address, the sign-in path and whether the person is signed in.
 */
export function drawHosted(doc, model, place) {
  const $ = (id) => doc.getElementById(id);
  const full = Boolean(model && model.kind === 'state');
  const note = $('local-note');
  note.hidden = !model;
  note.dataset.state = model ? model.state : '';
  doc.body.classList.toggle('hosted-state', full);
  $('local-note-title').textContent = model ? model.heading : '';
  $('local-note-text').textContent = model ? model.text : '';
  $('local-note-hint').hidden = !model?.hint;
  // A command in a hint, between backticks, is code that never breaks across lines.
  $('local-note-hint').replaceChildren(...String(model?.hint || '').split('`').map((part, n) => {
    if (n % 2 === 0) return doc.createTextNode(part);
    const code = doc.createElement('code');
    code.textContent = part;
    return code;
  }));
  if (full && model.offline) $('live').textContent = model.offline;
  $('local-note-cmd').hidden = !model?.command;
  $('local-note-code').textContent = model?.command || '';
  const copy = $('local-note-copy');
  copy.textContent = 'Copy';
  copy.onclick = () => navigator.clipboard?.writeText(model.command).then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Select and copy'; });
  const button = model?.button;
  $('local-note-links').hidden = !button;
  $('local-note-view').hidden = button !== 'view';
  $('local-note-view').href = place.view + '/local/view';
  $('local-note-go').hidden = button !== 'sign-in' || !place.signIn;
  $('local-note-retry').hidden = button !== 'retry';
  $('local-note-sign-in').hidden = !place.signIn || place.session;
  for (const link of [$('local-note-go'), $('local-note-sign-in')]) if (place.signIn) link.href = place.signIn;
  $('ways-in').hidden = !full;
  $('side-hint').hidden = !full || !model.side;
  $('side-hint').textContent = full ? model.side || '' : '';
  // The relay's banner says what the state now says; it comes back when the state goes.
  const banner = $('relay-notice');
  if (banner && full && ['signed-out', 'no-linked', 'unpaired'].includes(model.state)) { banner.hidden = true; banner.dataset.hostedHid = '1'; }
  else if (banner && banner.dataset.hostedHid && !full) { banner.hidden = false; delete banner.dataset.hostedHid; }
}
