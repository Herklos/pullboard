# Changelog

Notable changes to Pullboard, for people using it. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.8.18] - 2026-10-14

### The board stays safe

Removing someone's write access on GitHub now stops their agents as well as them. A red submit no longer holds up the agent that made it.

### Fixed

- When a person loses write access to the repository, moves their agents make on a relay board are refused, as the person's own moves already were.
- Agent credentials from a different GitHub account are discarded instead of reused.
- While a red submit compares its failures with main, the same agent's shouts, facts and reads go through instead of waiting behind it, and the failed tests rerun side by side instead of one file at a time.

### Changed

- An item may carry files that came from its dependencies' own verified dependencies, not only from its direct dependencies.

## [0.8.17] - 2026-10-14

### An agent sets it up alone

Tell your agent "install Pullboard and set it up here". It runs init, carries on in the same session, and walks you through setup. A board with no build to prove, such as research or writing, still gets a gate.

### Added

- During setup, a board with no detected build is offered pullboard spec check as its gate, so setup can finish.

### Changed

- When an agent runs pullboard init, it is told to continue setup in the same session with pullboard resume. A person at a terminal still sees the new-session note.
- Init's last line says what it is for: "To commit Pullboard's files: git add -f -- …".
- The README's setup starts with the one sentence to give your agent; running it yourself is the second path.

## [0.8.16] - 2026-10-13

### Steadier views

pullboard view now has one address on your machine, and running it again reuses the view that is already open. On Node 24 it no longer stalls or crashes.

### Changed

- pullboard view listens on 127.0.0.1:4890 by default, and running it again reuses the view already there for every board on this machine. --port 0 still picks a free port, and --port N still wins.
- If another program holds port 4890, pullboard view says so and suggests --port.
- Setup's last step completes when your agent reuses a view that is already running.

### Fixed

- On Node 24, a connection that closes at the wrong moment no longer crashes pullboard view or its check for a running view.
- The note about what is new after an upgrade no longer stalls the view on Node 24.
- Opening a shout from its link no longer changes the card's layout.

## [0.8.15] - 2026-10-13

### Setup without snags

Your agent can now record your first requirements in one command, gets its terminal back when it opens the view, and help names every spec command and who runs it.

### Added

- pullboard spec draft "<text>" adds a pending requirement with the next free id, and setup names it as the way to record your answers.

### Changed

- pullboard help spec lists every spec command and says which are yours and which are the coordinator's.
- An agent that starts pullboard view gets the link and its terminal back; a person at a terminal still runs it in the foreground.

### Fixed

- Submitting a change to a test now also runs the checks that scan every test file, so they no longer fail only after landing.

## [0.8.14] - 2026-10-13

### Your agent sets it up

Run pullboard init, then ask your agent to set up Pullboard here. Whatever model it is, it now walks you through what you are building, your lanes, the command that proves the build, your first item, and opening the view.

### Added

- On a board that is not set up yet, pullboard resume walks any agent through setup one step at a time, phrased as what to ask you, and each step completes from the board's real state.
- pullboard init ends with one plain instruction, and the agent guide it writes starts with what to do on a new board.

### Fixed

- Pullboard's own tests no longer fail when Chrome still lists a tab it just closed, so its CI is green on Linux and macOS.

## [0.8.13] - 2026-10-12

### Replays hold still

A shared replay's Pause button stays where it is while you press it, and Pullboard's own checks now hold on Linux and macOS under load.

### Fixed

- In a static export's replay, the Pause button no longer shifts under your pointer as the replay runs, so a press lands on it.
- Pullboard's own tests keep waiting through a page navigation, run the three-replica relay check as two tests that each fit their time, and name the startup step when the local server is slow to start.

## [0.8.12] - 2026-10-12

### Your answer always lands

An answer you send in Pullboard View is recorded as your answer, even while your previous shout is still sending.

### Fixed

- Answering a question while your previous shout was still sending could drop your answer, or record it as a plain shout instead of your answer. The earlier send no longer clears what you wrote next.
- The replay controls stay in place at phone width when a scrollbar appears at the end of a replay.
- Tests that waited too long on a busy machine now say which step they were waiting on, and the hook-read lock test holds on macOS.

## [0.8.11] - 2026-10-12

### A proper first visit, safer releases

A brand-new project opens on a calm board, not a list of decisions, and a release can no longer publish anything main's CI did not pass.

### Changed

- On a new project, Pullboard View shows the starter house rules as defaults to review, not as decisions waiting for you. The tour's board is listed and marked demo, and New item defaults to the first building lane.
- The gate runs only the test files git tracks, so scratch copies and agent worktree folders in your repo can no longer fail it.
- A tagged release publishes to npm only when main's CI already passed that exact commit.

## [0.8.10] - 2026-10-11

### Accumulated judgement

The README now opens with what Pullboard is for: accumulated judgement for agents, and a figure of how it holds.

### Fixed

- A board read that still cannot get through after waiting says which board it was, that another process held it, and how long it waited, instead of a bare "database is locked".

## [0.8.9] - 2026-10-11

### 0.8.8 reaches npm

0.8.8 was tagged but never published: its publish gate failed when a git hook read the board while another process was writing it. 0.8.9 is everything in 0.8.8, plus that fix and a few more from the same night.

### Fixed

- A git hook that reads the board waits for another process to finish writing, up to the same ten seconds every other board connection waits, instead of failing at once with "database is locked".
- A request from your phone never moves the row you are reading in Pullboard View.
- An action only you may take, tried from an agent's terminal, is refused at once with "send it from the paired phone", even when the relay is slow to answer.

## [0.8.8] - 2026-10-11

Tagged but never published to npm; everything below ships in 0.8.9.

### Steadier CI, safer boards

A worktree's unmerged code can no longer upgrade the board everyone shares, from the CLI or from Pullboard View. CI now runs in shards and drops runs a newer push has replaced, and the clicks it caught going missing under load now land.

### Added

- A rejected commit can be submitted again, unchanged, after the coordinator corrects its bar and the builder refreezes it. This is engine 9: upgrade every linked device before using it.
- Through the relay, a shout's address opens even a shout older than the forty most recent.

### Changed

- CI splits each run into shards and cancels a run on main once a newer push replaces it.
- The README's board shots are retaken from the current view.

### Fixed

- An agent's worktree running newer code never migrates the shared board or its event log, and Pullboard View's server opens boards through the same guard.
- Item links work everywhere an item is named, and an exported snapshot keeps its addresses.
- Verdict notes keep their line breaks, and code in them stays literal.
- The Lanes panel stays inside its card at every width, including the Hold a lane form.
- A click on an item in the Pipeline view opens it even while the view redraws.
- The Spec tab's decline button keeps working through a refresh.
- The replay controls stay in place when a replay starts.

## [0.8.7] - 2026-10-11

### What you see first

Pullboard View opens on your work. The Items tab leads with your list, with the board's stats in one line above it. The Roadmap leads with the next release, keeps every upcoming one open, and has a panel for moving between them. Every tab, item, row and shout now has an address you can share, reload and come back to.

### Added

- Every tab, item, Spec row, Doctrine row and shout in Pullboard View has its own address. Open it directly, go back and forward, or reload and stay where you were.
- The Roadmap has a panel on the right that jumps to each release and shows how much of the next one is open, building, in review and done.
- `pullboard resume` says what is new since the checkout last ran, once for each release, and `resume --json` carries the same notes as `whatsNew`.
- The coordinator and every agent on the demo board declare their model.

### Changed

- The Items tab opens on the work. The stats take one line above the list, and that line opens and folds the full card. Times read like "3 h 34 min", and the card no longer lists every agent.
- `pullboard stats`, its JSON and the coordinator's resume give times in hours and minutes, and name at most three items before "+N more".
- The Items toolbar is one row: List or Pipeline, a Filter menu for what to show and which lane, and New item.
- The Roadmap leads with the next release and keeps every upcoming release open. Shipped releases fold away.
- Doctrine and Spec rows read like Items rows: two lines, with the full rule a click away.
- The README's board shots show the stats line, and its "What's next" lists only work that isn't built yet.
- The shipped skills teach every command in `pullboard help`, and a test keeps a new command from shipping untaught.

### Fixed

- Rows added in the same second list newest first, even when a commit lands while the view is reading.
- A late transport call is no longer counted as a refused write.

## [0.8.6] - 2026-10-11

### See the flow

Pullboard now tells you where work is waiting. The stats card and the coordinator's resume name the bottleneck and what would fix it, and a Pipeline view shows every item's stage at a glance.

### Added

- Pullboard View shows a stats card: the numbers `pullboard stats` reports, each stage's average time, each queue's size and oldest item, and the bottleneck with its recommended action, all read from the board.
- The Items tab has a Pipeline view: every item laid out by stage as one flow, with its own address.
- The agents panel lists each agent's credential without ever showing it, and revokes one from your paired phone.
- The pullboard-run skill has the coordinator tell you about a bottleneck in one sentence, asking for a decision only when the fix needs you.

### Changed

- When a submit's gate is red, it now says whether main shares the red. An inherited red names the spec row and the open item that owns it, and `pullboard next` offers that item first.
- The README shows the current board, with a screenshot of the Shouts tab.

### Fixed

- A sent-back reason reads once on Items rows and verdict cards.
- The stats card's counts agree in number ("1 agent", not "1 agents").

## [0.8.5] - 2026-10-10

### A prettier board

Pullboard View got a full design pass, so the board is cleaner and easier on the eyes. It's quicker to read at a glance, with what needs you up top and search in the top bar. It works in light or dark and feels right on a phone.

### Added

- `pullboard stats` measures the flow from the event log: build, review wait, review and merge wait times, each queue's size and oldest item, items added and merged per day, resubmits per merged item, and active agents by role and lane. It names the bottleneck and one recommended action.
- The coordinator's `pullboard resume` ends with one line when review backs up (average wait over an hour, or a submission unreviewed for three hours), naming the bottleneck and what would fix it.
- Every agent declares its model when it joins (`--model` or `PULLBOARD_MODEL`), and Pullboard View shows each agent with its model.
- The coordinator can return a submission without a verdict to fix its criterion: `pullboard reopen <id> --note "why"`.
- The coordinator can correct a claimed item's criterion or check without the holder releasing it; the holder adopts the correction with `pullboard refreeze <id>` and keeps its claim.
- `pullboard land` merges verified items in verdict order, gates the batch once, bisects a red to its culprit, and lands nothing on a flake until the test is fixed or you waive it.

### Changed

- `pullboard next` offers work in roadmap order, the next release first.
- `submit` refuses work stacked on an unverified item; `merged` refuses a commit that doesn't carry the item's work.
- Gate slots are machine-wide even with a private Pullboard home, and every full test run takes one.
- Every gate run records where its time went.
- `doctor` and `resume` say when the repo's hooks aren't wired.
- A repo's skills follow Pullboard upgrades and never replace ones you edited.
- Boards use engine 8. Upgrade every linked device; a 0.8.4 device stops at the first new record and says to upgrade.

### Fixed

- An expired relay sign-in never blocks local work, and `relay off` stays off.
- No single agent token can halt relay replay for good.
- `refreeze` picks up a lane change made after the claim.
- Claiming an item whose spec rows are on main but not yet in your worktree fast-forwards a clean worktree, or refuses with SPEC_BEHIND_MAIN naming the rows and the merge to run, instead of a confusing UNKNOWN_SPEC.
- Help examples carry every flag their command requires.

## [0.8.4] - 2026-10-10

### Added

- The coordinator can hold an item: `pullboard hold <id> "reason"` keeps it out of `next` and `claim` on every device until `pullboard hold <id> --off`.

### Changed

- Pullboard View: the Shouts tab's agents panel is compact. Each agent holding work is one row with its avatar, the age of its latest move and the first thing it holds; idle agents are small pills; lane and route show on hover. Pick an agent to filter the feed and address the composer to it.
- Each of your shouts says who has heard it: "Heard by coordinator", "Heard by coordinator and N agents", or "Not heard yet".
- The composer sends to the coordinator, with no recipient picker; a picked agent shows as a chip you can clear.
- A code reference on its own line in a shout, and every one in an item's thread, opens as a block, collapsed until asked, with the exact lines from that commit highlighted; one inside a sentence stays a short label that opens the same block.
- Boards use engine 7. Upgrade every linked device; a 0.8.3 device stops at the first new record and says to upgrade.

### Fixed

- A person-level relay action the relay refuses now fails at once, naming the refusal, its reason and the request id, instead of waiting for a phone card that never comes. A step that half succeeds (the local unlink done, the remote delete refused) exits nonzero and says which part failed.

## [0.8.3] - 2026-10-10

### Changed

- Agents can never act as you on the relay. `relay on` gives each machine its own credential that only mints agent tokens for its linked boards, so agents keep working with no tap, and no file on the machine can act as you. A person-level action from the Mac asks for one tap on your paired phone; the grant is used once and never stored.
- Boards use engine 6. Upgrade every linked device: once a machine on a board has its own credential, older clients on that board stop and say to upgrade.
- Relay snapshots are compressed inside the seal, so a large board syncs.
- Pullboard View: shouts read as cards, with an avatar, name and chips, and decisions and receipts set apart. You shout from a composer, and an agents panel shows who is holding what.

### Fixed

- A refused relay upload never blocks board moves: agents keep working, and each move prints one line saying why.
- A board with no snapshot yet waits on the phone instead of reloading in a loop.
- A recovered relay snapshot clears its stale timeout notice.

## [0.8.2] - 2026-10-09

### Added

- `pullboard relay on --all` sets up the relay once: it links every board on the machine, links boards registered later on its own, and one phone pairing opens all of them.
- Another machine joins a linked board by pairing.
- Each agent has its own relay token.
- From the relay page you can act on your board through sealed requests, and Pullboard View shows each one as waiting, done or refused.
- An item's detail shows its check baseline and warns when the check proves nothing.

### Changed

- Commands ask git each question once, so they run about 4x faster.
- Submit can run only the tests a change affects: set `affectedTests` in pullboard.json to the command that runs selected test files. Without it, submit runs your gate in full.
- A piped gate fails when any stage fails, so a red test piped to `tail` can't read green.
- `pullboard add` returns at once; a check's baseline runs in the background (`--wait` waits for it).
- A review released without a verdict goes to another reviewer, and needs a one-line `--note`.
- Boards use engine 5. Upgrade every linked device; an older client stops at the first new record and says to upgrade.
- Item checks and verify runs wait for a machine gate slot, and a waiting gate goes first.
- A checkout speaks for one agent session.
- A red check at verify shows why it failed.
- Duplicate ids across SPEC.md and DOCTRINE.md are refused; ones PRACTICE.md already had stay warnings after the rename.
- Lane checks can't be bypassed by unstaged config, auto-merges or grafts.

### Fixed

- `pullboard relay on` works over SSH: relay keys live in an owner-only file, not the system keychain.
- Without its board key, a device still reads its linked board locally.
- A registered board behind an unreadable folder stays listed, with one warning.
- `spec check` works in a detached checkout.
- A shell reached over SSH is never treated as your terminal.
- `pullboard edit` on an item whose claim expired reopens it instead of crashing.
- `init` ignores agent worktrees under .claude, so they never block submit.
- A note in a brief's Files entry no longer trips the lane check.
- Pullboard View: only a command becomes a code chip and it stays inline, briefs show their lists as lists, the page never scrolls sideways on a phone, the project list folds into the tab bar on a laptop, and Activity says what each shout said.
- The coordinator's resume is a full handoff brief.

## [0.8.1] - 2026-10-09

### Added

- Your board on your phone: pullboard.dev shows Pullboard View to a signed-in person, and what you do there reaches your board as a request.
- Approve or decline proposed spec rows from the Spec tab, one at a time or a whole section at once.
- An item's detail shows its thread as one timeline.
- `pullboard stats` prints the board's proof numbers.
- The tour's demo board appears in Pullboard View.

### Changed

- The agents' house rules are DOCTRINE.md everywhere; a PRACTICE.md is still read under its old name.
- Submit and accept refuse work that can't merge onto the trunk.
- Accept installs the repo's dependencies before the frozen check, and every accept records whether a check ran.
- Only `pullboard answer` closes a decision, over the relay too.
- A replayed verify obeys the item's frozen policy.
- Every relay client declares its engine, and the relay refuses clients too old to judge agent moves; upgrade every linked device to 0.8.1.
- Offline, a linked board reads locally and refuses moves.

### Fixed

- Retrying a move after a lost reply never duplicates it.
- Merging main into a lane branch commits cleanly; edits outside the lane are still refused.
- Test runs keep a private machine home, so they no longer add projects to Pullboard View.
- Chrome and port tests hold up on a busy machine.

## [0.8.0] - 2026-10-08

### Added

- Pullboard View has a Roadmap tab for milestones, item status, progress and notes; `/roadmap` opens it directly.
- Any agent can add a typed item fact; only its holder or the coordinator can add a judgement, and a correction leaves the old fact visible.
- `--ref path:lines@sha` binds a code reference to a full commit, and `pullboard show` prints moves and facts in one timeline.

### Changed

- Repositories can use any trunk branch name, including `master` or `trunk`.
- Every device checks sealed moves against the signed-in sender, so an agent cannot act as the coordinator or person.
- Relay engine version 3 stops replay at a newer engine record; upgrade every linked device to 0.8.0.

### Fixed

- Chrome tests wait for the page elements they measure and handle a slow first load.

## [0.7.0] - 2026-10-08

### Added

- `pullboard next` offers submitted work for review before build work; `--build` requests a build item.
- People can approve or decline proposed spec rows in Pullboard View, with choices recorded for the coordinator to apply.
- Command help is grouped by command, and `pullboard init` gives first-run guidance for the detected project ecosystem.

### Changed

- Pullboard View keeps action results and wait details usable on smaller screens.
- Staged-file secret scanning covers large files, including binary files.

## [0.6.1] - 2026-10-07

### Added

- A roadmap and milestone board lets a coordinator plan work across several items.
- Tagged releases publish to npm from CI with provenance.
- `pullboard init` adds first-run guidance for the detected project ecosystem.

### Changed

- An item's check is tried against committed `main`, so a check that already passed before the change is flagged.

## [0.6.0] - 2026-10-07

### Added

- Pullboard View shows live project activity and supports local API access and replayable static exports.
- Signed specification approvals and cross-family review receipts record who approved and checked work.
- Gate runs can wait in a resource-aware queue instead of competing for the same machine.

## [0.5.0] - 2026-10-07

### Added

- A local, spec-backed work board gives each item a frozen criterion, a separate worktree lane, a gated submission, and an independent review receipt.
- The timed tour demonstrates a change being rejected, corrected, and accepted with proof.

[Unreleased]: https://github.com/pullboard-dev/pullboard/compare/v0.8.7...HEAD
[0.8.7]: https://github.com/pullboard-dev/pullboard/compare/v0.8.6...v0.8.7
[0.8.6]: https://github.com/pullboard-dev/pullboard/compare/v0.8.5...v0.8.6
[0.8.5]: https://github.com/pullboard-dev/pullboard/compare/v0.8.4...v0.8.5
[0.8.4]: https://github.com/pullboard-dev/pullboard/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/pullboard-dev/pullboard/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/pullboard-dev/pullboard/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/pullboard-dev/pullboard/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/pullboard-dev/pullboard/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/pullboard-dev/pullboard/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/pullboard-dev/pullboard/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/pullboard-dev/pullboard/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/pullboard-dev/pullboard/releases/tag/v0.5.0
