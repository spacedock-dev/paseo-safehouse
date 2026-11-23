import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// Namespace imports keep each test independent: a missing export fails that test, not the whole file.
import * as launch from "../server/launch";
import { atomicJson, hash, run } from "../server/policy";
import { prepareOpening, reload, routeCreation, setup, setWorkspaceRouting, status } from "../server/service";
import { launchMetadataKey } from "../shared/contracts";

// Optional: the built server of a Paseo host with the launch-wrap hook, to validate open results with its own schema.
const hostServer = process.env.PASEO_LAUNCH_WRAP_SERVER;
const host = hostServer
  ? await import(path.join(hostServer, "server/server/plugins/lifecycle/index.js")) as {
      validateBeforeResult(name: string, input: unknown, output: unknown): Promise<any>;
    }
  : null;
const routeKey = "paseo-safehouse.route";
const unsupported = (id: string) =>
  new RegExp(`^SafehouseLaunchError: ${id} is not supported by Safehouse yet; disable automatic Safehouse to run it unsandboxed\\.$`);

async function fixture(t: test.TestContext, snapshot?: () => Promise<unknown>, extraProviders: Record<string, any> = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "safehouse-wrap-")));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = base;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    await fs.rm(base, { recursive: true, force: true });
  });
  await atomicJson(path.join(base, "config.json"), { daemon: { listen: "127.0.0.1:45679" }, plugins: { "paseo-safehouse": { path: base } } });
  const providers: Record<string, any> = {
    claude: { command: [process.execPath] }, codex: { command: [process.execPath] }, pi: { command: [process.execPath] },
    ...extraProviders,
  };
  const agents: { agent: { id: string; workspaceId: string; provider: string; title: string } }[] = [];
  const reloaded: string[] = [];
  const paseo = {
    workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: base }) }) },
    agents: {
      list: async () => ({ entries: agents }),
      ref: (id: string) => {
        const agent = agents.find((entry) => entry.agent.id === id)?.agent;
        return { workspaceId: agent?.workspaceId, refresh: async () => {}, current: () => agent, reload: async () => reloaded.push(id) };
      },
    },
    providers: { listModels: async () => ({ models: [{ id: "small", isDefault: true }] }), ...(snapshot ? { snapshot } : {}) },
    config: { get: async () => ({ config: { providers } }), patch: async (patch: any) => Object.assign(providers, patch.providers) },
  } as unknown as Parameters<typeof setup>[0];
  await setup(paseo);
  await fs.writeFile(path.join(base, ".safehouse"), "");
  const open = (agentId: string, provider: string, reason: string, metadata?: Record<string, unknown>) => ({
    agentId, workspaceId: "fixture", provider, cwd: base, reason, purpose: "interactive", title: null,
    labels: {}, tools: [], env: { FIXTURE_TOKEN_NAME: "value" }, mcpServers: {}, ...(metadata ? { metadata } : {}),
  }) as unknown as Parameters<typeof prepareOpening>[0];
  return { base, paseo, providers, agents, reloaded, open };
}
// The snapshot shape of a host with the launch-wrap hook.
const supporting = async () => ({ entries: [
  { provider: "antigravity", status: "ready", launchWrap: true },
  { provider: "codex", status: "ready", launchWrap: true },
  { provider: "claude", status: "ready" },
  { provider: "muse", status: "ready" },
] });

test("a host without launchWrap keeps the refusal and today's derived routes", { skip: process.platform !== "darwin" }, async (t) => {
  for (const snapshot of [
    undefined, // Paseo 0.15.3: no snapshot call
    async () => ({ entries: [{ provider: "antigravity", status: "ready" }, { provider: "codex", status: "ready" }] }), // 0.16.1 shape
    async () => { throw new Error("snapshot unavailable"); },
  ]) {
    const { base, paseo, open } = await fixture(t, snapshot);
    for (const extra of [{}, { requirePlugin: false }]) {
      await assert.rejects(routeCreation({ config: { cwd: base, provider: "antigravity" }, ...extra } as any, paseo), unsupported("antigravity"));
      for (const provider of ["claude", "codex"]) {
        const request = { config: { cwd: base, provider, model: "small" }, ...extra };
        const routed = await routeCreation(request as any, paseo) as any;
        assert.equal(routed.config.provider, `safehouse-${provider}`);
        // No new key reaches a host that did not send it.
        assert.deepEqual(Object.keys(routed).sort(), Object.keys(request).sort());
        assert.equal(routed.requirePlugin, (extra as any).requirePlugin);
      }
    }
    // A derived open is unchanged: env only, no wrap.
    const derived = await prepareOpening(open("agent-d", "safehouse-claude", "create"), paseo) as any;
    assert.equal("wrap" in derived, false);
    assert.match(derived.env.SAFEHOUSE_WORKDIR, new RegExp(`^${base}/safehouse/snapshots/`));
  }
});

test("create selects the wrap route with launchWrap, and adds the plugin requirement only where the host offers it", { skip: process.platform !== "darwin" }, async (t) => {
  const { base, paseo } = await fixture(t, supporting);
  // A host with the plugin requirement shows requirePlugin as a boolean in the create request.
  const input = { config: { cwd: base, provider: "antigravity", model: "small" }, metadata: { kept: 1 }, requirePlugin: false };
  const before = structuredClone(input);
  const routed = await routeCreation(input, paseo) as any;
  assert.deepEqual(input, before);
  assert.deepEqual(routed.config, input.config);
  assert.deepEqual(routed.metadata, { kept: 1, [routeKey]: "wrap" });
  assert.equal(routed.requirePlugin, true);
  // launchWrap without the requirement signal (CL's ruling of 2026-11-21): wrapped, with no requirePlugin key,
  // because the strict create schema of such a host rejects it.
  const plain = { config: { cwd: base, provider: "antigravity", model: "small" }, metadata: { kept: 1 } };
  const wrapped = await routeCreation(plain, paseo) as any;
  assert.deepEqual(wrapped, { ...plain, metadata: { kept: 1, [routeKey]: "wrap" } });
  assert.equal("requirePlugin" in wrapped, false);
  // Model-less creation also takes the wrap route and adds only the marker.
  const modelLess = await routeCreation({ config: { cwd: base, provider: "antigravity" } }, paseo) as any;
  assert.deepEqual(Object.keys(modelLess).sort(), ["config", "metadata"]);
  assert.equal(modelLess.metadata[routeKey], "wrap");
  // Codex can be derived, so it keeps safehouse-codex even when the host could wrap it.
  const codex = await routeCreation({ config: { cwd: base, provider: "codex", model: "small" }, requirePlugin: false } as any, paseo) as any;
  assert.equal(codex.config.provider, "safehouse-codex");
  assert.equal(codex.requirePlugin, false);
  assert.equal(codex.metadata?.[routeKey], undefined);
  // No launchWrap field for this provider: refused.
  await assert.rejects(routeCreation({ config: { cwd: base, provider: "muse" }, requirePlugin: false } as any, paseo), unsupported("muse"));
  // Automatic Safehouse off: the request passes unchanged.
  const off = { config: { cwd: base, provider: "antigravity" }, metadata: { [launchMetadataKey]: false }, requirePlugin: false };
  assert.equal(await routeCreation(off as any, paseo), off);
});

test("open returns the wrap for the recorded agent only, on every later open", { skip: process.platform !== "darwin" }, async (t) => {
  const { base, paseo, agents, reloaded, open } = await fixture(t, supporting);
  const installation = JSON.parse(await fs.readFile(path.join(base, "safehouse", "installation.json"), "utf8"));
  assert.ok(installation.wrapLauncher?.startsWith(`${base}/safehouse/launchers/wrap-`));
  const created = open("agent-1", "antigravity", "create", { [routeKey]: "wrap" });
  const result = await prepareOpening(created, paseo) as any;
  // Antigravity gets its grant profile and Safehouse's keychain integration.
  assert.deepEqual(result.wrap, ["/bin/sh", installation.wrapLauncher, "FIXTURE_TOKEN_NAME,PASEO_HOME,PASEO_AGENT_ID,PASEO_WORKSPACE_ID,PASEO_AGENT_CWD", installation.wrapProfiles.antigravity, "keychain"]);
  assert.match(result.env.SAFEHOUSE_WORKDIR, new RegExp(`^${base}/safehouse/snapshots/`));
  const home = await fs.realpath(os.homedir());
  const grants = await fs.readFile(installation.wrapProfiles.antigravity, "utf8");
  assert.ok(grants.includes(`(allow file-read* file-write* (subpath "${home}/.gemini/antigravity-cli"))\n`));
  assert.ok(grants.includes(`(allow file-read* (subpath "${home}/.gemini/config"))\n`));
  assert.ok(grants.includes(`(allow file-read-metadata (literal "${home}/.gemini"))\n`));
  assert.equal(grants.split("\n").filter(Boolean).length, 3);
  if (host) {
    const merged = await host.validateBeforeResult("agent.open.before", created, result);
    assert.deepEqual(merged.wrap, result.wrap);
  }
  // Resume and history opens carry no route metadata; the durable record selects the wrap.
  for (const [reason, purpose] of [["resume", "interactive"], ["refresh", "history"], ["create", "interactive"]]) {
    const later = await prepareOpening({ ...open("agent-1", "antigravity", reason), purpose } as any, paseo) as any;
    assert.deepEqual(later.wrap, result.wrap);
  }
  // Metadata alone never makes an existing agent wrapped: with the marker and no record the open is refused,
  // and an agent without the marker or the record is untouched.
  await assert.rejects(prepareOpening(open("agent-2", "antigravity", "resume", { [routeKey]: "wrap" }), paseo), /route record is missing/);
  const existing = open("agent-2", "antigravity", "resume");
  assert.equal(await prepareOpening(existing, paseo), existing);
  // A record for another provider, or a corrupt record, fails the open.
  await assert.rejects(prepareOpening(open("agent-1", "muse", "resume"), paseo), /names another provider/);
  await fs.writeFile(path.join(base, "safehouse", "agents", `${hash("agent-3")}.route.json`), "{");
  await assert.rejects(prepareOpening(open("agent-3", "antigravity", "resume"), paseo), /route record is unreadable or invalid/);
  agents.push({ agent: { id: "agent-1", workspaceId: "fixture", provider: "antigravity", title: "wrapped" } },
    { agent: { id: "agent-2", workspaceId: "fixture", provider: "antigravity", title: "ordinary" } });
  assert.deepEqual((await status(paseo, "fixture")).agents.map((agent) => agent.id), ["agent-1"]);
  assert.deepEqual(await reload(paseo, "fixture", "agent-1"), { agentId: "agent-1" });
  await assert.rejects(reload(paseo, "fixture", "agent-2"), /Select a Safehouse agent/);
  assert.deepEqual(reloaded, ["agent-1"]);
});

test("a caller-supplied route marker never selects the wrap route", { skip: process.platform !== "darwin" }, async (t) => {
  const { base, paseo, open } = await fixture(t, supporting);
  const record = (id: string) => path.join(base, "safehouse", "agents", `${hash(id)}.route.json`);
  // Safehouse Off by the draft choice: the marker is removed and everything else passes unchanged.
  const offDraft = { config: { cwd: base, provider: "antigravity" }, metadata: { kept: 1, [launchMetadataKey]: false, [routeKey]: "wrap" } };
  const routedOff = await routeCreation(offDraft as any, paseo) as any;
  assert.deepEqual(routedOff, { ...offDraft, metadata: { kept: 1, [launchMetadataKey]: false } });
  // The derived route also drops a marker it did not set.
  const claude = await routeCreation({ config: { cwd: base, provider: "claude", model: "small" }, metadata: { [routeKey]: "wrap" } } as any, paseo) as any;
  assert.equal(claude.config.provider, "safehouse-claude");
  assert.deepEqual(claude.metadata, {});
  // Safehouse Off by the workspace choice.
  await setWorkspaceRouting(paseo, "fixture", false);
  for (const provider of ["antigravity", "claude"]) {
    const routed = await routeCreation({ config: { cwd: base, provider }, metadata: { [routeKey]: "wrap" } } as any, paseo) as any;
    assert.deepEqual(routed, { config: { cwd: base, provider }, metadata: {} });
  }
  // The create open that Paseo then makes is ordinary and writes no route record.
  const created = open("agent-off", "antigravity", "create", routedOff.metadata);
  assert.equal(await prepareOpening(created, paseo), created);
  await assert.rejects(fs.access(record("agent-off")), { code: "ENOENT" });
});

test("a later open with the route marker but no route record is refused", { skip: process.platform !== "darwin" }, async (t) => {
  const { base, paseo, open } = await fixture(t, supporting);
  for (const [reason, purpose] of [["resume", "interactive"], ["refresh", "history"], ["import", "interactive"]])
    await assert.rejects(prepareOpening({ ...open("agent-lost", "antigravity", reason, { kept: 1, [routeKey]: "wrap" }), purpose } as any, paseo),
      /^Error: Safehouse route record is missing; recreate the agent or repair Safehouse state\.$/);
  // The refusal never writes a record, so the marker cannot turn the wrap on later.
  await assert.rejects(fs.access(path.join(base, "safehouse", "agents", `${hash("agent-lost")}.route.json`)), { code: "ENOENT" });
  const ordinary = open("agent-plain", "antigravity", "resume", { kept: 1 });
  assert.equal(await prepareOpening(ordinary, paseo), ordinary);
});

test("Refresh providers lists a configured provider as unsupported only where creation refuses it", { skip: process.platform !== "darwin" }, async (t) => {
  for (const [snapshot, listed] of [[supporting, ["muse"]], [undefined, ["antigravity", "muse"]]] as const) {
    const { paseo } = await fixture(t, snapshot, { antigravity: { enabled: true }, muse: { enabled: true } });
    const { unavailable } = await status(paseo, "fixture") as { unavailable: Record<string, string> };
    assert.deepEqual(Object.keys(unavailable).sort(), listed);
    for (const id of listed) assert.match(`SafehouseLaunchError: ${unavailable[id]}`, unsupported(id));
  }
});

test("setup installs the wrap launcher on a host whose only providers are plugin-supplied", { skip: process.platform !== "darwin" }, async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "safehouse-wrap-only-")));
  const bin = path.join(base, "bin");
  await fs.mkdir(bin);
  // A Safehouse fixture and no Pi, Claude or Codex on PATH.
  await fs.writeFile(path.join(bin, "safehouse"), "#!/bin/sh\nprintf 'Safehouse fixture\\n--trust-workdir-config\\nSupported values: keychain\\n'\n", { mode: 0o700 });
  const previous = { PASEO_HOME: process.env.PASEO_HOME, PATH: process.env.PATH };
  process.env.PASEO_HOME = base;
  process.env.PATH = bin;
  t.after(async () => {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await fs.rm(base, { recursive: true, force: true });
  });
  await atomicJson(path.join(base, "config.json"), { daemon: { listen: "127.0.0.1:45680" }, plugins: { "paseo-safehouse": { path: base } } });
  await fs.writeFile(path.join(base, ".safehouse"), "");
  const providers: Record<string, any> = {};
  const host = (snapshot?: () => Promise<unknown>) => ({
    providers: { listModels: async () => ({ models: [] }), ...(snapshot ? { snapshot } : {}) },
    config: { get: async () => ({ config: { providers } }), patch: async (patch: any) => Object.assign(providers, patch.providers) },
  }) as unknown as Parameters<typeof setup>[0];
  // Nothing is wrappable without launchWrap; Codex reports launchWrap but is not installed and takes the derived route.
  const nothing = /No configured harness can be wrapped/;
  await assert.rejects(setup(host()), nothing);
  await assert.rejects(setup(host(async () => ({ entries: [{ provider: "codex", launchWrap: true }, { provider: "antigravity" }] }))), nothing);
  const paseo = host(supporting);
  assert.deepEqual(await setup(paseo), { providers: [] });
  const installation = JSON.parse(await fs.readFile(path.join(base, "safehouse", "installation.json"), "utf8"));
  assert.ok(installation.wrapLauncher?.startsWith(`${base}/safehouse/launchers/wrap-`));
  await fs.access(installation.wrapLauncher);
  assert.ok(installation.wrapProfiles?.antigravity);
  const routed = await routeCreation({ config: { cwd: base, provider: "antigravity", model: "small" } }, paseo) as any;
  assert.equal(routed.metadata[routeKey], "wrap");
});

test("an installation from before the wrap route asks for Refresh providers", { skip: process.platform !== "darwin" }, async (t) => {
  const { base, paseo, open } = await fixture(t, supporting);
  const file = path.join(base, "safehouse", "installation.json");
  const { wrapLauncher, wrapProfiles: _profiles, ...older } = JSON.parse(await fs.readFile(file, "utf8"));
  assert.ok(wrapLauncher);
  await atomicJson(file, older);
  const refresh = /Refresh providers in the Safehouse panel to wrap this provider/;
  for (const extra of [{}, { requirePlugin: false }])
    await assert.rejects(routeCreation({ config: { cwd: base, provider: "antigravity" }, ...extra } as any, paseo), refresh);
  await assert.rejects(prepareOpening(open("agent-1", "antigravity", "create", { [routeKey]: "wrap" }), paseo), refresh);
});

test("the wrap launcher runs Safehouse around the literal harness argv in a prepared snapshot only", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "safehouse wrap ' $-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const capture = path.join(root, "capture.cjs");
  await fs.writeFile(capture, "console.log(JSON.stringify(process.argv.slice(2)))");
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const binary = path.join(root, "safehouse");
  await fs.writeFile(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(capture)} "$@"\n`, { mode: 0o700 });
  const guard = path.join(root, "guard.sb"), profile = path.join(root, "provider.sb");
  const launcher = path.join(root, "wrap.sh");
  await fs.writeFile(launcher, launch.renderWrapLauncher({ root, binary, guard, features: ["keychain"] }));
  const snapshot = path.join(root, "snapshots", "one");
  await fs.mkdir(snapshot, { recursive: true });
  await fs.writeFile(path.join(snapshot, ".safehouse"), "");
  const harness = ["/bin/echo", "acp", "two words", "$(touch forbidden)"];
  const exec = (workdir: string, args: string[]) =>
    run("/bin/sh", [launcher, ...args], { cwd: root, env: { PATH: "/usr/bin:/bin", SAFEHOUSE_WORKDIR: workdir } });
  const argv = JSON.parse((await exec(snapshot, ["NAME_ONE,PASEO_HOME", profile, "keychain", ...harness])).stdout) as string[];
  const execProfile = argv[argv.indexOf("--append-profile", argv.indexOf(profile)) + 1];
  assert.equal(path.dirname(execProfile), snapshot);
  assert.deepEqual(argv, ["--env-pass=NAME_ONE,PASEO_HOME", "--enable=keychain", "--trust-workdir-config", "--append-profile", profile,
    "--append-profile", execProfile, "--append-profile", guard, "--", ...harness]);
  assert.equal(await fs.readFile(execProfile, "utf8"), '(deny file-write* (literal "/bin/echo") (literal "/bin/echo"))\n');
  await assert.rejects(fs.access(path.join(root, "forbidden")));
  // A bare command resolves through PATH; no provider profile and no features omit those arguments.
  const bare = JSON.parse((await exec(snapshot, ["PASEO_HOME", "", "", "echo", "x"])).stdout) as string[];
  assert.deepEqual(bare.slice(0, 2), ["--env-pass=PASEO_HOME", "--trust-workdir-config"]);
  assert.deepEqual(bare.slice(bare.indexOf("--")), ["--", "/bin/echo", "x"]);
  assert.equal(bare.some((arg) => arg === profile || arg.startsWith("--enable")), false);
  assert.equal(bare.at(bare.indexOf("--") - 1), guard);
  for (const [workdir, args, message] of [
    [path.join(root, "catalog"), ["PASEO_HOME", profile, "", ...harness], /prepared Safehouse snapshot is required/],
    [path.join(root, "snapshots", "missing"), ["PASEO_HOME", profile, "", ...harness], /prepared Safehouse snapshot is required/],
    [snapshot, ["BAD;NAME", profile, "", ...harness], /invalid environment names/],
    [snapshot, ["PASEO_HOME", "/tmp/other.sb", "", ...harness], /outside Safehouse state/],
    [snapshot, ["PASEO_HOME", profile, "docker", ...harness], /unsupported Safehouse features/],
    [snapshot, ["PASEO_HOME", profile, "keychain,docker", ...harness], /unsupported Safehouse features/],
    [snapshot, ["PASEO_HOME", "", "", "no-such-harness"], /command no-such-harness is unavailable/],
    [snapshot, ["PASEO_HOME", "", ""], /no command/],
  ] as const) {
    await assert.rejects(exec(workdir, [...args]), (error: any) =>
      error.code === 78 && message.test(error.stderr) && error.stdout === "");
  }
});
