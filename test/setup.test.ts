import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setup, status, prepareOpening, routeCreation, setWorkspaceRouting, setDaemonAccess, receiptPath } from "../server/service";
import { hash, run } from "../server/policy";

// Paseo 0.15.3 recursively merges objects, replacing arrays and scalar values.
function merge(before: any, patch: any): any {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const next = { ...before };
  for (const [key, value] of Object.entries(patch)) next[key] = merge(next[key], value);
  return next;
}
async function fixture(t: any) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "safehouse-setup-")));
  const home = path.join(dir, "home"), bin = path.join(dir, "bin");
  await fs.mkdir(home); await fs.mkdir(bin);
  await fs.writeFile(path.join(home, "config.json"), JSON.stringify({
    daemon: { listen: "127.0.0.1:41789" }, plugins: { "paseo-safehouse": { path: process.cwd() } },
  }));
  await fs.writeFile(path.join(bin, "safehouse"), "#!/bin/sh\nprintf 'Safehouse fixture\\n--trust-workdir-config\\nSupported values: network\\n'\n", { mode: 0o700 });
  await fs.writeFile(path.join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const oldHome = process.env.PASEO_HOME, oldPath = process.env.PATH;
  process.env.PASEO_HOME = home; process.env.PATH = bin;
  t.after(async () => {
    if (oldHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = oldHome;
    process.env.PATH = oldPath;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const configFile = path.join(dir, "providers.json");
  const initial = { providers: { pi: { paseoTools: { enabled: true }, env: { USER_OPTION: "kept" }, models: [{ id: "native", label: "Native" }] }, peer: { label: "Peer", extends: "pi", command: ["peer"] } }, plugins: { peer: { enabled: true } } };
  await fs.writeFile(configFile, JSON.stringify(initial));
  let patches = 0;
  const get = async () => JSON.parse(await fs.readFile(configFile, "utf8"));
  const host = { config: {
    get: async () => ({ config: await get() }),
    patch: async (patch: any) => { patches++; await fs.writeFile(configFile, JSON.stringify(merge(await get(), patch))); },
  } } as unknown as Parameters<typeof setup>[0];
  return { dir, home, bin, host, get, initial, configFile, patches: () => patches, root: path.join(home, "safehouse") };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const mac = { skip: process.platform !== "darwin" };
// The Paseo provider settings send config.patch({ providers: { [id]: { enabled } } }) outside setup.
const userPatch = async (f: Fixture, providers: Record<string, unknown>) =>
  fs.writeFile(f.configFile, JSON.stringify(merge(await f.get(), { providers })));
const launch = (f: Fixture, provider: string) => prepareOpening({ agentId: `toggle-${provider}`, provider, cwd: f.dir, reason: "create",
  workspaceId: "workspace", purpose: "interactive", title: null, labels: {}, env: {}, tools: [], mcpServers: {} } as Parameters<typeof prepareOpening>[0], f.host);
const recorded = async (f: Fixture) => fs.readFile(path.join(f.root, "installation.json"), "utf8");

for (const [field, value] of [["enabled", false], ["order", 3]] as const) {
  test(`Refresh providers keeps a user-set wrapper ${field}`, mac, async t => {
    const f = await fixture(t);
    await setup(f.host);
    await userPatch(f, { "safehouse-pi": { [field]: value } });
    await setup(f.host);
    assert.equal((await f.get()).providers["safehouse-pi"][field], value);
  });
}

test("a wrapper disabled and enabled again launches without Refresh providers", mac, async t => {
  const f = await fixture(t);
  await setup(f.host);
  await userPatch(f, { "safehouse-pi": { enabled: false } });
  await userPatch(f, { "safehouse-pi": { enabled: true } });
  assert.ok((await launch(f, "safehouse-pi")).env.SAFEHOUSE_WORKDIR);
});

// pi-sd is a configured source, pi a recorded built-in, and claude a built-in without a config entry.
for (const source of ["pi-sd", "pi", "claude"]) {
  test(`a disabled ${source} source keeps its wrapper launchable and configured`, mac, async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await userPatch(f, { "pi-sd": { extends: "pi", label: "Pi SD", command: ["pi"] } });
    Object.assign(f.host, { workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: f.dir }) }) }, agents: { list: async () => ({ entries: [] }) } });
    await setup(f.host);
    await userPatch(f, { [source]: { enabled: false } });
    assert.ok((await launch(f, `safehouse-${source}`)).env.SAFEHOUSE_WORKDIR);
    assert.equal((await status(f.host, "workspace")).configured, true);
  });
}

test("Refresh providers does not copy a disabled source's enabled into an existing wrapper", mac, async t => {
  const f = await fixture(t);
  await userPatch(f, { "pi-sd": { extends: "pi", label: "Pi SD", command: ["pi"], enabled: false } });
  await setup(f.host);
  assert.equal((await f.get()).providers["safehouse-pi-sd"].enabled, false); // A new wrapper inherits the source's value.
  // The source change makes Refresh providers patch the wrapper.
  await userPatch(f, { "safehouse-pi-sd": { enabled: true }, "pi-sd": { env: { ADDED: "1" } } });
  await setup(f.host);
  assert.equal((await f.get()).providers["safehouse-pi-sd"].env.ADDED, "1");
  assert.equal((await f.get()).providers["safehouse-pi-sd"].enabled, true);
  assert.ok((await launch(f, "safehouse-pi-sd")).env.SAFEHOUSE_WORKDIR);
});

const foreign = { command: ["/bin/sh", "/tmp/other.sh"], extends: "claude", label: "Edited", env: { EXTRA: "1" }, paseoTools: { enabled: false } };
for (const [field, value] of Object.entries(foreign)) {
  test(`Refresh providers and launch refuse a disabled wrapper with a changed ${field}`, mac, async t => {
    const f = await fixture(t);
    await setup(f.host);
    await userPatch(f, { "safehouse-pi": { [field]: value, enabled: false } });
    const before = await f.get(), record = await recorded(f), count = f.patches();
    await assert.rejects(setup(f.host), /Provider safehouse-pi belongs to another configuration/);
    assert.equal(f.patches(), count);
    assert.deepEqual(await f.get(), before);
    assert.equal(await recorded(f), record);
    await assert.rejects(launch(f, "safehouse-pi"), /configuration changed/);
  });
}

test("Refresh providers refuses an unrecorded wrapper that holds only a toggle", mac, async t => {
  const f = await fixture(t);
  await userPatch(f, { "safehouse-pi": { enabled: false } });
  const before = await f.get();
  await assert.rejects(setup(f.host), /Provider safehouse-pi belongs to another configuration/);
  assert.equal(f.patches(), 0);
  assert.deepEqual(await f.get(), before);
});

test("pending setup recovery does not overwrite a toggle made before its patch", mac, async t => {
  const f = await fixture(t), apply = f.host.config.patch;
  await setup(f.host);
  await userPatch(f, { "safehouse-pi": { enabled: false }, pi: { env: { ADDED: "1" } } });
  f.host.config.patch = async () => { throw new Error("before apply"); };
  await assert.rejects(setup(f.host), /before apply/);
  f.host.config.patch = apply;
  await userPatch(f, { "safehouse-pi": { enabled: true } });
  await setup(f.host);
  const wrapper = (await f.get()).providers["safehouse-pi"];
  assert.equal(wrapper.env.ADDED, "1");
  assert.equal(wrapper.enabled, true);
});

for (const toggle of [false, true])
test(`setup recovers an applied patch with a lost response in a fresh process${toggle ? " after a toggle" : ""}`, { skip: process.platform !== "darwin" }, async (t) => {
  const f = await fixture(t);
  const apply = f.host.config.patch;
  f.host.config.patch = async (patch) => { await apply(patch); throw new Error("lost setup response"); };
  await assert.rejects(setup(f.host), /lost setup response/);
  if (toggle) await userPatch(f, { "safehouse-pi": { enabled: false } });
  const retry = path.join(f.dir, "retry.mts");
  await fs.writeFile(retry, `import * as fs from 'node:fs/promises';
import { setup, status, prepareOpening } from ${JSON.stringify(path.join(process.cwd(), "server/service.ts"))};
const file = ${JSON.stringify(f.configFile)};
const merge = ${merge.toString()};
await setup({config:{get:async()=>({config:JSON.parse(await fs.readFile(file,'utf8'))}),patch:async p=>fs.writeFile(file,JSON.stringify(merge(JSON.parse(await fs.readFile(file,'utf8')),p)))}});
`);
  await run(process.execPath, ["--import", "tsx", retry], { cwd: process.cwd(), env: process.env });
  const saved = JSON.parse(await fs.readFile(path.join(f.root, "installation.json"), "utf8"));
  const current = await f.get();
  assert.deepEqual(current.providers["safehouse-pi"], { ...saved.entries["safehouse-pi"], ...toggle ? { enabled: false } : {} });
  assert.equal(current.providers["safehouse-pi"].paseoTools.enabled, true);
  assert.equal(current.providers.pi.paseoTools.enabled, true);
  assert.deepEqual(current.providers.pi, f.initial.providers.pi);
  assert.deepEqual(current.providers.peer, f.initial.providers.peer);
  assert.deepEqual(current.plugins, f.initial.plugins);
  await assert.rejects(fs.stat(path.join(f.root, "setup-pending.json")), { code: "ENOENT" });
});

test("setup publishes complete exact files before the public patch", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t), apply = f.host.config.patch;
  let publications = 0;
  f.host.config.patch = async patch => {
    const pending = JSON.parse(await fs.readFile(path.join(f.root, "setup-pending.json"), "utf8"));
    for (const file of pending.files)
      assert.equal(await fs.readFile(file.file, "utf8"), file.text, file.file);
    assert.ok(pending.files.some((file: any) => file.file === pending.installation.guard));
    for (const entry of Object.values(patch.providers ?? {}) as any[])
      assert.ok(pending.files.some((file: any) => file.file === entry.command[1]));
    publications++;
    return apply(patch);
  };
  // Unexpected callback errors must fail the test, not count as an injected fault.
  await setup(f.host);
  assert.equal(publications, 1);
});

for (const boundary of ["patch", "files", "commit", "cleanup"]) {
  test(`setup retries ${boundary} failure with complete immutable files`, { skip: process.platform !== "darwin" }, async (t) => {
    const f = await fixture(t);
    await setup(f.host);
    const old = JSON.parse(await fs.readFile(path.join(f.root, "installation.json"), "utf8"));
    const retained = [old.guard, ...Object.values(old.entries).map((e: any) => e.command[1])];
    const bytes = await Promise.all(retained.map(file => fs.readFile(file, "utf8")));
    const nextExecutable = path.join(f.bin, "pi-next");
    await fs.writeFile(nextExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const nativeConfig = await f.get(); nativeConfig.providers.pi.command = [nextExecutable];
    await fs.writeFile(f.configFile, JSON.stringify(nativeConfig));
    let unblock = async () => {};
    const apply = f.host.config.patch;
    if (boundary === "files") {
      const before = await f.get(), patchCount = f.patches();
      // Force a new launcher generation and obstruct its destination directory.
      const extension = path.join(f.dir, "extension.ts"); await fs.writeFile(extension, "");
      await fs.rename(path.join(f.root, "launchers"), path.join(f.root, "retained"));
      await fs.writeFile(path.join(f.root, "launchers"), "blocked");
      unblock = async () => { await fs.rm(path.join(f.root, "launchers")); await fs.rename(path.join(f.root, "retained"), path.join(f.root, "launchers")); };
      await assert.rejects(setup(f.host, { piCatalogExtensions: [extension] }));
      assert.equal(f.patches(), patchCount);
      assert.deepEqual(await f.get(), before);
    } else {
      f.host.config.patch = async patch => {
        for (const entry of Object.values(patch.providers ?? {}) as any[]) {
          const script = await fs.readFile(entry.command[1], "utf8");
          assert.ok(script.length);
          const pending = JSON.parse(await fs.readFile(path.join(f.root, "setup-pending.json"), "utf8"));
          await fs.access(pending.installation.guard);
        }
        if (boundary === "patch") throw new Error("before apply");
        const result = await apply(patch);
        if (boundary === "commit") {
          await fs.rename(path.join(f.root, "installation.json"), path.join(f.root, "saved.json"));
          await fs.mkdir(path.join(f.root, "installation.json"));
          unblock = async () => { await fs.rmdir(path.join(f.root, "installation.json")); await fs.rename(path.join(f.root, "saved.json"), path.join(f.root, "installation.json")); };
        }
        if (boundary === "cleanup") {
          const pendingPath = path.join(f.root, "setup-pending.json");
          const pendingBytes = await fs.readFile(pendingPath);
          await fs.rm(pendingPath); await fs.mkdir(pendingPath);
          unblock = async () => { await fs.rmdir(pendingPath); await fs.writeFile(pendingPath, pendingBytes); };
        }
        return result;
      };
      const extension = path.join(f.dir, "extension.ts"); await fs.writeFile(extension, "");
      await assert.rejects(setup(f.host, { piCatalogExtensions: [extension] }),
        boundary === "patch" ? /before apply/ : { code: boundary === "cleanup" ? "ERR_FS_EISDIR" : "EISDIR" });
    }
    await unblock(); f.host.config.patch = apply;
    assert.deepEqual(await Promise.all(retained.map(file => fs.readFile(file, "utf8"))), bytes);
    await setup(f.host);
    const saved = JSON.parse(await fs.readFile(path.join(f.root, "installation.json"), "utf8"));
    assert.deepEqual((await f.get()).providers["safehouse-pi"], saved.entries["safehouse-pi"]);
    assert.deepEqual(await Promise.all(retained.map(file => fs.readFile(file, "utf8"))), bytes);
  });
}

test("setup queue recovers a rejected predecessor without overlapping patches", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const apply = f.host.config.patch;
  let active = 0, peak = 0, calls = 0;
  f.host.config.patch = async patch => {
    active++; peak = Math.max(peak, active);
    try { if (++calls === 1) { entered(); await blocked; throw new Error("first failed"); } return await apply(patch); }
    finally { active--; }
  };
  const first = assert.rejects(setup(f.host), /first failed/);
  await started;
  const second = setup(f.host);
  await new Promise(resolve => setTimeout(resolve, 30));
  release(); await first; await second;
  assert.equal(peak, 1);
  assert.ok(await fs.stat(path.join(f.root, "installation.json")));
});

for (const conflict of ["target", "source", "identity", "malformed", "foreign", "readback", "nested deletion"]) {
  test(`setup refuses ${conflict} without losing protected evidence`, { skip: process.platform !== "darwin" }, async t => {
    const f = await fixture(t), apply = f.host.config.patch;
    const pendingPath = path.join(f.root, "setup-pending.json");
    if (conflict === "nested deletion" || conflict === "foreign") {
      await setup(f.host);
      if (conflict === "foreign") await fs.rm(path.join(f.root, "installation.json"));
      else {
        const config = await f.get(); delete config.providers.pi.env.USER_OPTION;
        await fs.writeFile(f.configFile, JSON.stringify(config));
      }
    } else {
      f.host.config.patch = async patch => { await apply(patch); throw new Error("lost response"); };
      await assert.rejects(setup(f.host), /lost response/);
      if (conflict === "target" || conflict === "source") {
        const config = await f.get(); config.providers[conflict === "target" ? "safehouse-pi" : "pi"].env.USER_OPTION = "edited";
        await fs.writeFile(f.configFile, JSON.stringify(config));
      }
      if (conflict === "identity") {
        const configPath = path.join(f.home, "config.json"), config = JSON.parse(await fs.readFile(configPath, "utf8"));
        config.daemon.listen = "127.0.0.1:41790"; await fs.writeFile(configPath, JSON.stringify(config));
      }
      if (conflict === "malformed") await fs.writeFile(pendingPath, '{"installation":{}}');
    }
    const before = await f.get(), count = f.patches();
    const pending = await fs.readFile(pendingPath, "utf8").catch(() => null);
    f.host.config.patch = apply;
    if (conflict === "readback") {
      // Exact planned targets require no patch; a changed final read must still prevent commit.
      const get = f.host.config.get; let reads = 0;
      f.host.config.get = async (...args) => { const result = await get(...args); if (++reads === 3) result.config.providers["safehouse-pi"].label = "unexpected"; return result; };
    }
    await assert.rejects(setup(f.host), /conflict|source changed|identity changed|Invalid setup-pending|another configuration|nested field removal/);
    assert.equal(f.patches(), count);
    assert.deepEqual(await f.get(), before);
    assert.equal(await fs.readFile(pendingPath, "utf8").catch(() => null), pending);
  });
}

test("setup queues different captured daemon roots independently", { skip: process.platform !== "darwin" }, async t => {
  const a = await fixture(t);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const apply = a.host.config.patch;
  a.host.config.patch = async patch => { entered(); await blocked; return apply(patch); };
  const first = setup(a.host); await started;
  const b = await fixture(t);
  try {
    await setup(b.host);
    await assert.rejects(fs.stat(path.join(a.root, "installation.json")), { code: "ENOENT" });
    assert.ok(await fs.stat(path.join(b.root, "installation.json")));
  } finally { release(); }
  await first;
  const saved = JSON.parse(await fs.readFile(path.join(a.root, "installation.json"), "utf8"));
  assert.equal(saved.home, a.home);
});

test("invalid committed state and pending persistence failure prevent publication", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t);
  await fs.mkdir(f.root);
  const installation = path.join(f.root, "installation.json"), pending = path.join(f.root, "setup-pending.json");
  await fs.writeFile(installation, "{}");
  await assert.rejects(setup(f.host), /Invalid installation.json/);
  assert.equal(f.patches(), 0);
  await fs.rm(installation);
  await fs.mkdir(pending);
  await assert.rejects(setup(f.host));
  assert.equal(f.patches(), 0);
  assert.deepEqual(await f.get(), f.initial);
  assert.deepEqual(await fs.readdir(f.root), ["setup-pending.json"]);
  await fs.rmdir(pending);
  await setup(f.host);
  assert.equal(f.patches(), 1);
});

for (const change of ["removed", "unwrappable"]) {
  test(`refresh retires ${change} sources without blocking healthy providers`, { skip: process.platform !== "darwin" }, async t => {
    const f = await fixture(t), config = await f.get();
    const custom = { label: "Custom", extends: "copilot", command: [path.join(f.bin, "pi")] };
    config.providers.custom = custom;
    await fs.writeFile(f.configFile, JSON.stringify(config));
    await fs.writeFile(path.join(f.dir, ".safehouse"), "");
    Object.assign(f.host, { workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: f.dir }) }) }, agents: { list: async () => ({ entries: [] }) } });
    await setup(f.host);
    const installation = path.join(f.root, "installation.json");
    const old = JSON.parse(await fs.readFile(installation, "utf8"));
    const files = [old.guard, old.entries["safehouse-custom"].command[1]];
    const bytes = await Promise.all(files.map(file => fs.readFile(file, "utf8")));
    const changed = await f.get();
    if (change === "removed") delete changed.providers.custom;
    else changed.providers.custom.command = [path.join(f.bin, "missing")];
    await fs.writeFile(f.configFile, JSON.stringify(changed));
    await setup(f.host); await setup(f.host);
    const retired = JSON.parse(await fs.readFile(installation, "utf8"));
    assert.deepEqual(retired.entries["safehouse-custom"], old.entries["safehouse-custom"]);
    assert.ok(retired.unavailable.custom);
    assert.deepEqual(retired.sources["safehouse-custom"].source, changed.providers.custom ?? null);
    assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file, "utf8"))), bytes);
    assert.deepEqual((await f.get()).providers.pi, changed.providers.pi);
    assert.deepEqual((await f.get()).providers.peer, changed.providers.peer);
    assert.equal((await status(f.host, "workspace")).configured, true);
    const opening = (provider: string) => ({ provider, cwd: f.dir, agentId: "resume", reason: "resume", workspaceId: null, purpose: "interactive", background: false, metadata: {}, title: null, labels: {}, env: {}, tools: [], mcpServers: {} }) as Parameters<typeof prepareOpening>[0];
    await assert.rejects(prepareOpening(opening("safehouse-custom"), f.host), /unavailable/);
    assert.ok((await prepareOpening(opening("safehouse-pi"), f.host)).env.SAFEHOUSE_WORKDIR);
    await assert.rejects(fs.access(path.join(f.root, "setup-pending.json")), { code: "ENOENT" });
    const coherent = await f.get(), edited = structuredClone(coherent);
    edited.providers["safehouse-custom"].label = "Foreign edit";
    await fs.writeFile(f.configFile, JSON.stringify(edited));
    const count = f.patches(); await assert.rejects(setup(f.host), /another configuration/);
    assert.equal(f.patches(), count);
    await fs.writeFile(f.configFile, JSON.stringify(coherent));
    const restored = await f.get(); restored.providers.custom = custom;
    await fs.writeFile(f.configFile, JSON.stringify(restored)); await setup(f.host);
    assert.equal(JSON.parse(await fs.readFile(installation, "utf8")).unavailable.custom, undefined);
    assert.ok((await prepareOpening(opening("safehouse-custom"), f.host)).env.SAFEHOUSE_WORKDIR);
    const removed = await f.get(); delete removed.providers.custom; delete removed.providers["safehouse-custom"];
    await fs.writeFile(f.configFile, JSON.stringify(removed)); await setup(f.host);
    const dropped = JSON.parse(await fs.readFile(installation, "utf8"));
    assert.equal(dropped.entries["safehouse-custom"], undefined);
    assert.equal(dropped.sources["safehouse-custom"], undefined);
    assert.equal((await f.get()).providers["safehouse-custom"], undefined);
    assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file, "utf8"))), bytes);
  });
}

test("refresh retains only stale reserved empty masks and rejects real env deletion", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t), name = "PASEO_TEST_EPHEMERAL", original = process.env[name];
  t.after(() => { if (original === undefined) delete process.env[name]; else process.env[name] = original; });
  process.env[name] = "fixture";
  await setup(f.host); delete process.env[name];
  const changed = await f.get(); changed.providers.pi.label = "Updated Pi";
  await fs.writeFile(f.configFile, JSON.stringify(changed)); await setup(f.host);
  assert.equal((await f.get()).providers["safehouse-pi"].env[name], "");
  assert.equal((await f.get()).providers["safehouse-pi"].label, "Pi · Safehouse");
  const withEmpty = await f.get(); withEmpty.providers.pi.env.USER_EMPTY = "";
  await fs.writeFile(f.configFile, JSON.stringify(withEmpty)); await setup(f.host);
  const removed = await f.get(); delete removed.providers.pi.env.USER_EMPTY;
  await fs.writeFile(f.configFile, JSON.stringify(removed));
  const before = f.patches(); await assert.rejects(setup(f.host), /nested field removal/);
  assert.equal(f.patches(), before);
  await assert.rejects(fs.access(path.join(f.root, "setup-pending.json")), { code: "ENOENT" });
});

test("prefixed setup preserves aliases, avoids nesting, and routes new agents", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t), before = await f.get();
  const aliases = ["safehouse-external", "pi-safehouse", "pi-safehouse-direct"];
  for (const id of aliases) before.providers[id] = { extends: "pi", command: ["pi"], label: id };
  before.providers.custom = { extends: "pi", command: ["pi"] };
  await fs.writeFile(f.configFile, JSON.stringify(before));
  const sessions = aliases.map(provider => ({ provider, id: provider }));
  const originalSessions = structuredClone(sessions);
  Object.assign(f.host, { agents: { list: async () => ({ entries: sessions.map(agent => ({ agent })) }) } });
  await setup(f.host); await setup(f.host);
  const after = await f.get();
  for (const [id, entry] of Object.entries(before.providers)) assert.deepEqual(after.providers[id], entry);
  for (const id of aliases) assert.equal(after.providers[`safehouse-${id}`], undefined);
  assert.ok(after.providers["safehouse-pi"]);
  assert.ok(after.providers["safehouse-custom"]);
  assert.equal(after.providers["safehouse-safehouse-pi"], undefined);
  assert.deepEqual(sessions, originalSessions);
  await fs.writeFile(path.join(f.dir, ".safehouse"), "");
  for (const provider of ["pi", "custom"])
    assert.equal((await routeCreation({ config: { provider, cwd: f.dir, model: "native" } }, f.host)).config.provider, `safehouse-${provider}`);
});

test("prefixed setup refuses an unowned occupied target without writing", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t), before = await f.get();
  before.providers["safehouse-pi"] = { extends: "pi", command: ["pi"], label: "Unowned" };
  await fs.writeFile(f.configFile, JSON.stringify(before));
  await assert.rejects(setup(f.host), /Provider safehouse-pi belongs to another configuration/);
  assert.equal(f.patches(), 0);
  assert.deepEqual(await f.get(), before);
});


test("draft metadata routes independently without changing workspace defaults or protected resumes", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t);
  Object.assign(f.host, { workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: f.dir }) }) } });
  await setup(f.host);
  const request = (metadata?: Record<string, unknown>, provider = "pi") => ({
    config: { provider, cwd: f.dir, model: "native" }, ...(metadata === undefined ? {} : { metadata }),
  });
  const route = (metadata?: Record<string, unknown>, provider?: string) => routeCreation(request(metadata, provider), f.host);
  assert.equal((await route()).config.provider, "safehouse-pi");
  assert.equal((await route({ "paseo-safehouse.launch": false })).config.provider, "pi");
  await setWorkspaceRouting(f.host, "workspace", false);
  const records = await fs.readdir(path.join(f.root, "workspaces"));
  const bytes = await Promise.all(records.map(file => fs.readFile(path.join(f.root, "workspaces", file), "utf8")));
  assert.equal((await route({ "paseo-safehouse.launch": true })).config.provider, "safehouse-pi");
  assert.equal((await route({ "paseo-safehouse.launch": false })).config.provider, "pi");
  assert.equal((await route()).config.provider, "pi");
  assert.equal((await route({ unrelated: true })).config.provider, "pi");
  assert.equal((await route({ "paseo-safehouse.launch": false }, "safehouse-pi")).config.provider, "safehouse-pi");
  for (const value of [null, "false", "true", 0, 1, [], {}, { enabled: false }])
    await assert.rejects(route({ "paseo-safehouse.launch": value }), /paseo-safehouse.launch.*boolean/);
  assert.deepEqual(await Promise.all(records.map(file => fs.readFile(path.join(f.root, "workspaces", file), "utf8"))), bytes);
  await fs.writeFile(path.join(f.root, "workspaces", records[0]), "invalid record");
  await assert.rejects(route(), /routing state is unreadable or invalid/);
  assert.equal((await route({ "paseo-safehouse.launch": false })).config.provider, "pi");
  assert.equal((await route({ "paseo-safehouse.launch": true })).config.provider, "safehouse-pi");
  await fs.writeFile(path.join(f.root, "workspaces", records[0]), bytes[0]);
  await assert.rejects(fs.access(path.join(f.dir, ".safehouse")), { code: "ENOENT" });
  const opening = { provider: "safehouse-pi", cwd: f.dir, agentId: "protected", reason: "resume", workspaceId: null,
    purpose: "interactive", background: false, metadata: { "paseo-safehouse.launch": false }, title: null, labels: {}, env: {}, tools: [], mcpServers: {} } as Parameters<typeof prepareOpening>[0];
  const resumed = await prepareOpening(opening, f.host);
  assert.equal(resumed.provider, "safehouse-pi");
  assert.ok(resumed.env.SAFEHOUSE_WORKDIR);
  const tampered = { ...opening, metadata: { "paseo-safehouse.launch": "invalid" } };
  assert.ok((await prepareOpening(tampered, f.host)).env.SAFEHOUSE_WORKDIR);
  await fs.writeFile(path.join(f.dir, ".safehouse"), "invalid policy directive");
  await assert.rejects(route({ "paseo-safehouse.launch": false }, "safehouse-pi"));
  await assert.rejects(prepareOpening(opening, f.host));
  assert.equal((await route({ "paseo-safehouse.launch": false })).config.provider, "pi");
});

test("wrapped Claude, Codex and Pi entries follow the source paseoTools policy", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t), config = await f.get();
  for (const host of ["claude", "codex"]) await fs.writeFile(path.join(f.bin, host), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  config.providers.codex = { paseoTools: { disabledTools: ["browser_navigate"] } };
  await fs.writeFile(f.configFile, JSON.stringify(config));
  await setup(f.host);
  // An installation made before this change forced enabled: false on every wrapped entry.
  const forced = await f.get(), installed = JSON.parse(await fs.readFile(path.join(f.root, "installation.json"), "utf8"));
  for (const host of ["claude", "codex", "pi"]) {
    const id = `safehouse-${host}`;
    forced.providers[id].paseoTools = installed.entries[id].paseoTools = { ...forced.providers[host]?.paseoTools, enabled: false };
  }
  await fs.writeFile(f.configFile, JSON.stringify(forced));
  await fs.writeFile(path.join(f.root, "installation.json"), JSON.stringify(installed));
  await setup(f.host);
  const refreshed = await f.get();
  // Paseo enables tools unless enabled is false, so an absent source policy and enabled: true are equal.
  assert.deepEqual(refreshed.providers["safehouse-claude"].paseoTools, { enabled: true });
  assert.deepEqual(refreshed.providers["safehouse-codex"].paseoTools, { disabledTools: ["browser_navigate"], enabled: true });
  assert.deepEqual(refreshed.providers["safehouse-pi"].paseoTools, { enabled: true });
  const policies = { claude: { enabled: false, disabledTools: ["list_agents"] }, codex: { enabled: true, disabledTools: ["browser_navigate"] }, pi: { enabled: false } };
  for (const [host, paseoTools] of Object.entries(policies)) refreshed.providers[host] = { ...refreshed.providers[host], paseoTools };
  await fs.writeFile(f.configFile, JSON.stringify(refreshed));
  await setup(f.host);
  const after = await f.get();
  for (const [host, paseoTools] of Object.entries(policies)) {
    assert.deepEqual(after.providers[`safehouse-${host}`].paseoTools, paseoTools, host);
    assert.deepEqual(after.providers[host].paseoTools, paseoTools, host);
  }
});

async function accessFixture(t: any) {
  const f = await fixture(t), listed: string[] = [];
  Object.assign(f.host, {
    workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: f.dir }) }) },
    agents: { ref: () => ({}), list: async () => ({ entries: listed.map(id => ({ agent: { id, title: id, provider: "safehouse-pi", workspaceId: "workspace" } })) }) },
  });
  await setup(f.host);
  const open = (agentId: string, reason: string, labels: Record<string, string> = {}, metadata?: Record<string, unknown>) =>
    prepareOpening({ agentId, provider: "safehouse-pi", cwd: f.dir, reason, workspaceId: "workspace", purpose: "interactive",
      title: null, labels, env: {}, tools: [], mcpServers: {}, ...(metadata ? { metadata } : {}) } as Parameters<typeof prepareOpening>[0], f.host);
  return { f, listed, open, receipt: async (id: string) => JSON.parse(await fs.readFile(receiptPath(id), "utf8")),
    record: (id: string) => path.join(f.root, "agents", `${hash(id)}.access.json`),
    workspaceRecord: path.join(f.root, "workspaces", `${hash(f.dir)}.daemon-access.json`) };
}
const accessKey = "paseo-safehouse.paseo-access";

test("per-agent paseo access is read once at creation and recorded", { skip: process.platform !== "darwin" }, async t => {
  const { open, receipt, record } = await accessFixture(t), key = accessKey;
  await open("label", "create", { [key]: "daemon" });
  await open("meta", "create", {}, { [key]: "daemon" });
  await open("both", "create", { [key]: "daemon" }, { [key]: "daemon" });
  await open("plain", "create");
  for (const [id, access] of [["label", "daemon"], ["meta", "daemon"], ["both", "daemon"], ["plain", "workspace"]]) {
    assert.equal((await receipt(id)).paseoAccess, access, id);
    assert.equal((await receipt(id)).daemonAccess, access === "daemon", id);
  }
  const recorded = await fs.readFile(record("label"), "utf8"), plainRecord = await fs.readFile(record("plain"), "utf8");
  for (const reason of ["resume", "refresh", "import", "create"]) {
    await open("label", reason, { [key]: "workspace" }, { [key]: "workspace" }); // no de-escalation
    assert.equal((await receipt("label")).paseoAccess, "daemon", reason);
    await open("plain", reason, { [key]: "daemon" }, { [key]: "daemon" }); // no escalation
    assert.equal((await receipt("plain")).paseoAccess, "workspace", reason);
    assert.equal((await receipt("plain")).daemonAccess, false, reason);
  }
  assert.equal(await fs.readFile(record("label"), "utf8"), recorded);
  assert.equal(await fs.readFile(record("plain"), "utf8"), plainRecord);
  for (const reason of ["resume", "refresh", "import"]) { // created before this change, or imported
    await open("legacy", reason, { [key]: "daemon" }, { [key]: "daemon" });
    assert.equal((await receipt("legacy")).paseoAccess, "workspace", reason);
    assert.equal((await receipt("legacy")).daemonAccess, false, reason);
  }
  await assert.rejects(fs.access(record("legacy")), { code: "ENOENT" });
  for (const contents of ["invalid", JSON.stringify({ agentId: "label", access: "tools" }), JSON.stringify({ agentId: "other", access: "daemon" })]) {
    await fs.writeFile(record("label"), contents);
    await assert.rejects(open("label", "resume"), /access record is unreadable or invalid/);
  }
  await fs.writeFile(record("label"), recorded);
  for (const [labels, metadata] of [[{ [key]: "tools" }], [{ [key]: "Daemon" }], [{}, { [key]: true }], [{ [key]: "daemon" }, { [key]: "workspace" }]] as const) {
    await assert.rejects(open("bad", "create", labels, metadata), /paseo-safehouse\.paseo-access/);
    await assert.rejects(fs.access(record("bad")), { code: "ENOENT" });
    await assert.rejects(fs.access(receiptPath("bad")), { code: "ENOENT" });
  }
});

test("per-agent daemon access grants only that agent while the workspace stays Off", { skip: process.platform !== "darwin" }, async t => {
  const { f, open, workspaceRecord } = await accessFixture(t);
  const snapshot = async (agentId: string, labels?: Record<string, string>) => {
    const dir = (await open(agentId, "create", labels)).env.SAFEHOUSE_WORKDIR;
    return { home: (await fs.readFile(path.join(dir, ".safehouse"), "utf8")).split("\n").includes(`add-dirs=${f.home}`),
      guard: await fs.access(path.join(dir, "daemon.sb")).then(() => true, () => false) };
  };
  assert.deepEqual(await snapshot("daemon", { [accessKey]: "daemon" }), { home: true, guard: false });
  assert.deepEqual(await snapshot("plain"), { home: false, guard: true });
  await assert.rejects(fs.access(workspaceRecord), { code: "ENOENT" });
});

test("status reports each agent's access against that agent's effective digest", { skip: process.platform !== "darwin" }, async t => {
  const { f, listed, open } = await accessFixture(t);
  await open("daemon", "create", { [accessKey]: "daemon" });
  await open("plain", "create");
  listed.push("daemon", "plain");
  const rows = async () => (await status(f.host, "workspace")).agents.map(a => [a.id, a.paseoAccess, a.daemonAccess, a.changed]);
  assert.deepEqual(await rows(), [["daemon", "daemon", true, false], ["plain", "workspace", false, false]]);
  await setDaemonAccess(f.host, "workspace", true, (await status(f.host, "workspace")).daemonAccessRevision);
  assert.deepEqual(await rows(), [["daemon", "daemon", true, false], ["plain", "workspace", false, true]]);
  await open("plain", "resume");
  assert.deepEqual(await rows(), [["daemon", "daemon", true, false], ["plain", "workspace", true, false]]);
});
