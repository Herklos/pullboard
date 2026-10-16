/**
 * `pullboard init` (I1, I2): one command puts the method into a repo. It writes the config, a
 * starter spec and the agent instructions, installs the git hooks, opens the board and registers
 * the main checkout as the coordinator. It runs again safely and never overwrites a file it did not
 * write.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { CONFIG_FILE, COORDINATOR, doctrineFile, loadConfig } from './config.js';
import { loadDoctrine } from './doctrine.js';
import { installHooks } from './hooks.js';
import { machineHome } from './machine-home.js';
import { Refused } from './refused.js';
import { installSkills } from './skills.js';
import {
  AGENTS_END, AGENTS_START, agentsBlock, claudeLoopRules, codexLoopRules, configTemplate,
  plainGateWords, practiceTemplate, specTemplate,
} from './templates.js';

const NPM_DEFAULT_TEST = 'echo "Error: no test specified" && exit 1';

/** Keep an automatic machine-home write grant below the OS user home and away from filesystem roots. */
export function machineHomeWriteScopeIsNarrow(machinePath, userHome = userInfo().homedir) {
  const target = resolve(machinePath);
  const home = resolve(userHome);
  if (target === parse(target).root) return false;
  const homeFromTarget = relative(target, home);
  const targetContainsHome = homeFromTarget === '' || (homeFromTarget !== '..'
    && !homeFromTarget.startsWith(`..${sep}`) && !isAbsolute(homeFromTarget));
  return !targetContainsHome;
}

/**
 * Detect an existing ecosystem's test command without running it during setup (I1, I2).
 *
 * @param {string} root
 * @returns {string}
 */
export function detectGate(root) {
  const file = join(root, 'package.json');
  if (existsSync(file)) {
    try {
      const test = JSON.parse(readFileSync(file, 'utf8'))?.scripts?.test;
      if (typeof test === 'string' && test.trim() && test.trim() !== NPM_DEFAULT_TEST) return 'npm test';
    } catch { /* An unreadable package does not hide another ecosystem. */ }
  }
  if (existsSync(join(root, 'go.mod'))) return 'go test ./...';
  if (existsSync(join(root, 'Cargo.toml'))) return 'cargo test';
  if (['pytest.ini', '.pytest.ini', 'pytest.toml', '.pytest.toml', 'pyproject.toml', 'setup.py', 'requirements.txt'].some((name) => existsSync(join(root, name)))) return 'pytest';
  for (const [name, section] of [['tox.ini', 'pytest'], ['setup.cfg', 'tool:pytest']]) {
    if (existsSync(join(root, name)) && readFileSync(join(root, name), 'utf8').includes(`[${section}]`)) return 'pytest';
  }
  return '';
}

/**
 * The fixers to start with (C5): prettier, when the repo already depends on it, on every file it
 * understands. Only fast, deterministic fixers belong at commit time; slow ones stay in the gate.
 *
 * @param {string} root
 * @returns {{ run: string, files: string[] }[]}
 */
export function detectFixers(root) {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return [];
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    const hasPrettier = Boolean(pkg?.devDependencies?.prettier ?? pkg?.dependencies?.prettier);
    return hasPrettier ? [{ run: 'npx --no-install prettier --write --ignore-unknown', files: ['*'] }] : [];
  } catch {
    return [];
  }
}

/**
 * The gate the repo's config sets now, whoever wrote it, or empty when unreadable.
 *
 * @param {string} root
 * @returns {string}
 */
function configuredGate(root) {
  try {
    return String(JSON.parse(readFileSync(join(root, CONFIG_FILE), 'utf8')).gate ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Write a file only when it does not exist yet.
 *
 * @param {string} file
 * @param {string} text
 * @param {string} name
 * @param {(path: string) => void} onWrite
 * @returns {string} What happened.
 */
function writeNew(file, text, name, onWrite) {
  if (existsSync(file)) return `kept ${name}`;
  writeFileSync(file, text);
  onWrite(name);
  return `wrote ${name}`;
}

/** Ignore Claude's nested agent worktrees, preserving existing ignore bytes and second-run idempotence. */
function ignoreAgentWorktrees(root, onWrite) {
  const file = join(root, '.gitignore');
  const pattern = '.claude/worktrees/';
  const existing = existsSync(file);
  const previous = existing ? readFileSync(file, 'utf8') : '';
  if (previous.split(/\r?\n/u).includes(pattern)) return 'kept .gitignore (already ignores .claude/worktrees/)';
  appendFileSync(file, (previous && !previous.endsWith('\n') ? '\n' : '') + pattern + '\n');
  onWrite('.gitignore');
  return existing ? 'added .claude/worktrees/ to .gitignore' : 'wrote .gitignore (ignores .claude/worktrees/)';
}

/**
 * Put the agent instructions in AGENTS.md, appending pullboard's block to a file the repo already
 * has, and point CLAUDE.md at AGENTS.md so Claude Code reads the same rules.
 *
 * @param {string} root
 * @param {(path: string) => void} onWrite
 * @returns {string[]}
 */
function writeAgentDocs(root, onWrite) {
  const notes = [];
  const agents = join(root, 'AGENTS.md');
  const block = agentsBlock(loadDoctrine(root, loadConfig(root)));
  if (!existsSync(agents)) {
    writeFileSync(agents, `# AGENTS.md\n\n${block}`);
    onWrite('AGENTS.md');
    notes.push('wrote AGENTS.md');
  } else if (!readFileSync(agents, 'utf8').includes(AGENTS_START)) {
    appendFileSync(agents, `\n${block}`);
    onWrite('AGENTS.md');
    notes.push('added the pullboard section to AGENTS.md');
  } else {
    const previous = readFileSync(agents, 'utf8');
    const start = previous.indexOf(AGENTS_START);
    const end = previous.indexOf(AGENTS_END, start);
    if (end < 0) notes.push('kept AGENTS.md (incomplete pullboard markers; restore the closing marker to refresh)');
    else {
      const updated = previous.slice(0, start) + block.trimEnd() + previous.slice(end + AGENTS_END.length);
      if (updated === previous) notes.push('kept AGENTS.md');
      else {
        writeFileSync(agents, updated);
        onWrite('AGENTS.md');
        notes.push('updated the pullboard section in AGENTS.md');
      }
    }
  }
  const claude = join(root, 'CLAUDE.md');
  if (!existsSync(claude)) {
    writeFileSync(claude, '@AGENTS.md\n');
    onWrite('CLAUDE.md');
    notes.push('wrote CLAUDE.md (points at AGENTS.md)');
  } else if (!readFileSync(claude, 'utf8').includes('AGENTS.md')) {
    appendFileSync(claude, '\n@AGENTS.md\n');
    onWrite('CLAUDE.md');
    notes.push('pointed CLAUDE.md at AGENTS.md');
  }
  return notes;
}

/**
 * The session hook's command: pullboard from this checkout's install, else the main checkout's,
 * else the PATH, and silence when there is none, so a session never fails to start over it.
 */
export const RESUME_HOOK =
  'm=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)/..; for p in node_modules/.bin/pullboard "$m/node_modules/.bin/pullboard"; do [ -x "$p" ] && exec "$p" resume; done; command -v pullboard >/dev/null && exec pullboard resume; true';

/**
 * Have Claude Code run `pullboard resume` whenever a session starts, resumes or is compacted (I6), so
 * an agent picks its work up from the board rather than from a summary of it. The hook is merged
 * into .claude/settings.json; every other setting stays as it was.
 *
 * @param {string} root
 * @param {(path: string) => void} onWrite
 * @returns {string} What happened.
 */
function writeSessionHook(root, onWrite) {
  const file = join(root, '.claude', 'settings.json');
  let settings = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      settings = null;
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return 'kept .claude/settings.json, which is not a JSON object; add a SessionStart hook that runs pullboard resume';
    }
  }
  const starts = settings.hooks?.SessionStart ?? [];
  if (JSON.stringify(starts).includes('pullboard resume')) return 'kept the Claude Code session hook';
  settings.hooks = { ...settings.hooks, SessionStart: [...starts, { hooks: [{ type: 'command', command: RESUME_HOOK, timeout: 30 }] }] };
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  onWrite('.claude/settings.json');
  return 'added a Claude Code session hook: pullboard resume at every start and compaction';
}

/**
 * Merge Claude project rules and the exact machine-home sandbox write scope, preserving other settings.
 *
 * @param {string} root
 * @param {string} gate
 * @param {(path: string) => void} onWrite
 * @returns {string} A concise setup note.
 */
function writeClaudeLoopPermissions(root, gate, onWrite) {
  const file = join(root, '.claude', 'settings.json');
  let settings = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      settings = null;
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return 'kept .claude/settings.json because it is not a JSON object; add the Pullboard allow rules manually';
    }
  }
  const current = settings.permissions;
  if (current !== undefined && (!current || typeof current !== 'object' || Array.isArray(current))) {
    return 'kept .claude/settings.json because permissions is not an object; add the Pullboard allow rules manually';
  }
  const permissions = current ?? {};
  const allow = permissions.allow;
  if (allow !== undefined && !Array.isArray(allow)) {
    return 'kept .claude/settings.json because permissions.allow is not an array; add the Pullboard allow rules manually';
  }
  const existing = allow ?? [];
  const requested = claudeLoopRules({ gate });
  const missing = requested.filter(rule => !existing.includes(rule));
  const sandbox = settings.sandbox;
  if (sandbox !== undefined && (!sandbox || typeof sandbox !== 'object' || Array.isArray(sandbox))) {
    return 'kept .claude/settings.json because sandbox is not an object; add the Pullboard machine-home sandbox write path manually';
  }
  const currentFilesystem = sandbox?.filesystem;
  if (currentFilesystem !== undefined && (!currentFilesystem || typeof currentFilesystem !== 'object' || Array.isArray(currentFilesystem))) {
    return 'kept .claude/settings.json because sandbox.filesystem is not an object; add the Pullboard machine-home sandbox write path manually';
  }
  const filesystem = currentFilesystem ?? {};
  const allowWrite = filesystem.allowWrite;
  if (allowWrite !== undefined && !Array.isArray(allowWrite)) {
    return 'kept .claude/settings.json because sandbox.filesystem.allowWrite is not an array; add the Pullboard machine-home sandbox write path manually';
  }
  const machinePath = machineHome();
  const machinePathIsNarrow = machineHomeWriteScopeIsNarrow(machinePath);
  const machineWrites = allowWrite ?? [];
  const missingMachineWrite = machinePathIsNarrow && !machineWrites.includes(machinePath);
  if (missing.length || missingMachineWrite) {
    settings.permissions = { ...permissions, allow: [...existing, ...missing] };
    if (missingMachineWrite) {
      settings.sandbox = {
        ...sandbox,
        filesystem: { ...filesystem, allowWrite: [...machineWrites, machinePath] },
      };
    }
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    onWrite('.claude/settings.json');
  }
  const gateWords = plainGateWords(gate);
  const gateNote = gateWords ? `, and the detected gate (${gateWords.join(' ')})` : gate ? '; the configured shell gate was left for manual approval' : '';
  const editNote = requested.some(rule => rule.startsWith('Edit(')) ? ', plus edits within this worktree' : '';
  const permissionsNote = missing.length ? `allowed Claude Code's Pullboard loop and listed Git commands${gateNote}${editNote}` : 'kept the existing Claude Code Pullboard permissions';
  const machineWriteNote = !machinePathIsNarrow
    ? 'did not grant machine-home write because it is the OS home, an ancestor of the OS home, or a filesystem root; choose a narrower PULLBOARD_MACHINE_HOME'
    : missingMachineWrite ? 'added the exact Pullboard machine-home Bash write path' : 'kept the existing exact Pullboard machine-home Bash write path';
  return `${permissionsNote}; ${machineWriteNote}; an admin-required sandbox may ignore project-level write additions; existing deny and ask rules still apply`;
}

/**
 * Write project-local Codex command rules without touching the user's home or active-session config.
 *
 * @param {string} root
 * @param {string} gate
 * @param {(path: string) => void} onWrite
 * @returns {string} A concise setup note.
 */
function writeCodexLoopRules(root, gate, onWrite) {
  const file = join(root, '.codex', 'rules', 'pullboard.rules');
  const machinePath = machineHome();
  const rules = codexLoopRules(gate);
  let contents = '';
  if (existsSync(file)) contents = readFileSync(file, 'utf8');
  const lines = new Set(contents.split(/\r?\n/u));
  const missing = rules.filter(rule => !lines.has(rule));
  if (missing.length) {
    mkdirSync(join(root, '.codex', 'rules'), { recursive: true });
    const prefix = contents && !contents.endsWith('\n') ? `${contents}\n` : contents;
    writeFileSync(file, `${prefix}${missing.join('\n')}\n`);
    onWrite('.codex/rules/pullboard.rules');
  }
  const gateNote = plainGateWords(gate) ? '' : gate ? '; the configured shell gate was left for manual approval' : '';
  const rulesNote = missing.length ? `added trusted-project Codex rules for Pullboard and the listed Git commands${gateNote}` : 'kept the existing Codex project rules';
  if (!machineHomeWriteScopeIsNarrow(machinePath)) {
    return `${rulesNote}; trust this project and restart the session to load rules. Machine-home write was not granted because the path is the OS home, an ancestor of it, or a filesystem root; choose a narrower PULLBOARD_MACHINE_HOME`;
  }
  const workspaceWrite = `[sandbox_workspace_write]\nwritable_roots=${JSON.stringify([machinePath])}`;
  const profileWrite = `${JSON.stringify(machinePath)} = "write"`;
  return `${rulesNote}; trust this project and restart the session to load rules. For machine-home access, legacy Codex settings add:\n${workspaceWrite}\nPermission-profile users add ${profileWrite} under their existing [permissions.<active-profile>.filesystem] table instead; do not mix the two configuration formats`;
}

/**
 * Set the repo up. Must run in the main checkout, which becomes the coordinator.
 *
 * @param {{ info: { root: string, isMain: boolean }, openBoardHere: () => any, register: Function, closeBoard: Function, model?: string, permissions?: boolean }} context
 * @returns {string[]} What happened, one line each.
 */
export function initRepo({ info, openBoardHere, register, closeBoard, model, permissions = true }) {
  if (!info.isMain) {
    throw new Refused('NOT_MAIN', 'run init in the main checkout; worktrees join a lane instead');
  }
  const { root } = info;
  const doctrine = existsSync(join(root, CONFIG_FILE)) ? loadConfig(root).practice : doctrineFile(root);
  const gate = detectGate(root);
  const written = [];
  /** Record only paths setup actually writes; unrelated files never enter its staging command. */
  const onWrite = (path) => { if (!written.includes(path)) written.push(path); };
  const notes = [
    writeNew(join(root, CONFIG_FILE), configTemplate(gate, detectFixers(root)), CONFIG_FILE, onWrite),
    writeNew(join(root, 'SPEC.md'), specTemplate(basename(root), gate), 'SPEC.md', onWrite),
    writeNew(join(root, doctrine), practiceTemplate(), doctrine, onWrite),
    ignoreAgentWorktrees(root, onWrite),
    ...writeAgentDocs(root, onWrite),
    ...installHooks(root, onWrite),
    ...installSkills(root, onWrite),
    writeSessionHook(root, onWrite),
  ];
  if (permissions) {
    const gateForPermissions = configuredGate(root) || gate;
    notes.push(writeClaudeLoopPermissions(root, gateForPermissions, onWrite));
    notes.push(writeCodexLoopRules(root, gateForPermissions, onWrite));
  }
  const board = openBoardHere();
  try {
    register(board, { lane: COORDINATOR, path: root, model });
  } finally {
    closeBoard(board);
  }
  notes.push('opened the board in the git dir; this checkout is the coordinator');
  if (!configuredGate(root)) {
    notes.push(gate
      ? 'no gate yet: set "gate" in pullboard.json to the command that proves the build'
      : 'if this board has no build, use `pullboard spec check` to check its spec and practice files; a second agent review checks the actual work');
  }
  if (written.length) notes.push(`git add -f -- ${written.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(' ')}`);
  return notes;
}
