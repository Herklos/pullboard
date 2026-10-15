# Cockpit performance harness

Run a repeatable local sample with:

```sh
node test/cockpit/perf/run.mjs --seed pullboard-perf-606 --size 3000 --runs 5 --idle 30 --live-every 5
```

The harness holds the shared browser-capable gate slot across fixture setup and measurement, creates a disposable board and machine home, starts the normal local view server, and uses an isolated real Chrome profile with real pointer and keyboard input. It measures first load, each cockpit tab, opening a small item and the longest-history item, search typing, and a 30-second idle interval while one board API writer adds a shout every five seconds. It reports each action's median and worst stable-paint time, counts Long Tasks longer than 50ms, and records resource request sizes. Unsupported Long Task observation is reported as unavailable rather than as zero tasks. The harness records measurements without applying a performance pass/fail threshold.

The default size follows the measured 605-item board shape and scales its status mix, long histories, event stream, agents, roadmap and spec rows. The generated spec keeps one draft row visible under the cockpit's default "Needs your decision" filter and the remaining rows approved; the status distribution appears in the board manifest and performance report. At the named-test size of 150, all generated roadmap milestones are shipped, so its roadmap action measures the visible, collapsed Shipped disclosure summary rather than expanded upcoming milestone content. The named test uses 150 items to check deterministic generation and action coverage; it does not assert timing values. Use the reported output as a measurement of the specific machine and run conditions, not as a guarantee for other environments.

The generated board, home, machine state and browser profile are temporary after a successful run. Use `--keep` to retain the generated board for inspection; local view keys are kept in process memory and are not included in output. A failed run retains its private board, browser profile and failure summary for diagnosis.
