/** Machine-wide settings shared by every Pullboard checkout on this machine. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { machineHome } from './machine-home.js';
import { setResourceCapacity } from './resources.js';
import { Refused } from './refused.js';

const DEFAULT_GATE_SLOTS = 2;
const DEFAULT_BROWSER_SLOTS = 1;
const DEFAULT_QUEUE_AGING_MINUTES = 30;

/** Resolve the separate machine settings file. */
export function machineSettingsFile() {
  return join(machineHome(), 'settings.json');
}

/** Read and validate machine settings, preserving any unrelated settings. */
export function loadMachineSettings() {
  const file = machineSettingsFile();
  if (!existsSync(file)) return { gateSlots: DEFAULT_GATE_SLOTS, browserSlots: DEFAULT_BROWSER_SLOTS };
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Refused('BAD_MACHINE_SETTINGS', `cannot read ${file}; fix its JSON before running Pullboard`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `settings in ${file} must be a JSON object; fix it before running Pullboard`);
  }
  if (value.gate !== undefined && (!value.gate || typeof value.gate !== 'object' || Array.isArray(value.gate))) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate in ${file} must be an object; fix it before running Pullboard`);
  }
  if (value.gate?.browserFreeChecks !== undefined && typeof value.gate.browserFreeChecks !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.browserFreeChecks in ${file} must be true or false`);
  }
  const queue = value.gate?.queue;
  if (queue !== undefined && (!queue || typeof queue !== 'object' || Array.isArray(queue))) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.queue in ${file} must be an object; fix it before running Pullboard`);
  }
  if (queue?.reviewsFirst !== undefined && typeof queue.reviewsFirst !== 'boolean') {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.queue.reviewsFirst in ${file} must be true or false`);
  }
  if (queue?.agingMinutes !== undefined && (!Number.isSafeInteger(queue.agingMinutes) || queue.agingMinutes < 1)) {
    throw new Refused('BAD_MACHINE_SETTINGS', `gate.queue.agingMinutes in ${file} must be a positive whole number of minutes; fix it or remove it for the default ${DEFAULT_QUEUE_AGING_MINUTES}`);
  }
  const gateSlots = value.gateSlots ?? DEFAULT_GATE_SLOTS;
  if (!Number.isSafeInteger(gateSlots) || gateSlots < 1) {
    throw new Refused('BAD_GATE_SLOTS', `gateSlots in ${file} must be a positive integer; run pullboard settings gateSlots <n>`);
  }
  const browserSlots = value.browserSlots ?? DEFAULT_BROWSER_SLOTS;
  if (!Number.isSafeInteger(browserSlots) || browserSlots < 1 || browserSlots > gateSlots) {
    throw new Refused('BAD_BROWSER_SLOTS', `browserSlots in ${file} must be a positive integer no greater than gateSlots (${gateSlots}); run pullboard settings browserSlots <n>`);
  }
  return { ...value, gateSlots, browserSlots };
}

/** Browser-free check admission is deliberately opt-in per machine. */
export function browserFreeChecksEnabled() {
  return loadMachineSettings().gate?.browserFreeChecks === true;
}

/**
 * The gate pool's admission order. Reviews-first class order is opt-in per machine because it
 * changes who waits for whom on every board sharing the pool; absent or false keeps landings
 * first, then arrival. agingMinutes only matters while class order is on.
 *
 * @returns {{ reviewsFirst: boolean, agingMinutes: number }}
 */
export function gateQueueSettings() {
  const queue = loadMachineSettings().gate?.queue;
  return { reviewsFirst: queue?.reviewsFirst === true, agingMinutes: queue?.agingMinutes ?? DEFAULT_QUEUE_AGING_MINUTES };
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
