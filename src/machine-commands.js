/**
 * Machine-wide commands that need no board (Q1): pullboard settings reads or sets this machine's
 * gate and browser capacity, and pullboard runner add registers SSH test capacity.
 */
import { Refused } from './refused.js';
import {
  addRunner,
  gateQueueSettings,
  gateShortSlots,
  loadMachineSettings,
  memoryFloorMB,
  relayOfferEnabled,
  setBrowserSlots,
  setGateShortSlots,
  setGateSlots,
} from './settings.js';

/** Read or update machine-wide gate capacity. */
export function settingsCommand(io, { first, second, rest }) {
  if (!first && !second && !rest.length) {
    const settings = loadMachineSettings();
    const queue = gateQueueSettings();
    // The result names the queue order in effect, defaults included; the file keeps only what was set.
    const offerAtInit = relayOfferEnabled();
    const shortSlots = gateShortSlots();
    io.result?.({ settings: { ...settings, gate: { ...settings.gate, queue: { ...settings.gate?.queue, ...queue }, shortSlots }, relay: { ...settings.relay, offerAtInit } }, memoryFloorMB: memoryFloorMB() });
    io.say(`gateSlots: ${settings.gateSlots}`);
    io.say(`browserSlots: ${settings.browserSlots}`);
    io.say(`gate.queue.reviewsFirst: ${queue.reviewsFirst}${queue.reviewsFirst ? '' : ' (landings first, then arrival order)'}`);
    io.say(`gate.queue.currentReleaseFirst: ${queue.currentReleaseFirst}${queue.currentReleaseFirst ? '' : ' (release priority is off)'}`);
    io.say(`gate.queue.agingMinutes: ${queue.agingMinutes}${queue.reviewsFirst || queue.currentReleaseFirst ? '' : ' (used only while reviewsFirst or currentReleaseFirst is true)'}`);
    io.say(`gate.memoryFloorMB: ${memoryFloorMB() ?? 'off (the gate queue does not wait for memory)'}`);
    io.say(`view.background: ${settings.view?.background !== false}${settings.view?.background === false ? ' (init and resume leave the view to you)' : ' (init and resume keep pullboard view running for pullboard.dev)'}`);
    io.say(`relay.offerAtInit: ${offerAtInit}${offerAtInit ? ' (init asks once to share your boards with your phone)' : ' (init stays quiet about sharing)'}`);
    io.say(`gate.shortSlots: ${shortSlots}${shortSlots ? '' : ' (off; runs that name their test files wait for a gate slot)'}`);
    return 0;
  }
  if (!['gateSlots', 'browserSlots', 'gate.shortSlots'].includes(first) || !second || rest.length) {
    throw new Refused('USAGE', 'pullboard settings gateSlots <n> | browserSlots <n> | gate.shortSlots <n>');
  }
  if (first === 'gate.shortSlots') {
    if (!/^(?:0|[1-9]\d*)$/u.test(second) || !Number.isSafeInteger(Number(second))) {
      throw new Refused('BAD_SHORT_SLOTS', 'gate.shortSlots must be a whole number, 0 or more; run pullboard settings gate.shortSlots <n>');
    }
    const settings = setGateShortSlots(Number(second));
    io.result?.({ settings });
    io.say(`gate.shortSlots set to ${settings.gate.shortSlots}`);
    return 0;
  }
  if (!/^[1-9]\d*$/u.test(second) || !Number.isSafeInteger(Number(second))) {
    if (first === 'gateSlots') throw new Refused('USAGE', 'pullboard settings gateSlots <positive integer>');
    throw new Refused(first === 'browserSlots' ? 'BAD_BROWSER_SLOTS' : 'BAD_GATE_SLOTS', `${first} must be a positive integer; run pullboard settings ${first} <n>`);
  }
  const settings = first === 'browserSlots' ? setBrowserSlots(Number(second)) : setGateSlots(Number(second));
  io.result?.({ settings });
  io.say(`${first} set to ${settings[first]}`);
  return 0;
}

/** Register machine-level SSH capacity without requiring a board identity or a runner account. */
export function runnerCommand(io, { first, second, rest, values }) {
  if (first !== 'add' || !second || rest.length || !/^[1-9]\d*$/u.test(values.slots ?? '')
    || !/^(?:0|[1-9]\d*)$/u.test(values.browser ?? '')) {
    throw new Refused('USAGE', 'pullboard runner add <ssh-host> --slots <positive integer> --browser <integer from zero through slots>');
  }
  const runner = addRunner({ host: second, slots: Number(values.slots), browser: Number(values.browser),
    ...(values.node !== undefined ? { node: values.node } : {}), ...(values.root !== undefined ? { root: values.root } : {}) });
  io.result?.({ runner });
  io.say(`registered runner ${runner.host}: ${runner.slots} slots, ${runner.browser} browser`);
  return 0;
}
