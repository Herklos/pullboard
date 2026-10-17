/**
 * `pullboard init` (I1, I2): one command puts the method into a repo. It writes the config, a
 * starter spec and the agent instructions, installs the git hooks, opens the board and registers
 * the main checkout as the coordinator. It runs again safely and never overwrites a file it did not
 * write.
 */
import {
  accessSync, appendFileSync, constants as fsConstants, existsSync, mkdirSync,
  readdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { delimiter, basename, join, resolve } from 'node:path';
import { CONFIG_FILE, COORDINATOR, doctrineFile, loadConfig } from './config.js';
import { loadDoctrine } from './doctrine.js';
import { installHooks } from './hooks.js';
import { Refused } from './refused.js';
import { installSkills } from './skills.js';
import { AGENTS_END, AGENTS_START, agentsBlock, configTemplate, practiceTemplate, specTemplate } from './templates.js';

const NPM_DEFAULT_TEST = 'echo "Error: no test specified" && exit 1';

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

/** Folders a lane proposal never hands out: dependencies and build output. */
const NOT_LANE_FOLDERS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage']);

/**
 * The visible folders directly inside `dir`, sorted, without dependencies or build output.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function visibleFolders(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !NOT_LANE_FOLDERS.has(entry.name))
    .map((entry) => entry.name).sort();
}

/**
 * A lane name made from a folder name: lowercase letters, digits and dashes, starting with a letter.
 *
 * @param {string} folder
 * @returns {string}
 */
function laneNameFor(folder) {
  const name = folder.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^[^a-z]+/u, '').replace(/-+$/u, '').slice(0, 31).replace(/-+$/u, '');
  return name || 'lane';
}

/**
 * The lanes init proposes from the repo's layout (I1, I2): one lane per top-level package for a
 * packages/* or apps/* layout, and one app lane owning the top-level folders otherwise. Nothing is
 * proposed once any lane owns a folder. Proposals are never written: the person accepts each one
 * by running its `pullboard lane add` command.
 *
 * @param {string} root
 * @param {any} [config] - The repo's config; read from root when omitted.
 * @returns {{ name: string, owns: string[] }[]}
 */
export function proposeLanes(root, config = loadConfig(root)) {
  if (Object.values(config.lanes).some((lane) => lane.owns.length)) return [];
  const taken = new Set([COORDINATOR, 'all', ...Object.keys(config.lanes)]);
  const proposals = [];
  for (const parent of ['packages', 'apps']) {
    for (const folder of visibleFolders(join(root, parent))) {
      let name = laneNameFor(folder);
      if (taken.has(name)) name = laneNameFor(`${parent}-${folder}`);
      for (let n = 2; taken.has(name); n += 1) name = `${laneNameFor(`${parent}-${folder}`).slice(0, 28)}-${n}`;
      taken.add(name);
      proposals.push({ name, owns: [`${parent}/${folder}/`] });
    }
  }
  if (proposals.length) return proposals;
  const folders = visibleFolders(root);
  return [{ name: taken.has('app') ? 'app-1' : 'app', owns: folders.length ? folders.map((folder) => `${folder}/`) : ['app/'] }];
}

/**
 * Quote one word for a POSIX shell when it needs quoting.
 *
 * @param {string} word
 * @returns {string}
 */
const shellWord = (word) => (/^[A-Za-z0-9_./,@%+=:-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/**
 * The init lines that show proposed lanes and the one command that accepts them.
 *
 * @param {{ name: string, owns: string[] }[]} proposals
 * @returns {string[]}
 */
export function laneProposalNotes(proposals) {
  if (!proposals.length) return [];
  return [
    `proposed lanes, not written until the person accepts: ${proposals.map((lane) => `${lane.name} owns ${lane.owns.join(' ')}`).join('; ')}`,
    `ask the person; to accept, run: ${proposals.map((lane) => `pullboard lane add ${shellWord(lane.name)} --owns ${shellWord(lane.owns.join(','))}`).join(' && ')}`,
  ];
}

/** Check whether a command can be found on PATH or in a named project environment without running it. */
function gateCommandAvailable(root, command) {
  /** Check one file without executing it or resolving arbitrary shell syntax. */
  const executableFile = (file) => {
    try {
      const info = statSync(file);
      if (!info.isFile()) return false;
      if (process.platform === 'win32') return true;
      accessSync(file, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  /** Return platform command-name variants for a directory lookup. */
  const commandFiles = (directory) => {
    const base = join(directory, command);
    if (process.platform !== 'win32' || /\.[^\\/]+$/u.test(command)) return [base];
    return (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((extension) => `${base}${extension}`);
  };
  /** Check a PATH directory entry, using the process working directory for an empty entry. */
  const onPath = (directory) => {
    return commandFiles(directory || process.cwd()).some(executableFile);
  };
  if ((process.env.PATH ?? '').split(delimiter).some(onPath)) return true;

  /** Check conventional executable directories inside a named environment. */
  const hasEnvironmentCommand = (environment) => [
    ...commandFiles(join(environment, 'bin')),
    ...commandFiles(join(environment, 'Scripts')),
  ].some(executableFile);

  const environments = new Set([join(root, '.venv')]);
  if (process.env.UV_PROJECT_ENVIRONMENT) {
    const configured = process.env.UV_PROJECT_ENVIRONMENT;
    environments.add(resolve(root, configured));
  }
  if (process.env.POETRY_ACTIVE && process.env.VIRTUAL_ENV) environments.add(process.env.VIRTUAL_ENV);
  if ([...environments].some(hasEnvironmentCommand)) return true;
  return false;
}

/** Describe a detected gate that init cannot resolve without executing it. */
function missingGateNote(root, gate) {
  if (!gate) return '';
  const command = gate.trim().split(/\s+/u)[0];
  if (gateCommandAvailable(root, command)) return '';
  if (command === 'pytest') {
    const hasPoetry = existsSync(join(root, 'poetry.lock'));
    const hasUv = existsSync(join(root, 'uv.lock')) || Boolean(process.env.UV_PROJECT_ENVIRONMENT);
    const searched = ['PATH', 'project `.venv`'];
    if (process.env.UV_PROJECT_ENVIRONMENT) searched.push('configured uv environment');
    if (process.env.POETRY_ACTIVE && process.env.VIRTUAL_ENV) searched.push('active Poetry environment');
    const setupHint = hasUv ? 'run `uv sync` and activate its `.venv`'
      : hasPoetry ? 'run `poetry install` and activate that environment'
        : 'install pytest or activate the project `.venv`';
    return `gate command "pytest" is not available on ${searched.join(', ')}; ${setupHint} before running it`;
  }
  return `gate command "${command}" is not available on PATH; install it before running the gate`;
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
 * Set the repo up. Must run in the main checkout, which becomes the coordinator.
 *
 * @param {{ info: { root: string, isMain: boolean }, openBoardHere: () => any, register: Function, closeBoard: Function, model?: string }} context
 * @returns {string[]} What happened, one line each.
 */
export function initRepo({ info, openBoardHere, register, closeBoard, model }) {
  if (!info.isMain) {
    throw new Refused('NOT_MAIN', 'run init in the main checkout; worktrees join a lane instead');
  }
  const { root } = info;
  const worktreeMode = existsSync(join(root, CONFIG_FILE)) ? loadConfig(root).worktrees : 'inside';
  const doctrine = existsSync(join(root, CONFIG_FILE)) ? loadConfig(root).practice : doctrineFile(root);
  const gate = detectGate(root);
  const configured = configuredGate(root);
  const written = [];
  /** Record only paths setup actually writes; unrelated files never enter its staging command. */
  const onWrite = (path) => written.push(path);
  const notes = [
    writeNew(join(root, CONFIG_FILE), configTemplate(gate, detectFixers(root)), CONFIG_FILE, onWrite),
    writeNew(join(root, 'SPEC.md'), specTemplate(basename(root), gate), 'SPEC.md', onWrite),
    writeNew(join(root, doctrine), practiceTemplate(), doctrine, onWrite),
    ignoreAgentWorktrees(root, onWrite),
    worktreeMode === 'inside'
      ? 'new agent worktrees go in .claude/worktrees; dot-scanner tools such as eslint . should ignore .claude/worktrees; set "worktrees": "beside" in pullboard.json to use sibling folders'
      : 'new agent worktrees go beside this repository as <repo>-<lane>-N; set "worktrees": "inside" in pullboard.json to nest them under .claude/worktrees (dot-scanner tools such as eslint . should ignore that path)',
    ...writeAgentDocs(root, onWrite),
    ...installHooks(root, onWrite),
    ...installSkills(root, onWrite),
    writeSessionHook(root, onWrite),
  ];
  if (gate && (!configured || configured === gate)) {
    const gateNote = missingGateNote(root, gate);
    if (gateNote) notes.push(gateNote);
  }
  const board = openBoardHere();
  try {
    register(board, { lane: COORDINATOR, path: root, model });
  } finally {
    closeBoard(board);
  }
  notes.push('opened the board in the git dir; this checkout is the coordinator');
  notes.push(...laneProposalNotes(proposeLanes(root)));
  if (!configuredGate(root)) {
    notes.push(gate
      ? 'no gate yet: set "gate" in pullboard.json to the command that proves the build'
      : 'if this board has no build, use `pullboard spec check` to check its spec and practice files; a second agent review checks the actual work');
  }
  if (written.length) notes.push(`git add -f -- ${written.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(' ')}`);
  return notes;
}
