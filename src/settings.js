/** Machine-wide settings shared by every Pullboard checkout on this machine. */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setResourceCapacity, updateRunnerSettings } from './resources.js';
import { validateRunner } from './runners.js';
import { Refused } from './refused.js';
import { gateQueueSettings, machineSettingsFile, readMachineSettingsFile, validateGateQueue } from './queue-settings.js';

// The gate queue's settings live in queue-settings.js so the runner runtime can read them too.
export { gateQueueSettings, machineSettingsFile };

const DEFAULT_GATE_SLOTS = 2;
const DEFAULT_BROWSER_SLOTS = 1;

/** Read and validate machine settings, preserving any unrelated settings. */
export function loadMachineSettings() {
  const file = machineSettingsFile();
  const value = readMachineSettingsFile(file);
  if (!value) return { gateSlots: DEFAULT_GATE_SLOTS, browserSlots: DEFAULT_BROWSER_SLOTS };
  if (value.gate?.browserFreeChecks !== undefined && typeof value.gate.browserFreeChecks !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.browserFreeChecks in ${file} must be true or false`);
  }
  validateGateQueue(value, file);
  if (value.relay?.offerAtInit !== undefined && typeof value.relay.offerAtInit !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `relay.offerAtInit in ${file} must be true or false`);
  }
  if (value.gate?.memoryFloorMB !== undefined && (!Number.isSafeInteger(value.gate.memoryFloorMB) || value.gate.memoryFloorMB < 0)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.memoryFloorMB in ${file} must be a whole number of megabytes, 0 or more; fix it before running Pullboard`);
  }
  const gateSlots = value.gateSlots ?? DEFAULT_GATE_SLOTS;
  if (!Number.isSafeInteger(gateSlots) || gateSlots < 1) {
    throw new Refused('BAD_GATE_SLOTS', `gateSlots in ${file} must be a positive integer; run pullboard settings gateSlots <n>`);
  }
  const browserSlots = value.browserSlots ?? DEFAULT_BROWSER_SLOTS;
  if (!Number.isSafeInteger(browserSlots) || browserSlots < 1 || browserSlots > gateSlots) {
    throw new Refused('BAD_BROWSER_SLOTS', `browserSlots in ${file} must be a positive integer no greater than gateSlots (${gateSlots}); run pullboard settings browserSlots <n>`);
  }
  const runners = value.runners ?? [];
  if (!Array.isArray(runners)) throw new Refused('BAD_MACHINE_SETTINGS', 'runners must be an array; use pullboard runner add <ssh-host> --slots <n> --browser <n>');
  const seen = new Set();
  for (const runner of runners) {
    validateRunner(runner);
    if (seen.has(runner.host)) throw new Refused('BAD_MACHINE_SETTINGS', 'runner hosts must be unique; remove the duplicate machine setting');
    seen.add(runner.host);
  }
  return { ...value, gateSlots, browserSlots, ...(runners.length ? { runners } : {}) };
}

/** Browser-free check admission is deliberately opt-in per machine. */
export function browserFreeChecksEnabled() {
  return loadMachineSettings().gate?.browserFreeChecks === true;
}

/**
 * The free-memory floor, in megabytes, below which the machine gate pool holds its queue, or null
 * when the hold is off. Gate and queue behavior is off by default, the person's rule, so an absent
 * floor keeps today's admission by slots alone.
 */
export function memoryFloorMB() {
  return loadMachineSettings().gate?.memoryFloorMB ?? null;
}

/**
 * Whether init asks the person once to share this computer's boards with their phone [H5,H17].
 * On unless the machine settings set relay.offerAtInit to false: the person asked for sharing to
 * be one Enter for new people, and a person who never wants the question turns it off here.
 */
export function relayOfferEnabled() {
  return loadMachineSettings().relay?.offerAtInit !== false;
}

/** Atomically replace machine settings without exposing a partial JSON file. */
function writeMachineSettings(settings) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/** Set machine gate capacity only when its durable holder and waiter lists are empty. */
export function setGateSlots(capacity) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Refused('BAD_GATE_SLOTS', 'gateSlots must be a positive integer; run pullboard settings gateSlots <n>');
  let next;
  setResourceCapacity({ name: 'gate', capacity, scope: 'machine', persist: () => {
    const current = loadMachineSettings();
    if (capacity < current.browserSlots) throw new Refused('BAD_GATE_SLOTS', `gateSlots cannot be lower than browserSlots (${current.browserSlots}); first run pullboard settings browserSlots <n>`);
    next = { ...current, gateSlots: capacity };
    writeMachineSettings(next);
  } });
  return next;
}

/** Set machine browser capacity only when its browser holders and waiters are empty. */
export function setBrowserSlots(capacity) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Refused('BAD_BROWSER_SLOTS', 'browserSlots must be a positive integer; run pullboard settings browserSlots <n>');
  let next;
  setResourceCapacity({ name: 'browser', capacity, scope: 'machine', persist: () => {
    const current = loadMachineSettings();
    if (capacity > current.gateSlots) throw new Refused('BAD_BROWSER_SLOTS', `browserSlots cannot exceed gateSlots (${current.gateSlots}); run pullboard settings gateSlots <n> first`);
    next = { ...current, browserSlots: capacity };
    writeMachineSettings(next);
  } });
  return next;
}

/** Register plain SSH capacity without storing credentials, and serialize updates with active dispatches. */
export function addRunner(value) {
  const runner = validateRunner(value);
  return updateRunnerSettings(runner.host, () => {
    const current = loadMachineSettings();
    const runners = [...(current.runners ?? [])];
    const index = runners.findIndex(entry => entry.host === runner.host);
    if (index < 0) runners.push(runner);
    else runners[index] = runner;
    writeMachineSettings({ ...current, runners });
    return runner;
  });
}
