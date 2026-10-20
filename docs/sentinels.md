# Sentinels

A sentinel is a check that runs on a schedule and tells someone when it goes red. The board has two kinds. The health watch is built in and looks for stuck work. A board watch is a check your project defines, and the person approves it before it ever runs.

## How you use it

There are two watches to know about. Read the health watch first, since it needs no setup.

### The health watch

The health watch needs no setup. It looks at every item and reports the ones that are stuck: waiting too long on a claim, a review, a hold or a release. To see the current list, run:

    pullboard health

Each line gives the item, why it is stuck, since when, the next step and who takes it. The command exits with status 1 when anything is stuck, so a script can check for it.

The watch runs by itself. `pullboard resume` checks the board, and the view checks again every ten minutes while it is open.

When a finding appears or clears, the sentinel sends a shout. The coordinator always gets it. The owner gets it too when the owner is a person, a seat or a lane. You read these shouts in your inbox:

    pullboard inbox

The thresholds live in `pullboard.json`. `health.stuck` sets how long an item can sit before it counts, with a default of one hour. `health.holds` and `health.release` do the same for held lanes and release waits, with a default of one day each.

To turn the health watch off, set `health.sentinel` to `false` in `pullboard.json`, or in your machine settings.

### A board watch

A board watch runs a command you choose, such as a test suite, on a schedule. Anyone on the board can propose one, and only the person can approve it. An agent proposes a watch like this:

    pullboard sentinel propose nightly-build --check "true" --every hourly --owner coordinator

The schedule is `10m`, `hourly` or `daily`. The owner is the coordinator, a registered seat, or a lane. You can also set the working directory with `--directory <path>`, the time limit with `--timeout <milliseconds>`, and the next step a reader should take with `--next "<step>"`.

The person then approves the exact command, directory and schedule:

    pullboard sentinel approve nightly-build

Or the person declines it, with a reason:

    pullboard sentinel decline nightly-build --reason "<why>"

Approval binds to the exact row. If anyone changes the command, the directory, the schedule or the owner, the watch goes back to pending and must be approved again.

To see every watch, its approval, its owner and its last result, run:

    pullboard sentinels

This command reads the board and runs nothing.

### What happens when a board watch runs

Approved watches run during `pullboard resume`, once their schedule is due. A watch never runs twice at the same time.

The owner hears about a watch only when its result changes. A red result sends "Sentinel failed" with the output and the next step. The next green result sends "Cleared". Every red run is kept in the history, so nothing is lost between the two messages.

### How Rigor uses a sentinel

Each red run counts as a failure with the cause `sentinel:<name>`. Two red runs of the same watch make a repeated cause, and Rigor lists it in `pullboard rigor`. From there it follows the same path as any other repeated cause, so the coordinator can draft a rule and the person decides on it. See [Rigor](rigor.md) for how that works.

The path can also run the other way. When a repeated cause is one a check can watch, Rigor drafts it as a pending board watch, citing its repeats and the proof that the check fails and then passes. The person approves it from Needs you, the same way as any Rigor draft, and until then it does not run.
