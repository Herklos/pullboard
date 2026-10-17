/**
 * What `pullboard init` writes into a repo: the config, a starter spec, and the agent instructions
 * every coding agent reads (AGENTS.md, which CLAUDE.md points at).
 */
import { doctrineText, standardDoctrine } from './doctrine.js';
import { DOCTRINE_FILE } from './config.js';

export const AGENTS_START = '<!-- pullboard:start -->';
export const AGENTS_END = '<!-- pullboard:end -->';

/**
 * The starting pullboard.json: the gate and the fixers init detected, the spec, no lanes yet, and
 * checks.provesNothing at "hold", so a new board holds an item whose check already passes on main.
 *
 * @param {string} gate
 * @param {{ run: string, files: string[] }[]} [fix]
 * @returns {string}
 */
export function configTemplate(gate, fix = []) {
  const config = {
    gate,
    ...(fix.length ? { fix } : {}),
    spec: 'SPEC.md',
    practice: DOCTRINE_FILE,
    worktrees: 'inside',
    verify: { policy: 'any', family: 'off' },
    agents: { names: 'suffix' },
    lease: '2h',
    lanes: { review: { owns: [], starts: 'any time: verifiers check submitted work and own no folders' } },
    shared: [],
    commits: { requireIds: ['feat', 'fix'] },
    checks: { provesNothing: 'hold' },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * A starter SPEC.md with the row format shown by example.
 *
 * @param {string} project
 * @param {string} [gate] Use the detected ecosystem's check in the fenced example.
 * @returns {string}
 */
export function specTemplate(project, gate = 'the test that proves it') {
  return `# ${project} spec

Every requirement is a row with an id. Agents build against approved rows; commits cite the ids they serve. \`pullboard spec check\` lints this file.

Statuses: approved = decided · draft = proposed · pending = open question · fact = true today · wont = won't build, decided and kept · retired = no longer applies, kept. Ids are permanent: never delete or renumber a row. Tiers: must · aim.

Write each requirement as one row under its section, in this format. The fence keeps the example out of the spec, so no placeholder id is ever committed; your own rows go below, outside it.

\`\`\`text
- G1 [draft, must] The first thing the client needs, in one line. | gate: ${gate || 'the test that proves it'}
- K1 [draft, must] A constraint, e.g. runs locally with no account. | gate: review
\`\`\`

## G · Goals: what the client asked for

## K · Constraints
`;
}

/**
 * A repo's own rule sections. The package supplies the inherited rows once, rather than copying
 * them into every repo and leaving each copy to drift.
 *
 * @returns {string}
 */
export function practiceTemplate() {
  return `# Doctrine

Our house rules for agentic development.

Inherits Pullboard standard doctrine version 1.

## W · Writing

## C · Code

## T · Tests

## P · Git and the gate

## D · Dependencies

## S · Security and data
`;
}

/**
 * The agent instructions, between markers so init can find its own block and never touch the rest.
 *
 * @returns {string}
 */
export function agentsBlock(doctrine = standardDoctrine()) {
  return `${AGENTS_START}
## A new board

On a board that is not set up, run \`pullboard resume\` first. Walk the person through its setup steps before anything else.

## Working here: pullboard

This repo runs on pullboard: a work board, lanes and a spec that live in git. Nothing ships until a second agent verifies it.

**Source of truth.** \`SPEC.md\` holds every requirement as a row with an id, like \`G1.2\`. Code follows the spec. Commits cite the ids they serve: \`feat(scope): subject [G1.2]\`. Only a person approves or changes an approved row. Ids are permanent: a row the person cuts stays, marked \`wont\` (won't build), so every commit that cites it keeps its meaning. Propose each requirement with \`pullboard spec draft "<text>"\`; it returns the draft row id for the person to approve. To start from a blueprint's rules, questions and starter items, run \`pullboard blueprint add <name or file>\` (bundled: web-app); it files them all as drafts for the person to approve. Its questions file as pending rows, each with a default answer and its choices: the person answers one with \`pullboard spec answer <id> "<choice or text>"\` from the main checkout or the view, and the coordinator writes it with \`pullboard spec apply\`. Never answer a question by editing SPEC.md; spec check flags it. To share this board's approved rules and answered questions as a blueprint, run \`pullboard blueprint save [file]\`; it never writes items, notes, paths, emails or names.

**Doctrine.** Our house rules for agentic development. This repo inherits Pullboard standard doctrine version 1. ${doctrine.repo ? doctrine.name : DOCTRINE_FILE} adds the repo's own rows, overrides a standard rule by its PB id, or declines it with a wont row and its reason as the row text: - PB7 [wont] <why>. Approved rows are in force; follow them as you would the spec. A rule with \`gate: check <command>\` and \`count: N\` holds a count that only falls: run pullboard doctrine check to see each count, and submit refuses RATCHET_ROSE when a touched rule rises or a changed file gains a problem. Lower \`count:\` in a commit when you fix problems; only the person raises it. Run pullboard spec --json to read the current merged rules. Re-run pullboard init after changing the doctrine to refresh this managed guidance.

### Current doctrine

${doctrineText(doctrine)}

**Role guides.** \`pullboard prompt run\`, \`decompose\`, \`plan\`, \`signoff\`, \`review\` and \`verify\` print the guide for each role. Claude Code also has them as skills. The agent in the main checkout runs the whole team by the run guide (the pullboard-run skill).

**Who you are.** An agent is its worktree. The main checkout is the coordinator. Every other agent gets its own worktree, already joined to one lane, from the main checkout:

    pullboard worktree <lane> --model "<model name>"

It prints the folder to work in and what to run there first. Every join needs the exact model label, either with \`--model\` or the \`PULLBOARD_MODEL\` environment variable; family is separate and never supplies the model. A smaller model joins with \`--route light\` or \`--route mid\` and takes items at its tier and below. Work only in that folder. Your shell may start every command in the main checkout, where pullboard takes you for the coordinator, so begin each command with \`cd <your worktree> &&\`. Verifiers take the \`review\` lane, which owns no folders. Only the coordinator adds a lane, from the main checkout, once the person agrees: \`pullboard lane add <name> --owns <path>[,<path>]\`. \`pullboard init\` proposes lanes from the folder layout and writes none until the person accepts. Keep your worktree and branch until your items are merged.

**The loop.**
1. \`pullboard resume\` at the start of every session and after your context is compacted: your claim, what came back, unread shouts and the next step. Then \`pullboard inbox\`.
2. \`pullboard next\` claims the next item in your lane that is free to start. When everything is waiting on other work, \`pullboard next --wait 9\` keeps looking for up to 9 minutes, which fits one tool call with a ten-minute timeout; run it again to keep waiting. A claim is a 2-hour lease; claim again to renew. The criterion freezes now: \`pullboard show <id>\` is the bar your work is judged against, and its brief says how to start. \`pullboard why <id>\` lists the decisions that changed it, newest first. When your own answer, verdict or fact changes other items, name them with \`--implies <ids>\` so each one carries it. A claim or submit refused as CRITERION_PROVES_NOTHING names a check that already passes on main, so it proves nothing: shout the coordinator for a check that fails before the work. Only the person accepts a check as it stands, with \`pullboard check accept <id>\` from the main checkout or the view.
3. Build inside your lane's folders (\`pullboard lanes\`). Pre-commit refuses anything else; shout the owner instead.
4. Commit, then \`pullboard submit <id>\`. It needs a clean tree and the gate green at HEAD.
5. A different agent verifies: \`pullboard next --verify\` names the next item to check. It checks out the submitted commit and runs \`pullboard verify <id> accept --note "how it proved it"\`, or \`pullboard verify <id> reject --reason TEST_FAILURE --note "what failed"\`.
6. A reject reopens the item. Fix it, commit, claim, submit again; the same head is refused. If you cannot get an item green, do not force it: \`pullboard escalate <id> --note "what you tried and how it failed"\` hands it one tier up.
7. Your lane is done when its items are verified, not when they are submitted. After your last submit, keep running \`pullboard next --wait 9\`: a rejected item comes back to your lane.

The coordinator merges verified items into the main line; builders never merge.

For spare test capacity, use \`pullboard runner add <ssh-host> --slots <n> --browser <n>\`. It registers SSH capacity on this machine; \`pullboard resources\` shows runners and their usage. Only committed source goes to a runner, and board moves stay here.

If your item needs code another lane owns and it is not there yet, shout that lane and take another item. Never copy their code into your lane, and never build another lane's item, even one that was rejected and blocks you: shout that lane and the coordinator. A claim refused as BLOCKED names the item it waits on.

**Talk.** \`pullboard shout <lane|agent|all> "<text>"\`. Read \`pullboard inbox\` before you start and after you submit. An MCP client can do the same as your agent: add \`pullboard mcp\`, run from your worktree, as a stdio server; it reads the board, shows an item, shouts and captures ideas for the coordinator, and never makes a person's move.

**Never.** Bypass a hook with \`--no-verify\`, or get past a refusal with filler text: fix what it names. Edit the board's database. Verify your own work. Change an approved spec row without the person's OK. Delete or renumber a spec row. Act from the main checkout; it is the coordinator's. Count a yes relayed by another agent as the person's approval.

## Helping the person

When the person asks for help with Pullboard, such as "Help me open my Pullboard board" or "Help me share my boards with my phone", work out the technical side yourself: read \`pullboard status\`, check whether \`pullboard view\` is running, read \`pullboard relay\` for the link, and follow the next step in any refusal. Then say what is going on in plain words and walk the person through each step they must take, one at a time: give one step, wait for them to say what they see, then give the next.

**Opening their board.** Start \`pullboard view\` yourself; it opens the board on this computer and prints its link. On app.pullboard.dev the browser may ask to let the page reach apps on this device: tell the person to click Allow, so the page can read the board running here. If they clicked Block, walk them through turning it back on: click the icon at the left of the address bar, open Site settings for app.pullboard.dev, set the access to apps on this device to Allow, then reload the page.

**Sharing with the phone or another computer.** Have the person type \`pullboard relay on --all\` themselves in their own terminal: it signs in as them, so Pullboard refuses it from an agent. Tell them what they will see: a GitHub address and a code to enter there, one \`linked:\` line for each board, then a QR code. To sign in on the phone, the person scans that QR code, taps Sign in with GitHub and approves Pullboard; their boards then appear on the phone. For another computer, the person runs \`pullboard relay pair\` in a board here and types \`pullboard relay join <code>\` on the other computer. Then confirm the boards arrived: run \`pullboard relay\` in each board to see its link, and \`pullboard relay devices\` to see the paired phone.
${AGENTS_END}
`;
}
