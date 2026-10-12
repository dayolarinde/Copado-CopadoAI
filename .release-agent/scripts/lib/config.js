const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const CONFIG_DIR = path.join(process.cwd(), ".release-agent", "config");

function loadYamlFile(filename, fallback) {
  const p = path.join(CONFIG_DIR, filename);
  if (!fs.existsSync(p)) return fallback;
  const parsed = yaml.load(fs.readFileSync(p, "utf8"));
  return parsed === undefined || parsed === null ? fallback : parsed;
}

function loadChecklistConfig() {
  return loadYamlFile("checklist.yaml", {
    default: [
      { id: "qa_signoff", label: "QA sign-off" },
      { id: "docs_updated", label: "Docs / changelog updated" },
    ],
  });
}

function loadEnvironmentConfig() {
  const cfg = loadYamlFile("environments.yaml", { stages: ["SIT", "UAT", "PROD"] });
  return cfg.stages;
}

function loadApproversConfig() {
  return loadYamlFile("approvers.yaml", {});
}

function loadReleaseNotesTemplate() {
  return loadYamlFile("release-notes-template.yaml", {
    title: "Release Notes",
    sections: [
      { name: "Feature", description: "Brand new capability that didn't exist before" },
      { name: "Bug", description: "A defect or incorrect behavior that's been fixed" },
      { name: "Enhancement", description: "An improvement to something that already existed" },
      { name: "Technical Debt", description: "Internal cleanup, refactors, dependency updates" },
    ],
    footer: "",
  });
}

module.exports = {
  loadChecklistConfig,
  loadEnvironmentConfig,
  loadApproversConfig,
  loadReleaseNotesTemplate,
};
