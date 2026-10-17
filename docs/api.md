# CLI JSON API

Add `--json` to a Pullboard command to receive one JSON document on stdout. The document has `version: 1`; diagnostics stay out of stderr except for sign-in instructions and check consent notices that must appear before execution. The flag may appear with command options before `--`. A flag after `--` is an argument to the command, not an output-mode switch.

The API version is independent of the package version. Its contract is stable within each major API version: existing command names, required fields, field types, and refusal fields do not change within that version. An incompatible change requires a new `version`. New fields may be added, so clients should ignore fields they do not use.

Decision shouts without a recipient go to the agent's coordinator, or to `person` when sent by the coordinator. An agent may answer a decision sent to its own lane; the reply names that agent and goes to the original asker. An agent in another lane gets `NOT_YOUR_DECISION`. `pullboard pass <shout-id> <note>` is for coordinators: it forwards an open coordinator decision to the person with the original question and note. From the main checkout, `pullboard decisions` and `pullboard answer <shout-id> <text>` default to the coordinator; use `--as person` to select the person's queue or answer a person-addressed decision. Person mode is accepted only in the main checkout. An answer in person mode cannot answer a coordinator-addressed decision, and a coordinator-default answer cannot impersonate the person; the refusal prints the command to retry. A person answer is delivered to the original asker. An agent worktree cannot select person mode.

A successful command returns the fields listed below. `version` is always the number `1`. The catalog lists required top-level fields; nested objects and arrays are command data, and optional top-level fields may be added.

`pullboard settings` reads machine-wide settings from the OS account's `~/.pullboard/settings.json`; the gate queue database is beside it. This location does not follow `HOME` or `PULLBOARD_HOME`, so agents with private board homes still share one machine gate limit. Set `PULLBOARD_MACHINE_HOME` to an explicit directory only when a separate private machine settings and gate pool is intended; tests use this override. `pullboard settings gateSlots <n>` changes the gate queue capacity, which defaults to `2`. Raising gate or browser capacity takes effect immediately, even with holders and waiters: settings and the durable queue limit change under the same lock, and existing waiters observe the new limit. Lowering capacity is refused while that resource has holders or waiters; the refusal names its live holders and leaves their leases, settings and queue order intact. Retry the decrease after the resource becomes idle.

Browser-free check admission is opt-in per machine with `"gate": { "browserFreeChecks": true }` in `~/.pullboard/settings.json`; it defaults to `false`. When enabled, the reviewed test classifier can let checks use a CPU-only gate slot. An absent or false setting keeps every check browser-gated, and uncertain or unsupported test commands remain browser-gated even when enabled. The same setting controls the wider frozen-check classification introduced in 0.8.26.

The machine gate pool admits landings first and then everything else in arrival order. A machine opts in to reviews first with `"gate": { "queue": { "reviewsFirst": true } }` in `~/.pullboard/settings.json`: the pool then admits landing runs, then reviews, then submits and item checks, then focused and other runs, first come first served within each class. `gate.queue.agingMinutes` (a positive whole number, default `30`) is how long a waiting run waits before it moves up one class, so no class starves; it is used while `reviewsFirst` or the release priority below is enabled. `pullboard settings` prints both values, and `pullboard resources` names the order in effect.

Release priority is separately opt-in with `"gate": { "queue": { "currentReleaseFirst": true } }`. Before queueing, a gate run captures its board identity and its item's roadmap rank. The first unfinished milestone is current, counting only this board's own items as verified out of total; `repo#id` references are left out and never opened. Later milestones follow in roadmap order, then already completed earlier milestones, then unplanned work. Within otherwise-tied positions belonging to one board, current-release work goes first: `A-later, B, A-current` becomes `A-current, B, A-later`. Different boards retain their opportunity positions. Global admission classes and landings retain their existing precedence, and a waiter older than `agingMinutes` keeps its position against release reordering. Queued ranks do not change if the roadmap changes. With the setting off, no board is read for release priority. Unknown board identities keep their positions; while any older client is waiting, all clients fall back together to landings then arrival. `pullboard settings` prints `gate.queue.currentReleaseFirst`, default `false`.

The memory hold is opt-in per machine with `"gate": { "memoryFloorMB": <n> }` in `~/.pullboard/settings.json`; absent, it is off and the pool admits by slots alone, as before. When set, before admitting a run the machine gate pool reads the machine's memory: on macOS the kernel's memory pressure level and free percentage, on Linux `MemAvailable` and the pressure stall averages in `/proc/pressure/memory`. The whole queue, landings included, waits in place while pressure is critical or free memory is under that many megabytes (`0` leaves only the pressure check). A held run prints one line naming why and the three biggest processes by memory, with pid, size and working directory, and starts once memory recovers. While the floor is set, `pullboard resources` prints the same line and returns it as `memory` in JSON; with no floor it reads no memory and `memory` is `null`. Where memory cannot be read, the pool admits by slots alone and prints one warning that memory is not checked there.

When `add` or `edit` supplies a new nonempty check, it records the item before measuring that check in a background temporary checkout of the captured `main` commit. Use `--wait` to wait for the measurement before returning, or `args.wait: true` for an HTTP add/edit move. The item returned by `add`, `edit`, `show`, and `next --verify` may include `item_check_baseline`: `{command, main, result, request?, seconds?, reason?, warning?}`. `main` is the commit id or `null`, and `result` is `pending`, `green`, `red`, or `unavailable`. A background request carries an opaque `request` identity; an older completion cannot overwrite a newly edited or cleared check.

An item's HTTP detail, and each item in the full board state, include `check` and, when recorded, `checkBaseline` with the same observation fields. A green result carries `warning: "CRITERION_PROVES_NOTHING"`; text output names that warning when showing or reserving the item for review, and when filing it with `--wait`. An exact match with the project gate configured at that main commit records green with `reason: "repo gate"` without running it again. A missing main records unavailable with `reason: "no main"` and still files the item. Changing the check replaces this observation; clearing it removes the observation. Captured observations and completions travel through ordered board moves, so replicas store results without executing commands. A completed result awaiting relay delivery stays on the measuring device and is retried by the next normal CLI command.

`pullboard stats [--since <date>] --json` returns `{version: 1, stats: {...}}` from the append-only event log. `submissions` and `rejections` count moves, including repeated attempts; `rejectionShare` is rejections divided by submissions (zero when the window has no submissions). `merged` counts distinct items with a merge move; `mergedWithoutAccept` counts those whose merge lacks an earlier acceptance of the latest submitted commit. That audit uses earlier history even when the acceptance falls before the selected window. Current item and verdict rows do not replace event evidence.

`stats.bars` counts bar corrections, keyed by agent: `{corrections, barRejects, buildRejects}`. A correction is an `edit --criterion` or `--check` on an item that was ever claimed. It must carry `--reason "what the old bar got wrong"` (HTTP `args.reason`); without one it is refused with `BAR_REASON`. A correction that follows the item's newest, unexplained reject marks that reject as caused by the bar, counted to the correcting agent; every other reject counts to the build, under the agent who added the item. Text `stats` prints one `bars:` line per agent, and text `show` prints each correction with its reason.

`stats.flow` adds the flow through the board:

- `asOf` is the ISO UTC timestamp of this observation, shared by every queue age.
- `stages.build`, `reviewWait`, `review` and `mergeWait` each contain `count`, `totalMinutes`, `averageMinutes`, `medianMinutes` and `unmeasuredCompleted`. Build runs from first claim to the final submission, including rework. Review wait ends at the reservation whose verdict closes that submission; released or expired reservations remain waiting time. Review runs from that reservation to verdict, and merge wait from accept to the first merge receipt. Each stage enters its averages when its end is inside the inclusive `--since` window. Unfinished or missing intervals are omitted; averages and medians with no samples are `null`. Legacy verdicts without reservations leave review wait and review unmeasured, never zero.
- `queues.open`, `claimed`, `submitted` and `accepted` contain `size` and `oldest` (`{id, since, ageMinutes}`, or `null`). These are current queues, including work added before the window; accepted means accepted but not merged. Open age starts at the latest add, reopen, reject, build release or claim lapse. Claimed age starts at claim, unaffected by renewal; submitted age starts at final submit, and accepted age at accept. Equal ages choose the lower item id. Expired claims become open at their recorded lease expiry. Each `since` is the ISO UTC timestamp of that queue origin, and `ageMinutes` is exactly `(Date.parse(asOf) - Date.parse(since)) / 60000`. Separate observations check that equation independently; their invariant content, including `since`, stays comparable without a tolerance band.
- `daily` contains UTC `{date, added, merged}` counts for dates with those moves in the window. An item's first merge completes its cycle; repeated receipts never create another completion, even in a later window. `submitsPerMerged` divides window submission attempts by first completions in the window, or is zero without completions. `stats.rejectionShare` remains the share of window submissions sent back.
- `activeAgents` contains `total`, an `agents` list (`id`, `lane`, `role`), and counts in `roles` and `lanes`. Activity means any move in the inclusive last 60 minutes, independent of `--since`. Builder roles come from claim, submit or build release; verifier roles from reserve, verdict or review release. A roleless move retains the latest recorded role, including earlier history; without one the role is `unknown`. The coordinator's role is `coordinator`. Lanes come from recorded joins, not a guess from the id.
- `bottleneck` contains `stage`, `share`, `completedItems`, `fullyMeasuredCycles`, `totalCycleMinutes`, `lowConfidence`, `message` and `recommendation`. Only completed cycles with all four measured stages contribute stage shares; the line states how many fully measured cycles support it. Fewer than half the completed cycles fully measured sets low confidence. The largest summed share wins, with ties in build, review wait, review, merge wait order. No completed cycles, or none fully measured, means no named stage or action (`null`).

The single recommended action uses the first matching rule: review wait with fewer than one active verifier per four active builders says **add a verifier**; otherwise **review the oldest submission first (#N)**. Build with more than 30% of window submissions sent back says **tighten criteria or briefs: N of M submissions were sent back**; otherwise **add a builder in &lt;lane with the most open items&gt;**, with lane-name ties sorted alphabetically. Review says **reviews are slow (median X min): check how long the frozen checks take**. Merge wait says **land the accepted items: #A, #B**, with ids ascending. If the relevant queue is empty, its action explicitly says none waiting, or **add a builder when open work is available**. JSON retains numeric precision; CLI minutes round to two decimal places. Statistics are read-only.

`stats.flow.unreviewed` is a current `{size, oldest}` queue using the same `{id, since, ageMinutes}` shape and observation as the other queues. It contains submitted items with no verdict since their final submit and no live reviewer reservation; released or expired reservations count as unreserved, and their age still starts at the final submit.

The coordinator's `resume` ends with one `flow:` line if the measured review-wait average is strictly greater than **60 minutes**, or the oldest currently unreviewed submission is strictly older than **180 minutes**. Exact boundaries do not trip. Both thresholds share one line if both trip. The line gives the tripped threshold's numbers, the measured bottleneck stage, its share and total cycle minutes, and the same recommended action as `stats`. It does not replace a measured build, review or merge bottleneck with review wait. Without a fully measured cycle, a trip still names its threshold and waiting item, followed by **bottleneck: not measured yet**, with no invented stage or action. A healthy or unmeasured board with no trip adds no line. Agent resumes do not add this line. Coordinator resume JSON includes the same `flow` observation as stats.

The coordinator's `resume` opens, after its header line, with its inbox: `inbox: <n> unread shouts, <n> open decisions for you`, then the newest three unread shouts by id, sender, age and first line, then `<n> more; read them all with pullboard inbox` when there are more. Only shouts to the coordinator, its lane or all count. While shouts are unread its `next:` reads `read your <n> unread shouts first: pullboard inbox; then ...`. Resume marks nothing read; `inbox` does. Coordinator resume JSON carries the same as `inbox: {unread, decisions, newest: [{id, from, at, text}], more, read}`.

The coordinator's `resume` names who commits which uncommitted Pullboard file. A row file (the spec or the practice file) that is committed and changed, as `spec apply` leaves it, is the coordinator's, together with any sign-off receipt a signed apply appended to `.pullboard/signoffs.jsonl`: `The coordinator must commit the row file spec apply changed: <git add and git commit of exactly those files>` (the line says `changed and its sign-off receipt:` when a receipt is included), and its `next:` reads `commit the applied row file first: <that command>; then ...`. Every other setup file that differs from the last commit, including a row file init wrote that is not committed yet, is the person's: `The person must commit Pullboard's setup files before agents can use worktrees: <git add of exactly those files>`. Each line appears only when it has files, and a dirty file that is not a setup file is never named. Coordinator resume JSON carries the same as `commits: {coordinator: {files, command} | null, person: {files, command} | null}`.

For example: `flow: review wait average 61 min (1 measured; > 60 min); bottleneck: build (66.67% of 300 measured cycle min); next: add a builder when open work is available`. An unmeasured trip reads `flow: unreviewed #1 waiting 181 min (> 180 min); bottleneck: not measured yet`.

`firstEventAt` and `lastEventAt` are the first and latest dates in the selected window, or `null` when it is empty. `since` is the inclusive boundary as an ISO UTC timestamp, or `null` for the full history. Dates accept `YYYY-MM-DD` or an ISO UTC timestamp ending in `Z`; invalid dates return `BAD_SINCE` with repair guidance.

`agentCount` counts distinct event actors other than `board` and `person`; the coordinator and join moves are included. `agents` lists `{id, moves, families}` for each actor. `families` lists `{name, agents, moves}` by recorded family label, and `familyCount` counts these buckets, including `unknown`. Labels are not inferred from a model name or current agent, item, or verdict rows. A family's first recorded event snapshot applies to that move and following moves, until another snapshot changes or clears it; earlier unattributed moves remain `unknown`. Date windows preserve earlier recorded declarations but count only selected moves. Arrays are sorted by identifier or label. Local HTTP board state carries the same full-history object as `state.proofStats`.

`merged <id> <commit>` records only a commit reachable from the primary checkout's branch that contains the item's submitted commit or has the same stable patch id as the item's change from its claim base. Other commits are refused with `NOT_MERGED`; `--note "why"` records an exceptional receipt and keeps the note in that item's `merged` event.

<!-- api-command-shapes:start -->
| Command | Required top-level fields |
| --- | --- |
| `help` | `version:number`, `help:string` |
| `version` | `version:number`, `release:string` |
| `init` | `version:number`, `root:string`, `notes:array`, `proposedLanes:array` |
| `hooks` | `version:number`, `notes:array` |
| `join` | `version:number`, `agent:string`, `lane:string`, `route:string`, `path:string`, `model:string`, `displayName:string` |
| `takeover` | `version:number`, `agent:string`, `path:string` |
| `worktree` | `version:number`, `agent:string`, `lane:string`, `route:string`, `path:string`, `branch:string`, `prompt:string`, `model:string`, `displayName:string` |
| `resume` | `version:number`, `me:object`, `all:array`, `requests:array`, `holding:array`, `sentBack:array`, `awaiting:array`, `toVerify:array`, `toMerge:array`, `open:array`, `stale:array`, `doctrineNotes:array`, `holds:array`, `unread:number`, `newest:array`, `root:string`, `newWorktreeLocation:string`, `dirty:number`, `next:string` |
| `whoami` | `version:number`, `id:string`, `lane:string`, `path:string`, `model:string`, `displayName:string` |
| `lanes` | `version:number`, `lanes:object`, `shared:array`, `coordinator:string` |
| `lane add` | `version:number`, `lane:string`, `owns:array` |
| `resources` | `version:number`, `resources:array` |
| `settings` | `version:number`, `settings:object` |
| `runner` | `version:number`, `runner:object` |
| `relay` | `version:number`, `linked:boolean`, `board:string`, `url:string`, `link:string`, `sequence:number`, `behind:number`, `recovery:object` |
| `list` | `version:number`, `items:array` |
| `roadmap` | `version:number`, `milestones:array` |
| `milestone add` | `version:number`, `milestone:object` |
| `milestone items` | `version:number`, `milestone:object` |
| `milestone move` | `version:number`, `milestone:object` |
| `milestone edit` | `version:number`, `milestone:object` |
| `milestone remove` | `version:number`, `milestone:object` |
| `show` | `version:number`, `item_id:number`, `item_title:string`, `item_lane:string`, `item_status:string`, `verdicts:array`, `thread:array` |
| `stats` | `version:number`, `stats:object` |
| `status` | `version:number`, `me:object`, `mine:array`, `stats:object`, `reviewQueue:object`, `unread:number`, `relay:object` |
| `doctor` | `version:number`, `problems:array` |
| `health` | `version:number`, `asOf:string`, `thresholds:object`, `stuck:array`, `waiting:array` |
| `skills` | `version:number`, `updated:array`, `current:array`, `customized:array` |
| `inbox` | `version:number`, `shouts:array` |
| `decisions` | `version:number`, `decisions:array` |
| `ledger` | `version:number`, `items:array`, `stats:object` |
| `log` | `version:number`, `events:array` |
| `add` | `version:number`, `item:object` |
| `edit` | `version:number`, `item:object` |
| `fact` | `version:number`, `item:number`, `fact:object` |
| `why` | `version:number`, `id:number`, `decisions:array` |
| `escalate` | `version:number`, `id:number`, `from:string`, `to:string` |
| `run` | `version:number`, `messages:array` |
| `sweep` | `version:number`, `messages:array` |
| `next` | `version:number`, `item:object`, `review:boolean`, `held:boolean`, `shared:array` |
| `check` | `version:number`, `id:number`, `green:boolean`, `seconds:number`, `check:string`, `report:string` |
| `claim` | `version:number`, `id:number`, `renewed:boolean`, `leaseUntil:string`, `digest:string` |
| `hold` | `version:number`, `lane:string`, `held:boolean` |
| `release` | `version:number`, `id:number` |
| `submit` | `version:number`, `id:number`, `commit:string`, `pin:string`, `gate:object` |
| `done` | `version:number`, `id:number`, `commit:string`, `pin:string`, `gate:object` |
| `verify` | `version:number`, `id:number`, `decision:string`, `reason:string` |
| `merged` | `version:number`, `id:number`, `commit:string` |
| `land` | `version:number`, `batch:object\|null`, `landed:array`, `conflicts:array`, `blocked:array`, `culprits:array`, `flakes:array` |
| `withdraw` | `version:number`, `id:number`, `reason:string` |
| `refreeze` | `version:number`, `id:number`, `after:string` |
| `reopen` | `version:number`, `id:number`, `commit:string` |
| `shout` | `version:number`, `id:number`, `decision:boolean` |
| `answer` | `version:number`, `id:number`, `answers:number` |
| `pass` | `version:number`, `id:number`, `answers:number` |
| `tour` | `version:number`, `messages:array` |
| `lifecycle` | `version:number`, `markdown:string` |
| `view` | `version:number`, `url:string`, `port:number` |
| `view export` | `version:number`, `path:string` |
| `serve` | `version:number`, `url:string`, `port:number` |
| `watch` | one document per line: `version:number`, `sequence:number`, `kind:string`, `item:number\|null`, `actor:string\|null`, `detail:string` |
| `forget` | `version:number`, `root:string` |
| `prompt` | `version:number`, `role:string`, `text:string` |
| `gate` | `version:number`, `green:boolean`, `report:string` |
| `export` | `version:number`, `tables:object` |
| `import` | `version:number`, `tables:array` |
| `spec` | `version:number`, `rows:array` |
| `spec check` | `version:number`, `rows:array` |
| `spec view` | `version:number`, `path:string` |
| `spec show` | `version:number`, `row:object`, `standing:object` |
| `spec draft` | `version:number`, `id:string`, `row:object` |
| `blueprint add` | `version:number`, `blueprint:object`, `section:string`, `rows:array`, `items:array`, `gate:string\|null`, `proposedLanes:array` |
| `spec unmet` | `version:number`, `rows:array` |
| `spec signoff` | `version:number`, `count:number`, `by:string`, `ids:array`, `evidence:array` |
| `spec signers` | `version:number`, `added:boolean`, `by:string`, `path:string`, `initial:boolean` |
| `spec approve` | `version:number`, `decisions:array` |
| `spec decline` | `version:number`, `decisions:array` |
| `spec answer` | `version:number`, `decisions:array` |
| `spec apply` | `version:number`, `applied:array`, `files:array` |
| `doctrine check` | `version:number`, `rules:array` |
| `hook pre-commit` | `version:number`, `messages:array` |
| `hook pre-merge-commit` | `version:number`, `messages:array` |
| `hook commit-msg` | `version:number`, `messages:array` |
| `hook pre-push` | `version:number`, `messages:array` |
<!-- api-command-shapes:end -->

`spec draft "<rule>" --doctrine --source "chat, 2026-10-16"` proposes a sourced doctrine row and returns a qualified `id`, such as `doctrine:DR1`, for the existing person approval commands. Resume adds `doctrineNotes`, an array of newly seen approved rules with `id`, `text` and `gate`; each checkout consumes its own notices. Drafts and pending applications are excluded. The shared approved doctrine also supplies frozen citations and stale-item comparisons in older checkouts.

`hook pre-merge-commit` runs the same staged checks as `hook pre-commit` before Git creates an automatic merge commit. `init` and `hooks` install it; `doctor` names it when absent at Git's effective hook path. Lane ownership comes from `HEAD:pullboard.json`, so an unstaged configuration edit cannot grant a lane new folders. `lane add` writes the new lane to the working `pullboard.json` and returns `{ lane, owns }`; commit the file before the lane's ownership takes effect. `init` returns the lanes it proposes as `proposedLanes`, each `{ name, owns }`, and writes none of them. Lane-sensitive checks refuse a repository with `info/grafts` in its Git common directory because grafts alter ancestry even when replacement objects are disabled.

`join` and `worktree` require a free-text `--model` label or `PULLBOARD_MODEL` environment value; labels are not inferred from a provider or family. Rejoining the same worktree preserves its agent id; the model label is required on every join, and omitting the optional `--family` preserves its prior declaration. `pullboard.json` may set `agents.names` to `suffix` (the default, `web-1 (Claude)`) or `prefix` (`claude-web-1`). CLI `agent` fields remain stable ids; `displayName` shows the chosen style. `resume.me` and API state `agents[]` carry `model` and `displayName`; older agents with no model display `unknown`. Each event records the actor model in `event_detail.model` for a registered agent, with `unknown` for legacy agents without a declaration. `show` includes `item_builder_family` and each verdict's `verdict_verifier_family`. These family fields are `null` when the agent did not declare a family, and later declarations do not rewrite prior submissions or verdicts.

Each checkout is bound to the first agent session that writes there. The local Git directory holds only its session digest, agent id and timestamp; bindings are absent from board exports and relay snapshots. Another agent session gets `NOT_YOUR_CHECKOUT` and the command to make its own worktree. The same agent starting a new session runs `pullboard takeover`; the existing ordered shout records the takeover, addressed to the person for the main checkout or the coordinator for a lane checkout. Markerless terminals, reads, the view and person requests keep their existing behavior. A shout or decision addressed to its sender is refused with `SELF_SHOUT`.

`status.reviewQueue` contains `pending`, `reviewing` (distinct agents with live review leases), `reserved`, `oldestSubmittedAt` and `ageMs`. Age starts at each outstanding item's latest submit event; reserving or renewing its review does not reset it. An empty queue has `oldestSubmittedAt: null` and `ageMs: 0`. Among unreserved submissions, `awaitingFirstReview` counts items with no release since their latest submission; `releasedWithoutVerdict` counts those released without a verdict. `releasedItems` lists `{item, releases, reason}` with the cumulative release count and latest reason for that submission. Historical releases without a reason show `reason not recorded`.

Releasing a reserved review requires a nonempty one-line `--note` (or `--note-file`); the authenticated release action accepts the same `note` field. A refusal keeps the reservation and records no release. The same reviewer is not offered that submission again until it is resubmitted or an hour passes, while other reviewers remain eligible. Releasing a build claim keeps its existing behavior and does not require a reason.

When outstanding reviews reach `verify.reviewRatio` times the active reviewers (default 3, with zero reviewers counting as one), `next` first offers a review the agent may take. This creates no claim or reservation. Its additive v1 `offer` has the review's `item` id, exact `command` to reserve it, `queue` and `ratio`; `build` previews the otherwise available build or is `null`. `next --verify <id>` reserves explicitly. `next --build` claims explicitly; a fresh claim's event detail records `reviewSkipped` with the offered id (or `null`), ratio and queue snapshot. Renewing an existing claim creates no new skip.

For HTTP `next`, a review offer returns success with `event: null`, `offer` and the ordinary CLI `result`. Send `args.build: true` to claim as before and receive the actual claim event. The unattended `run` command always supplies explicit build intent, records it on fresh claims, and prints the review backlog each iteration.

## Board health

`pullboard health` scans the board read-only and lists every stuck item with its cause, since when, the one next step and who takes it. It opens the board through a read-only connection, records no event, skips relay sync and asks git only `merge-tree`, which never touches a HEAD, index or working tree. It exits 0 when nothing is stuck and 1 when something is; the text form then prints `nothing is stuck`, or one line per finding: `#12 claim lapsed, since 2026-10-17 10:00 (2h): web-3's lease ran out and nobody is building it. Next, web-3 (builder): renew it with pullboard claim 12.`

`health --json` returns `{version: 1, asOf, thresholds: {stuck, holds, release}, stuck: [...], waiting: [...]}`. `asOf` is the board clock's ISO time. Each finding in `stuck` and `waiting` is `{key, cause, item, subject, title, since, ageMinutes, why, next, command, owner: {role, who}, detail}`:

- `key` names the cause and what is stuck, like `CLAIM_LAPSED:item:12`, `HOLD_STALE:lane:docs`, `DECISION_UNANSWERED:shout:40` or `RELEASE_OVERDUE:release:v0.9.0`; it stays the same while the finding persists, so a watcher can post it once and notice when it clears.
- `item` is the item id, or `null` for a lane hold, a decision or a release; `subject` is the same thing as text (`#12`, `lane docs`, `decision #40`, `release v0.9.0`).
- `since` is when the wait began, in ISO time; `ageMinutes` counts whole minutes from it to `asOf`.
- `why` and `next` are plain sentences; `command` is the exact command for the next step, or `null` when the step has none.
- `owner.role` is `builder`, `reviewer`, `coordinator` or `person`; `owner.who` is the agent, lane, `coordinator` or `person`, and `null` when any reviewer may take it.
- `detail` holds the cause's facts: `holder`, `reviewer`, `builder`, `commit`, `files` and `trunk` for a conflict, `parent` for a stacked item, `reason` and `by` for a hold, `withdrawn`, `after`, `move` and `milestone`, `shout`, `from` and `to`, or `release` and `landed`.

The causes, each with its owner:

| cause | stuck when | owner |
|---|---|---|
| `CLAIM_LAPSED` | a claim's lease ran out; `since` is when it ran out | the holder |
| `REVIEW_LAPSED` | a review reservation's lease ran out with no verdict | a reviewer |
| `NO_REVIEWER` | a submission has had no reviewer past `health.stuck` | a reviewer |
| `UNLANDED_CONFLICT` | accepted past `health.stuck` and its commit conflicts with the trunk; `detail.files` names the files | its builder |
| `UNLANDED_HELD` | accepted past `health.stuck` and held; `detail.reason` names the hold | who holds it |
| `UNLANDED_STACKED` | accepted past `health.stuck` and carrying another item's commit that has no accept | a reviewer, or that item's builder |
| `UNLANDED_WAITING` | accepted past `health.stuck` and waiting on an item it lands after | the coordinator |
| `UNLANDED_READY` | accepted past `health.stuck`, merges cleanly and nobody landed it | the coordinator |
| `HOLD_STALE` | an item or lane hold older than `health.holds` | who holds it |
| `CONFLICT_HOLD_CLEARS` | a hold whose reason names a conflict, on an item whose commit now merges cleanly | who holds it |
| `REWORK_UNCLAIMED` | rejected or reopened in the current release and unclaimed past `health.stuck` | its builder |
| `REWORK_LATER` | the same in a later milestone; listed in `waiting` | its builder |
| `AFTER_WITHDRAWN` | an unfinished item waits on a withdrawn item | the coordinator |
| `DECISION_UNANSWERED` | a decision to the coordinator or the person is unanswered past `health.stuck` | the coordinator or the person |
| `REQUEST_UNANSWERED` | a person's request is not done or declined past `health.stuck` | the coordinator |
| `RELEASE_OVERDUE` | landed work waits and the newest version tag is older than `health.release` | the coordinator |

The current release is the roadmap's first milestone with unverified local work; an unplanned item counts as current. A release is the newest tag named like `v1.2.3` or `1.2.3`, dated by its creation, and its landed work is every item first recorded merged after it. A repository with no such tag has no release deadline. The trunk is the primary checkout's branch, or the retained trunk when that checkout is detached.

`pullboard.json` sets the thresholds under `health`, each a duration like `90m`, `2h` or `1d`: `stuck` (default `1h`), `holds` (default `1d`) and `release` (default `1d`). A value that is not a duration is refused as `BAD_CONFIG`.

## Item threads

`pullboard fact <id> <kind> "<text>"` appends a fact to an existing item. The observation kinds are `capture`, `measurement`, `note` and `diff`; any registered agent may append them. The judgement kinds are `decision`, `rejection`, `supersession` and `root-cause`; only the item's live lease holder or the coordinator may append them. An expired lease gives no judgement permission. Facts do not change the item's status or its claim.

The result is `{version: 1, item: <item-id>, fact: {...}}`. A fact has `id` (stable string identity), `eventId` (board-local event sequence), `kind`, exact `text`, `by` (registered author), `at` (UTC timestamp), `ref` and `supersedes`. The board supplies identity, author and time. `ref` and `supersedes` are `null` when omitted.

Use `--ref src/file.js:12-30@<full-40-character-sha>` to bind a fact to a committed code range. A single line is `:12@...`. The reference becomes `{path, start, end, commit}`; paths are relative to the repo, line numbers are positive and ascending, and the commit is lowercase hexadecimal. Short hashes are refused with `BAD_FACT_REF`. Replicas validate this binding without fetching source code.

A correction is a new fact with `--supersedes <fact-id>`. It requires the live holder or coordinator even when its kind is an observation. The earlier fact remains visible; supersession must name a fact on the same item. A missing or cross-item identity is refused with `NO_FACT`. Unsupported kinds receive `BAD_FACT_KIND`, empty text receives `EMPTY_FACT`, and unauthorized judgements or corrections receive `FACT_JUDGEMENT`.

`show --json` retains its existing item fields and verdicts and adds `thread`. The HTTP item detail's `thread` field, also on each item in the full board state, has the same array. Entries are oldest first, ordered by the append-only event sequence. A fact entry is `{type: "fact", ...fact}`. A move entry is `{type: "move", eventId, kind, by, at, detail}`, with `detail` holding the original move's structured event detail. Text `show` prints these moves and facts as one timeline, including full references and both sides of a correction. Ordinary verdict summaries and `--history` remain available.

A decision names the items it changes with `--implies 12,13` on `fact`, `verify` or `answer`; the HTTP moves take the same value as `args.implies`, and `answer` also takes `args.supersedes`, the id of an earlier answer. Each named item must exist; an unknown one is refused with `NO_ITEM` naming it, before anything is recorded. Each named item's `thread` then gets a `note` fact with a `decision` citation `{source, id, item, by, line}`, and a second fact with `supersededBy` when that decision is superseded (docs/formats.md has the shapes). These optional fact fields appear only when set. `by` is read from the board's record of the decision, never from the arguments, and only the person supersedes the person's answer. `pullboard why <id>` returns `{version: 1, id, decisions: [...]}`, newest first; each entry is the citation plus `at`, `fact` (the implied fact's id) and `supersededBy` (a citation, or `null`). `resume --json` adds `decisions`: the implied facts on held items shown for the first time, each `{item, fact, text}`.

The HTTP move is `{verb: "fact", item: 12, agent: "web-1", args: {kind: "measurement", text: "The check takes 8 seconds", ref: "src/file.js:12-30@<full-sha>"}}`. Omit `agent` to act as the coordinator; `args.supersedes` supplies a correction's earlier fact identity. The response carries the committed `fact` event and the CLI result. The event-log format stays at version 1 because facts use its existing immutable event rows; exports and imports preserve those rows. The sealed move engine advances to version 3 for this release so older engines refuse the new operation before replay.

## Refusals

A refusal keeps the command's existing exit status and prints exactly one versioned document to stdout. In JSON mode stderr stays empty except for sign-in instructions and check consent notices. The command-specific `code` identifies the rule; `message` explains what happened; `next` gives the next step.

Only the coordinator sets or edits an item's `--check`. `pullboard check [id]` prints the command and its setter before execution, and asks for consent when the caller did not set it. Use `--yes` to confirm that command without a prompt. An EOF or declined answer refuses with `CHECK_CONFIRM` before running the command. With `--json`, the notice and prompt appear immediately on stderr and stdout remains one JSON document; a successful check result also includes the optional `by` setter field.

```json
{
  "version": 1,
  "error": {
    "code": "NODE_TOO_OLD",
    "message": "this is Node 20.11.1, and pullboard needs Node 22.13 or newer",
    "next": "install Node 22.13 or newer, then run the command again"
  }
}
```

<!-- api-refusal-shapes:start -->
| Part | Required fields |
| --- | --- |
| `envelope` | `version:number`, `error:object` |
| `error` | `code:string`, `message:string`, `next:string` |
<!-- api-refusal-shapes:end -->

`relay on`, `relay`, and `relay off` share the relay result shape. Successful `pullboard relay recover --skip N` returns that same shape with optional `skipped: N` naming the explicitly refused sequence and `adopted: true` when it adopts a different authenticated person checkpoint that proves the same blocked refusal. Every relay result includes `recovery: { pending, skip, next }`; when a saved recovery is pending, `next` is the exact retry command. The `behind` count remains the number of pending uploads and does not include recovery. `status` includes this relay object alongside the local board summary. Human status and relay output show the recovery sequence and retry command when one is saved. The local `agent_last_shout_id` inbox read cursor is metadata: recovery ignores only that field in its guarded digest and preserves the greater valid cursor for matching agents. Other native changes remain protected; if a semantic local write changes while recovery is pending, the CLI preserves it and refuses automatic restoration. Exporting alone does not unblock that conflict; this prototype has no merge or discard command, so the person must reconcile the export and remote checkpoint before continuing. Successful results may include `diagnostics` for a relay refusal or inactivity notice; a local move still succeeds when its upload must wait. Device sign-in instructions are written immediately to stderr, including with `--json`, so the person can sign in before the command returns.

`relay on --all [--url <address>]` returns `{version, linked: [{project, root, board}], failed: [{project, root, reason}], paired, autoLink: true}`. Its status is nonzero when a project failed; successful links remain available. With no paired phone, the command prints one tappable pairing link and QR, then waits in the foreground up to ten minutes. Interruption or expiration leaves completed links intact and exits zero when no link failed. Every explicit invocation signs in afresh; no person session is retained on the Mac. Later project registrations publish one sealed phone-link proposal and keep working locally until its single approval tap. `doctor` and `resume` name the waiting project and its expiry; expiration requires an explicit fresh sign-in rather than silently asking again. `relay off` excludes that project from automatic linking; explicit `relay on` clears the exclusion.

`relay devices` returns `{version, devices: [{deviceId, label, fingerprint, createdAt}]}` without a private key or credential. `relay revoke <deviceId>` returns `{version, deviceId, revoked: true, notice}` after removing the local recipient and deleting its remote wraps. Native revocation never asks the target device to approve its own removal. Another paired phone can approve it with a short-lived, single-use, RAM-only grant for that exact target. With no other paired approver or no linked publishing board, the person completes a fresh GitHub device-code sign-in on the computer instead. The authenticated account and relay origin must match the saved enrollment; the fresh session stays in memory and is revoked after the action. Agent terminals are refused before any sign-in or network request. A failed or interrupted approval or sign-in needs an explicit retry. Revocation stops future wrapping; it cannot erase board keys already received.

Phone enrollment uses a one-use `#device=<locator>.<secret>` fragment, removed before sign-in. The secret remains on the phone and Mac. Person-authenticated `/api/v1/devices/session` returns the current account id. `/api/v1/devices/enrollments/:locator` supports POST `{}` to start a ten-minute locator, PUT of the exact public enrollment and MAC, GET of `{version, enrollment}` and DELETE to consume it. A native Mac checks the MAC locally before retaining any recipient. `/api/v1/devices/:deviceId` supports POST `{}` to record an authenticated recipient and DELETE to revoke it. PUT `/api/v1/devices/:deviceId/boards/:boardId` stores `{engine, wrapped}`; GET `/api/v1/devices/:deviceId/boards` returns `{version, wraps: [{board, engine, wrapped}]}` filtered by current board access. `wrapped` is opaque base64url client ciphertext. Enrollment, device listing and direct revocation require a person session. A board-scoped machine credential can PUT only its own board wrap to an already enrolled device. Cookie writes require the exact configured Origin, and all responses are no-store. Device ids and grants belong to the authenticated GitHub account. Revoked ids cannot be registered or uploaded again.

`POST /auth/machines {board,machine}` requires a foreground person session and returns a `pm_` credential bound to that board and machine. This delegate can mint board-scoped `pa_` tokens through `/auth/tokens` and list only its board’s token ids and metadata. It cannot link a board, issue a machine credential, post a phone request, revoke another credential directly, or use person-only cookie endpoints. Agent tokens cannot mint any credential.

`GET /auth/machines?board=<id>` returns `{version, machines: [{machine}]}` for the live computer credentials on that board, with duplicate computer ids listed once. It requires that board's machine credential or a person session with current repository write access; agent tokens and credentials from another board are refused. `relay off` excludes its own computer from the list and warns which joined computers lose the shared copy if the phone approves deletion. JSON also returns those ids in `affectedMachines`. Local unlink still succeeds when the relay cannot supply the list.

After phone-approved deletion, a previously live scoped credential receives HTTP 410 / `RELAY_BOARD_DELETED` for that deleted copy. The relay retains only its hash, board id and original expiry as a deletion receipt, prunes expired receipts, and grants no access through them. Unknown, already revoked and already expired credentials receive `AUTH_REQUIRED` as before. Only a versioned deletion response naming this link's own board turns a joined computer back into a local board. The CLI removes the inert link and its device key, excludes the project from automatic relinking, and retains a private credential-free notice that the relay copy was deleted; native board contents remain local. A successful explicit `relay on` starts a new link and clears that notice. A network outage or ordinary credential refusal does not authorize this transition. Before forgetting a deleted copy, the CLI commits any pending native move and its durable receipt locally. The notice keeps only the receipt id and intent digests, so interrupted cleanup or an explicit repeat can return the original outcome without applying that move twice; different local work can continue beside it.

A machine publishes an opaque approval with `POST /api/v1/devices/approvals {context,sealed}`. The publishing machine may GET only its own requests. The paired phone reads `/api/v1/devices/:deviceId/approvals`, explicitly POSTs `/:requestId/authorize {}` and completes the encrypted reply through `/:requestId/complete {response}`. The publishing machine executes a native revocation through `/:requestId/execute {grant}`; the two-minute grant binds the entire context and is atomically consumed once. Native reply keys and grants never persist. A refused foreground approval fails immediately with the original refusal code and reason plus its request id. A refused remote approval makes local unlinking or registration exit nonzero while retaining the completed local work: one line names that completion, the refusal code and reason, the request id and the next action. The JSON result preserves the local outcome and includes `remote: {code, reason, requestId}`. New-board linking uses a durable non-person reply key and returns only a board-scoped machine credential. `relay off` immediately unlinks locally even offline or in an agent shell, reports that the relay copy remains, and queues a separate one-tap phone deletion request when possible.

The result and refusal tables are checked against `JSON_SHAPES` in `src/json.js` by `docs/api.test.js`.

When `verify <id> accept` runs a frozen check and refuses with `CHECK_RED` or `CHECK_UNVERIFIED`, `error.message` includes its output digest, up to 40 sanitized tail lines, and `full output file: <path>`. The file is written with owner-only permissions. If diagnostic storage fails, the message says `full output file: (unavailable: CODE)` while retaining the bounded sanitized lines; the JSON error object remains `{ code, message, next }`. An item with no frozen check produces no check-output section and records `check: "none"` without requesting a native test or browser slot. Its submitted-commit, frozen-digest, trunk, dependency, review-reservation, and verdict guards still apply.

## MCP server

`pullboard mcp` serves MCP tools over stdio for the agent of the checkout it starts in. The agent's own MCP client launches it from that agent's worktree, for example as a stdio server whose command is `pullboard mcp`. It speaks newline-delimited JSON-RPC 2.0 on stdin and stdout; stdout carries only protocol messages and diagnostics go to stderr. The server opens no network connection and needs no dependency. It exits when the client closes stdin. It takes no arguments, and `--json` is refused with `USAGE` because stdout belongs to the protocol.

It answers `initialize` with `protocolVersion` (the client's, when it is `2025-06-18`, `2025-03-26` or `2024-11-05`, otherwise `2025-06-18`), `capabilities: {tools: {}}`, `serverInfo: {name: "pullboard", version}` and `instructions` naming the seat's agent. It also answers `ping`, `tools/list` and `tools/call`; notifications such as `notifications/initialized` get no reply, and any other method gets JSON-RPC error `-32601`.

| Tool | Input schema | Mirrors | Result |
| --- | --- | --- | --- |
| `board_status` | `{}` | `pullboard status` and `pullboard list` | the `status` document plus `items` (open and active items) and `needsYou`: the `decisions` and `holds` fields of the view's board projection, unshaped, as the view's Needs-you reads them; spec rows that need the person come with #702 |
| `show_item` | `{id: integer}` | `pullboard show <id>` | the `show` document |
| `shout` | `{to: string, text: string}` | `pullboard shout <to> <text>` | the `shout` document |
| `capture_idea` | `{text: string}` | `pullboard shout coordinator "idea: <text>"` | the `shout` document; until ideas become their own kind of item, an idea is a shout to the coordinator whose text starts `idea: ` |

`needsYou` is read-only and comes from the same projection as the local API's board state and the view: `decisions` are the open decisions addressed to the person and `holds` the held lanes. It carries no spec rows yet; spec rows that need the person come with #702. Building that projection reads every item and the spec file's history, so `board_status` is slower on large boards than the other tools.

Every input schema sets `additionalProperties: false`; an unknown argument or a value of the wrong type returns `BAD_REQUEST`. A value of the right type goes to the CLI as it is, so a blank shout returns the CLI's `EMPTY_SHOUT` and item `0` its `USAGE`. No argument names an author, a seat or a channel: the author of every move is the agent of the checkout the server runs in.

Each tool runs the CLI command it mirrors through the same engine as the terminal and the local API, with its arguments as distinct argv entries after `--`, so a move records the same events and a refusal carries the CLI's own `code`, `message` and `next`. A result's `content` is one `text` part holding the versioned JSON document, which `structuredContent` repeats. A refusal is a result with `isError: true` and the versioned refusal document. A tool name the server does not offer gets JSON-RPC error `-32602` with an `UNKNOWN_TOOL` refusal in `data`.

A person's own moves never come through MCP (P6). A tool call that names one (approving or declining rows, answering a decision, signing off) returns `HUMAN_REQUIRED` before any argument is read, whatever the client claims in its arguments, `_meta`, `clientInfo` or environment, and from any seat, including the main checkout. Every engine call the server makes also carries the `mcp` channel, which the CLI's own person check refuses. The refusal's `next` says to ask the coordinator to bring the call to the person. Live notifications over MCP are not offered yet.

## Local HTTP API v1

Run `pullboard serve --port 0` to print a private API address on `127.0.0.1`. Authenticate each call with the address's `k` query parameter, an `X-Pullboard-Key` header, or `Authorization: Bearer <key>`. The secret belongs to that server session. Board ids are random 128-bit values stored in each board; reopening or moving a repo preserves its id.

The server checks any Origin against its own address and grants no CORS permission. JSON request bodies are limited to 100000 bytes; oversized bodies are drained and refused without applying a partial move. A missing or invalid registered folder does not hide readable boards: it appears in `warnings` with its registry display fields and a versioned refusal whose `next` field explains how to restore or forget it.

| Method and path | Result |
| --- | --- |
| `GET /api/v1/boards` | Registered boards with their project details and ids |
| `GET /api/v1/boards/:board/state?seen=N` | The board state, listing item summaries, including open coordinator requests and the unseen shout count since N |
| `GET /api/v1/boards/:board/state?detail=full` | The same state with every item in full, which static view exports read |
| `GET /api/v1/boards/:board/state?since=N` | What changed in the summary state since the snapshot this server sent at event N, and the new latest sequence |
| `GET /api/v1/boards/:board/items/:id` | One item's full detail: the fields its summary leaves out |
| `GET /api/v1/boards/:board/items?q=text` | The ids of the items whose id, title, lane, spec ids or criterion contain the text, ignoring case |
| `GET /api/v1/boards/:board/shouts/:id` | One shout from any point in the board's history, including its decision and answer fields |
| `GET /api/v1/boards/:board/code?ref=path:lines@commit&before=...` | A bounded preview of committed file lines from that registered board |
| `GET /api/v1/boards/:board/events?after=N` | Events after sequence N, in order, and their event-log format version |
| `GET /api/v1/events?boards=<id>,<id>` | One live stream of every named board's events and changed signals, each tagged with its board |
| `POST /api/v1/boards/:board/moves` | One CLI move and its emitted event |
| `POST /api/v1/boards/:board/requests` | A person's request for the coordinator (view only) |

The boards response keeps `boards` and may include `warnings` for registered entries that could not be opened. State `seen` must be a nonnegative safe integer; omitting it retains the `unseen: null` result. State continues to include only the newest 40 shouts. Use `GET /api/v1/boards/:board/shouts/:id` to resolve an older address; its `{ shout }` result contains the complete stored shout row, including sender, recipient, text, timestamp, decision flag and reply relationship. Decision shouts also include `decision_state` (`open` or `answered`) and `decision_answer` (the reply row or `null`); other shouts use `null` for both fields. A missing id returns `NO_SHOUT` with HTTP 404; malformed ids are refused with HTTP 400. Code previews read only a registered repo's committed tree, use a plain commit SHA and at most 60 lines, and never read the working tree. The shared router lets adapters omit the optional code capability; such adapters return the versioned `CODE_NOT_AVAILABLE` refusal.

The state from `pullboard serve` lists every item as a summary of what the lists and the roadmap read: `id`, `title`, `lane`, `status`, `route`, `milestone`, `specs`, `claim`, `builtBy`, `blockedBy`, `updatedAt`, `stage`, `since`, `counts` and `verdict`. `milestone` names the first roadmap milestone that lists the item, or is `null`. `claim` is the live lease on the item, `{by, until}`: its builder's while it is claimed, or its reviewer's while a submitted item is reserved for review; otherwise it is `null`. `stage` is the item's status, except `accepted` for a verified item and `merged` once a merge is recorded. `since` is when the item entered that stage: edits, review reservations and renewals do not restart it, and a lapsed claim's stage starts at its recorded lease deadline. `counts` has the item's number of `verdicts` and `facts`. `verdict` keeps only the latest verdict's `decision` and `reason`, or is `null`; for an item sent back and not verified, it also keeps `note`, the first nonblank line of that reject's note. The state also has `moveCounts`, the board's lifecycle moves keyed `from>to:verb`, as the view's lifecycle drawing counts them.

`GET /api/v1/boards/:board/items/:id` returns `{item}`: the item's `id` and every field its summary leaves out, which are `owner`, `reviewer`, `reviewUntil`, `verifiedBy`, `criterion`, `brief`, `commit`, `merged`, `history`, `check`, `checkBaseline` when recorded, `verdicts`, `thread`, and the latest `verdict` in full. Laid over its summary, the detail is the item exactly as the full state carries it. An unknown id returns `NO_ITEM` with HTTP 404; a malformed id is refused with HTTP 400. `state?detail=full` returns every item in full, summary fields included, and `detail=summary` returns summaries; any other value is refused with `BAD_REQUEST`. Without `detail`, a server answers with its own default, `stateDetail: "summary"` or `"full"`: `serveApi`, which `pullboard serve` runs, defaults to summaries, and `createLocalApiHandler`, which a page's own server builds, defaults to full items until that page reads summaries. `GET /api/v1/boards/:board/items?q=text` returns `{ids}`, in state order, for the items whose `#id`, title, lane, spec ids or criterion contain the trimmed text, ignoring case, as the view's search matches; empty text matches every item. An adapter without these reads, such as the relay, whose state carries every item in full, returns `ITEM_NOT_AVAILABLE`.

Every state names the event it reflects as `sequence`, the latest event id when it was read. `GET /api/v1/boards/:board/state?since=N` answers `{since, sequence, eventLogVersion, delta}`, where `sequence` is the new latest and `delta` brings the summary state this server sent at event N up to date: `delta.replace` holds whole fields that changed, `delta.merge` holds keyed lists by field, as `{key, set, ids?}`, with only their changed entries and, when entries came, went or moved, the full key order, and `delta.remove` names fields that went away. Items merge by `id`, `shouts` and `asked` by `shout_id`, `events` by `event_id`, `agents` by `agent_id`, `spec` and `practice` rows by `id`, and `milestones` by `name`. `unseen`, `proofStats` and the Needs-you lists, `decisions`, `holds`, `requests` and `personRequests`, always come whole. Apply a delta without recomputing anything: copy `replace` over the state, delete each `remove` field, and for each `merge` field, overlay `set` on the entries by `key` and order them by `ids`, or keep their order. `applyStateDelta(state, delta)` in `src/api-http.js` does exactly this, and the result equals a fresh snapshot at `sequence`. A delta also carries changes that wrote no event, such as a spec or doctrine edit, so its `sequence` may equal N. N alone cannot say which of the snapshots sent at N a client holds, so after such a change a later delta from the same N may repeat it; it still applies exactly.

A server keeps, in memory only, the fingerprints of the last 24 summary states it sent for each board, as snapshots or as a delta's result; a read of one item or a search sends no snapshot, so it never makes a base. When it cannot extend the client's snapshot, `delta` is `null` and `reset` says why, with `{code, message, next}`: `BASE_NOT_KEPT` when it never sent a snapshot at N or has forgotten it, as after a restart; `BASE_AHEAD` when N is past the board's latest event; and `FORMAT_CHANGED` when the request's optional `eventLogVersion` differs from the server's. The client then loads a fresh snapshot. `since` must be a nonnegative integer (`BAD_CURSOR` otherwise), works with `seen`, and is refused with `detail=full`; an adapter without deltas, such as the relay, returns `DELTA_NOT_AVAILABLE`.

Core readers can call `allShouts(board)` for every stored shout, oldest first, without advancing any agent's unread cursor. Static exports can use that read to retain text for old shout addresses. Relay snapshots carry the same history only inside their authenticated, encrypted presentation; the relay service receives no plaintext shout history. Older presentations without complete history return `SHOUT_NOT_AVAILABLE`; refresh them with a current CLI.

The local board state and events responses include `eventLogVersion`, which identifies the persisted event-record format separately from the HTTP envelope's `version`. Static view exports keep this field in both state.json and events.json so a reader can refuse a format newer than it understands. Sealed relay events do not use this local board format marker.

The coordinator maintains the roadmap with `milestone add <name> [--note ...] [--items 1,2,3]`, `milestone items <name> --add|--remove ids`, `milestone move <name> --before <other>`, `milestone edit <name> [--name <new>] [--note <text>]`, and `milestone remove <name>`. A milestone stores only its name, optional note, and ordered item ids in `board_meta`; removing a milestone leaves its items untouched. A `repo#id` reference uses a registered repo's display name (or its folder name) before `#`; its status is read from that board when the repo is registered on this machine. `pullboard roadmap` prints milestones in order with a verified-item done count. Its JSON results and API state use `{ name, note, items: [{ id, title, status }], done, total }` for each milestone.

<!-- api-http-shapes:start -->
| Response | Required top-level fields |
| --- | --- |
| `boards` | `version:number`, `boards:array` |
| `state` | `version:number`, `state:object` |
| `delta` | `version:number`, `since:number`, `sequence:number`, `delta:object\|null` |
| `shout` | `version:number`, `shout:object` |
| `item` | `version:number`, `item:object` |
| `items` | `version:number`, `ids:array` |
| `events` | `version:number`, `events:array` |
| `move` | `version:number`, `event:object`, `result:object` |
| `request` | `version:number`, `event:object`, `result:object` |
| `stream` | `version:number`, `event:object` |
<!-- api-http-shapes:end -->

A move body is `{verb, item, args, agent}`. `item` is the positive integer id when the move needs one. `args` names its CLI positional arguments and flags; text values stay literal, including leading dashes. Omit `agent` to act as the coordinator, or name a registered agent to run in its worktree. Coordinator verification takes `args.as: "coordinator"`, matching the CLI's explicit identity check. The local session secret may act as any agent on that board. `result` is the CLI's JSON result. `next` claims work atomically; when a claim is already held it renews it and returns the renewal event. With no work available it returns the CLI's `NOTHING_FREE` refusal. Waiting remains a CLI option. `reopen` is coordinator-only: `args.note` is required, and it returns a submitted item to open without adding a verdict or replacing its last submitted commit.

Decision moves keep the CLI's routing: `shout` with `args.decision: true` may omit `args.to`; agents ask their coordinator, and the coordinator asks the person. `pass` takes the decision's id as `item` and `args.note`. Answering a decision addressed to the person requires `answer` with `args.as: "person"` from the coordinator's main checkout. Other callers receive the CLI's refusal.

`spec approve <ids>` and `spec decline <ids> --reason "why"` record the person's exact row decision without writing repo files. Bare ids name SPEC.md rows; `doctrine:<id>` names a repo doctrine row. These commands refuse agent shells and agent worktrees. The authenticated local view uses moves `spec-approve` with `args: {ids: "G1 G2", by: "<optional SSH principal>"}` or `spec-decline` with `args: {ids: "G1", reason: "why"}`, acting through the main checkout. Pending rows keep their source `status` and add `decision` and `stage` (`approved, pending apply` or `declined, pending apply`) in `spec show` and the shared view/API state.

Only the coordinator runs `spec apply`. It preflights every pending row against the exact source text, refusing stale decisions before writing any file. Approval changes the status to `approved`; decline changes it to `wont` with the person's reason as the row text, preserving trailing fields. SSH-enabled approvals carry one signed `row-decision` receipt binding the file, source, replacement, decision, reason and row text. Apply copies that same receipt into `.pullboard/signoffs.jsonl`; it remains a current exact-text sign-off. Commit the changed files and receipts together.

To answer a pending question row (`<ask>: <default>. Choices: a, b.`, as `blueprint add` writes it), the person runs `spec answer <id> "<choice or text>"`, or the local view sends `spec-answer` with `args: {row: "B1", answer: "Postgres"}`. A listed choice matches in any case and keeps its listed spelling; other text joins the choices last. It refuses agent shells, agent worktrees and the API channel, records the same exact-row approval receipt, whose JSON `decisions` carry an `answer` read back from the signed text (never stored on its own), and the row leaves pending when the coordinator runs `spec apply`. `spec check` errors on a question that was pending at the trunk tip and now differs with no matching person decision.

To approve new wording, the person uses `spec approve <one-id> --text "exact proposed text"`, or `spec-approve` with `args: {ids: "G1", text: "exact proposed text"}`. This records the same exact-row receipt; files wait for coordinator apply. Text must be one nonempty line without a field separator. Pre-commit checks the staged row against that person decision or a verified staged SSH sign-off; unstaged receipts cannot authorize a commit.

A coordinator criterion or check correction on a live claim remains pending until its holder or the coordinator runs `pullboard refreeze <id>`. Renewal and submission refuse with `PENDING_REFREEZE` until then. This refreeze keeps the holder, lease and claim base, and returns `retainedClaim: true` in JSON.

Doctor and resume report every stale frozen item after cited text changes. Open, claimed and submitted items suggest coordinator refreeze. Verified and merged items keep their receipts, report that they shipped against the old text, and suggest adding a follow-up citing the changed row. Resume JSON includes these findings in `stale`.

The SQLite schema marker is now `PRAGMA user_version = 2`. Opening an older board upgrades it in place: `board_meta` stores the id as `meta_key = "board_id"` and a 32-character hexadecimal `meta_value`; `shout_request` and `shout_request_outcome` mark requests and their answers. Existing items, agents and events remain intact. The HTTP envelope stays at version 1 independently of the SQLite schema marker.

A request body is `{text}`. It creates a request from the person to the coordinator. Open requests stay first in coordinator `resume` and `inbox` until answered `done`, or `declined` with a reason, and do not count as open decisions.

For live events, send `Accept: text/event-stream` to the events path. Ordinary messages have an `id` equal to their event sequence and `data` has the `stream` shape above. The local server also sends `event: changed` with `data: {"version":1,"event":{"event_kind":"changed"}}` when a view input changes without a board event; that notification has no `id` and does not move the reconnect cursor. Reconnect with `Last-Event-ID` to resume after the last ordinary event sequence; it takes precedence over `after`.

To follow several boards on one connection, send `Accept: text/event-stream` to `GET /api/v1/events?boards=<id>,<id>`, naming each board once by its id from `GET /api/v1/boards`. A browser holds at most six connections per origin, so a project group's view follows all its repos through this one stream. Each frame's `data` also names its `board`: an event is `{"version":1,"board":"<id>","event":{...}}`, and the changed signal is `{"version":1,"board":"<id>","event":{"event_kind":"changed"}}`, sent on the same terms as a single board's. An ordinary event's `id` carries one cursor per board, `<id>:<sequence>` pairs joined by commas, so reconnecting with `Last-Event-ID`, or passing the same cursor as `after`, resumes each board where it left off. A followed board the cursor leaves out starts from its first event, and a pair for a board not followed is ignored. Every named board must be one the caller may read: otherwise the request is refused with that board's refusal, naming the board, and nothing is streamed. The path is live only; a request without `Accept: text/event-stream` is refused with `BAD_REQUEST`. The single-board events path is unchanged.

`pullboard watch` follows this same stream from a terminal. It uses the running view's stream when the view serves the board, and otherwise serves API v1 for that one board on a private loopback port and follows that. It prints one line per event, or one JSON document per line with `--json`; it only reads the board. A dropped stream is followed again with `Last-Event-ID` set to the last sequence it handled, and `--since <sequence>` starts a new watch there. Work notices from `--work <lane>` (`claimable`, `review-wait` and `main`) carry `notice: true` and the sequence they follow.

The local server uses a shared HTTP router. Streams recheck access before each poll and close with a versioned refusal if access ends. Slow readers pause delivery and resume from the last delivered sequence.

HTTP refusals use the same versioned error envelope above: 400 for malformed calls, 401 for a missing or wrong session secret, 403 for an agent belonging to another board, 404 for an unknown board, path or shout, and 409 for the CLI engine's refusal. Shouts and answers append their events in the same transaction as their records. A move returns its own event, including when it also sends a coordinator shout.

## SSH spec sign-offs

`pullboard spec signers add [--key <path>] [--by <principal>]` opts a repo into OpenSSH-signed spec sign-offs. The key defaults to Git `user.signingkey`, then `~/.ssh/id_ed25519.pub`. The principal defaults to the exact Git `user.email`; `--by` overrides it. `spec signoff` uses the same email default in a repo with SSH signers, and accepts `--by` when a listed principal differs. A row's `signers:` names those exact principals. Spec checking refuses a required principal without a corresponding signer entry.

The initial command output names `.pullboard/signers`, `.pullboard/first-commit` and `.pullboard/signers.initial` for staging and committing. Later sign-offs and signed signer-list changes are recorded in `.pullboard/signoffs.jsonl`; commit that file with the corresponding signer-list change.

Every signed row and signer-list change binds the initial signer-list hash in its canonical text. Rewriting `.pullboard/signers.initial`, or relabelling that hash in earlier receipts, invalidates those receipts.

## Sealed person requests

The authenticated relay page calls `cockpitPage` with `readOnly: true` and the separate `requests: true` capability. This enables only the person's literal intents through the sealing transport; generic API writes remain refused. Local read-only pages and exported snapshots omit this capability and refuse every action.

A paired relay browser translates `add`, `shout`, `answer`, `hold` (including `args.off: true`), `spec-approve` and `spec-decline` into literal CLI intent. Its transport accepts `{verb, item?, args}` at the paired board's moves address and seals a separate request document before posting `{sequence, sealed}` to `/api/v1/boards/:board/requests`. It never sends plaintext arguments, an engine operation or the board key. The relay stores and orders that opaque envelope; it neither executes a command nor writes a repository. Agent credentials cannot submit person intent or person-attributed holds and releases.

The device-only request format is `{version: 1, type: "person-request", id, move: {verb, item?, args}}`. This request version is independent of the ordinary move engine version. The stable `id` survives interrupted sends and sequence collisions. Browser storage keeps each pending request's ciphertext separately, so another tab cannot replace or clear it. A later board read reconciles pending sends with the relay's acknowledged prefix before retrying.

The next ordinary local Pullboard command receives requests in relay order. One linked native device claims each request for ten minutes, measured exclusively from relay receipt timestamps, and runs its literal arguments through the actual CLI in the coordinator's primary checkout, outside the relay lock. Lane, brief, spec, person-channel and other CLI checks run there. Receiving a request never calls an engine operation directly. Its committed result travels as an ordinary move; durable request and move receipts prevent command retries from applying that result twice. A restarted device resumes its durable stages. After the executor lease expires, another linked device may claim the waiting request; each executor has distinct move ids, while the request’s atomic result and status prevent a late executor from creating another effect. Network or sign-in failures leave the request waiting.

Local `GET /api/v1/boards/:board/state` and the device-decrypted relay presentation expose additive `state.personRequests`. Each entry has:

| Field | Meaning |
| --- | --- |
| `id` | Stable request identity |
| `sequence`, `at` | Original relay position and timestamp |
| `by` | `person` for authenticated person intent; a refused sender names its authenticated actor |
| `move` | Literal `{verb, item?, args}`, or `null` for refused malformed input |
| `status` | `waiting`, `done` or `refused` |
| `error` | Present for refusal: the original `{code, message, next}` CLI guidance, or a typed format/sender refusal |
| `result`, `resultSequence` | Optional committed ordinary-move result and its relay position |
| `coordinatorRequest` | Optional local shout id for a repository-change request |

A browser action's decoded response is `{version: 1, event, result: {request}}`; `request` has the same status shape. `event` is the opaque acknowledgement, or `null` when reconciliation finds the earlier acknowledgement already in a sealed checkpoint. Direct actions become `done` when their actual CLI move commits. A refused add, for example, retains `UNKNOWN_SPEC` and the same explanation and next step as the terminal command, without creating an item. Answers always use the person channel; holds and releases keep the coordinator's execution guard while attributing the decision and event to the person.

Row approval and decline first record the person's exact decision through the same authenticated view boundary as the local view, without editing any file. They then create a person-to-coordinator request to run `spec apply`. That request is first in coordinator `resume` and `inbox`. Its status stays `waiting` until the coordinator applies it and answers `done`, or answers `declined <reason>`. Decline resolves the request as `refused` with `REQUEST_DECLINED`, the coordinator's reason and a next step. The browser and relay never run `spec apply`.

`pullboard hold <id> "reason"` holds one open or claimed item; `pullboard hold <id> --off` lifts that hold. Both retain the `hold` JSON shape (`lane`, `held`) and add `id` and `reason` (null when lifted). Held open items are skipped by `next` and refuse new claims with `ITEM_HELD`; an existing live holder can renew and submit. `show` and `list` include the hold actor and reason. Successful `next --json` results may include `reasons` naming skipped holds.

### Landing batches

`pullboard land [--max N] [--dry-run] [--adopt]` is coordinator-only. It merges verified items in verdict order in a separate landing worktree, gates the batch once and records pushed merges. Conflicts and stacked unverified items are named separately. Reproducible failures are bisected; a failing file which passes alone files one flake and holds the batch without retries. Resume includes `landingBatches`, each with its state, owner, exact tip, items and log path.

The landing gate sets `PULLBOARD_LANDING_RUN=1` only for its test runner. In that mode, the runner requires process isolation and POSIX process identities; it stops scheduling files after the first test-file failure, interrupts files already running, and reports the failure, interrupted files, and selected files not run. Landing early-stop fails before starting tests on Windows because the runner cannot safely identify and drain owned worker descendants there. It uses Node's execution-ordered test completion events; ordinary focused runs and all non-landing gates keep normal scheduling. The runner clears this marker for test workers and nested commands. If a process-identity census stays unavailable, tests still determine the gate result; the runner reports cleanup as `UNVERIFIED` and does not signal processes whose identity it could not establish. A `UNVERIFIED` cleanup report means descendant cleanup was not confirmed.

With `landingShards: N` in `pullboard.json` (a whole number from 1 to 64; absent or 1 keeps one run), the landing run of `bin/run-tests.js` splits the tracked test files into N shards. It balances them by each file's wall time from the last sharded landing, kept in the repository's `pullboard/landing-file-times.json`; with no times it balances by file count. The first shard uses the gate's own slot. Each other shard takes a landing-priority gate slot, locally or on a registered runner. The run is green only if every shard is green. The first red shard stops the others, which are reported as `stopped`. A shard whose runner fails mid-run prints `landing shard <i>/<n>: runner <host> failed mid-shard; rerunning shard <i>/<n> locally` and reruns on a local slot. Runner refusals are classed by code. `RUNNER_SETUP_REFUSED` and `RESOURCE_LEASE_LOST` rerun locally, with the code and host in the log. `RUNNER_CLEANUP_TIMEOUT` reruns locally and also quarantines that host for the rest of the landing, printing `landing runner <host> quarantined for the rest of this landing: <message>`. `RUNNER_SOURCE_CHANGED` and any unknown code fail the landing red as `refused`, with no retry. The landing pins its source (HEAD, tracked changes, and the names and contents of untracked files) before the first shard. A local shard, first run or rerun, checks that source before and after it runs and refuses as `LANDING_SOURCE_CHANGED` if the checkout moved, so a result never comes from other code. Stopping a local shard first records every process it owns from the process census: its parent-tree descendants, including detached ones in their own group or session, and their group members. It then sends TERM so the shard's run-tests drains through its own custody, and signals whatever the census still finds. Processes that cannot be shown gone are named as `[LANDING_SHARD_CLEANUP_UNVERIFIED]` in the log and in `landingShards.unverified`, with an instruction to inspect them before another run. The merged log prints one `# landing shard <i>/<n> on <host>: <green|red|stopped> in <ms> ms` line per shard and one `# landing file <i>/<n> <host> <ms|-> <path>` line per file. It also names how the plan was balanced (`history`, `history and average` or `file count`) and, once history exists, the slowest recorded file as `# landing floor: <ms> ms <path>`, since no shard count can finish sooner. The gate profile carries the same fields as `landingShards.balance`, `landingShards.floor`, `landingShards.shards` and `landingShards.files`. Every shard takes any free gate slot, so a runner with two slots can run two shards, and each local shard needing Chrome still waits for the machine's `browserSlots`.

Only the person can run `pullboard land --waive <test> --until <date> --reason "why"`. A waiver retains every test in the full gate. The batch records its exact tree and each failing test with its covering live waiver; pre-push validates that distinct proof and creates no ordinary green stamp. Expired waivers cannot authorize a push. Existing gate-stamped pushes and `pullboard merged` remain available.


### Person authority stays outside the standalone API

A `pullboard serve` key grants access to a board; it does not identify the person. API moves always use a non-person channel, including when the server was started in an ordinary terminal. `spec-approve`, `spec-decline`, answering or verifying with `as: person`, and any other person-only move are refused with `B26_PERSON_CHANNEL` without recording an event. Token revocation through the standalone API is refused for the same reason. Spec signing off is not an offered API move. Use the person's terminal or the actual `pullboard view` page for person actions; ordinary agent moves remain available through the API.

The view's own page retains its person channel. The standalone API refuses `POST /api/v1/boards/:board/requests` with `B26_PERSON_CHANNEL`; the view continues to record the person's coordinator request. Residual: an agent that starts `pullboard view` itself also holds that view's link; this change does not isolate that link from the agent. Signed person moves (#408) address that separate boundary.

`runner add` registers machine-local SSH capacity. Optional `--node` and `--root` select absolute remote paths when Node is outside the SSH login path or runner storage needs a specific location. The default storage root is `~/.pullboard-runner`; runner work shares the remote machine resource pool.

Runner storage keeps one repository object cache and creates an isolated checkout with complete history per run. A locked inventory handshake transfers only missing committed objects after scanning their blobs, paths and commit metadata, including ancestors. Historical protected paths are checked before connecting. A credential-free HTTPS origin may seed the cache at a locally known published ancestor; caller credentials are never forwarded. Cached object contents are not rescanned on every run.

Each checkout with a committed npm lockfile runs `npm ci`, including lifecycle scripts. Only npm's content cache is shared; installed dependencies and generated files stay in the fresh checkout. Other lock managers are refused. Combined command output and transport diagnostics are bounded at 64 MiB; exceeding that limit refuses the run.

Post-run cleanup reports `RUNNER_CLEANUP_TIMEOUT` after 30 seconds instead of leaving the controller waiting indefinitely. That failure does not retry the command. The physical runner slot is released after its known children have drained and no unresolved live process remains; an unresolved live process keeps the slot occupied until cleanup can be verified.

When the runner's own resource pool refuses the run's setup, the run fails at once with `RUNNER_SETUP_REFUSED`, naming the runner host and the pool's refusal code. It is not retried, and it leaves no holder or waiter on either machine.
