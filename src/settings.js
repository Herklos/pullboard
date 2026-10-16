/** Machine-wide settings shared by every Pullboard checkout on this machine. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { machineHome } from './machine-home.js';
import { setResourceCapacity, updateRunnerSettings } from './resources.js';
import { validateRunner } from './runners.js';
import { Refused } from './refused.js';

const DEFAULT_GATE_SLOTS = 2;
const DEFAULT_BROWSER_SLOTS = 1;

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
