import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const stateFile = path.join(home, "fake-plugin-state.json");

fs.mkdirSync(home, { recursive: true });
if (process.env.CAIRN_FAKE_CODEX_LOG)
  fs.appendFileSync(process.env.CAIRN_FAKE_CODEX_LOG, JSON.stringify(args) + "\n");

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return { marketplaces: {}, plugins: {} };
  }
}

function writeState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
}

function output(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exitCode = 1;
}

function catalogAt(root) {
  return JSON.parse(
    fs.readFileSync(path.join(root, ".agents", "plugins", "marketplace.json"), "utf8"),
  );
}

function pluginSource(root, entry) {
  const source = typeof entry.source === "string" ? entry.source : entry.source?.path;
  if (typeof source !== "string") throw new Error(`Plugin '${entry.name}' has no local source`);
  return path.resolve(root, source);
}

const state = readState();

if (args.join(" ") === "plugin marketplace list --json") {
  output({
    marketplaces: Object.entries(state.marketplaces).map(([name, root]) => ({
      name,
      root,
      marketplaceSource: { sourceType: "local", source: root },
    })),
  });
} else if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
  const root = fs.realpathSync(args[3]);
  const catalog = catalogAt(root);
  const prior = state.marketplaces[catalog.name];
  if (prior && prior !== root) fail(`marketplace '${catalog.name}' already exists`);
  else {
    state.marketplaces[catalog.name] = root;
    writeState(state);
    output({ marketplaceName: catalog.name, installedRoot: root, alreadyAdded: prior === root });
  }
} else if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") {
  const name = args[3];
  if (!state.marketplaces[name]) fail(`unknown marketplace '${name}'`);
  else {
    delete state.marketplaces[name];
    writeState(state);
    output({ marketplaceName: name, removed: true });
  }
} else if (args.join(" ") === "plugin list --json") {
  output({ installed: Object.values(state.plugins), available: [] });
} else if (args[0] === "plugin" && args[1] === "add") {
  const pluginId = args[2];
  if (process.env.CAIRN_FAKE_CODEX_FAIL_ADD === pluginId)
    fail(`forced plugin add failure for '${pluginId}'`);
  else {
    const split = pluginId.lastIndexOf("@");
    const name = pluginId.slice(0, split);
    const marketplaceName = pluginId.slice(split + 1);
    const root = state.marketplaces[marketplaceName];
    if (!root) fail(`unknown marketplace '${marketplaceName}'`);
    else {
      const catalog = catalogAt(root);
      const entry = catalog.plugins.find((candidate) => candidate.name === name);
      if (!entry) fail(`unknown plugin '${pluginId}'`);
      else {
        const sourcePath = pluginSource(root, entry);
        const manifest = JSON.parse(
          fs.readFileSync(path.join(sourcePath, ".codex-plugin", "plugin.json"), "utf8"),
        );
        const plugin = {
          pluginId,
          name,
          marketplaceName,
          version: manifest.version,
          installed: true,
          enabled: true,
          source: { source: "local", path: sourcePath },
          marketplaceSource: { sourceType: "local", source: root },
          installPolicy: entry.policy?.installation,
          authPolicy: entry.policy?.authentication,
        };
        state.plugins[pluginId] = plugin;
        writeState(state);
        output(plugin);
      }
    }
  }
} else if (args[0] === "plugin" && args[1] === "remove") {
  const pluginId = args[2];
  if (!state.plugins[pluginId]) fail(`unknown plugin '${pluginId}'`);
  else {
    delete state.plugins[pluginId];
    writeState(state);
    output({ pluginId, removed: true });
  }
} else fail(`unsupported fake Codex command: ${args.join(" ")}`);
