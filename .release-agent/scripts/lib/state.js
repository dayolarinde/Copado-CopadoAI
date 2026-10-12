const fs = require("fs");
const path = require("path");

// State lives as one JSON file per release, committed directly into the
// repo -- this replaces Postgres entirely. Git itself is the only
// "database engine" here: reading is just reading a file, writing is
// just writing a file, and the workflow that calls these functions is
// responsible for git add/commit/push afterward (see the workflow YAML
// files, not this script) so the change actually persists.
const STATE_DIR = path.join(process.cwd(), ".release-agent", "releases");

const TERMINAL_STATUSES = ["deployed", "rolled back"];

function slugify(branch) {
  // Filenames can't contain "/", which branch names often do (e.g.
  // "feature/PROJ-123"). This makes a safe, readable filename without
  // needing a separate lookup table.
  return branch.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function statePath(branch) {
  return path.join(STATE_DIR, `${slugify(branch)}.json`);
}

function loadState(branch) {
  const p = statePath(branch);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveState(branch, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(statePath(branch), JSON.stringify(state, null, 2) + "\n");
}

function isActive(state) {
  return Boolean(state) && !TERMINAL_STATUSES.includes(state.status);
}

function listAllStates() {
  if (!fs.existsSync(STATE_DIR)) return [];
  return fs
    .readdirSync(STATE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), "utf8")));
}

module.exports = { slugify, statePath, loadState, saveState, isActive, listAllStates, STATE_DIR, TERMINAL_STATUSES };
