import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { grantProfile, renderBootstrap, renderWrapLauncher } from "../server/launch";
import {
  findExecutable,
  guardProfile,
  policyEnvironment,
  prepareSnapshot,
  resolvePolicy,
  loadPolicy,
  readSource,
  run,
} from "../server/policy";

test(
  "bootstrap enforces workspace snapshots and isolates catalog discovery",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const binary = await findExecutable("safehouse");
    assert.ok(binary, "Safehouse must be installed");
    const base = await fs.mkdtemp(
      path.join(os.homedir(), ".safehouse-test-"),
    );
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    for (const name of ["workspace", "readonly", "private", "state"])
      await fs.mkdir(path.join(base, name));
    const cwd = path.join(base, "workspace"),
      root = path.join(base, "state");
    for (const name of ["readonly", "private", "state"])
      await fs.writeFile(path.join(base, name, "canary"), "fixture");
    const listener = http.createServer((_req, res) => res.end("reachable"));
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    t.after(() => listener.close());
    const port = (listener.address() as { port: number }).port;
    const raw = `add-dirs-ro=${path.join(base, "readonly")}\nadd-dirs=${root}\n`;
    await fs.writeFile(path.join(cwd, ".safehouse"), raw);
    const policy = await resolvePolicy(raw, cwd, []);
    const snapshot = await prepareSnapshot(root, policy);
    const guard = path.join(root, "guard.sb");
    await fs.writeFile(guard, guardProfile([root], [], [port]));
    const bootstrap = path.join(root, "launch.sh");
    await fs.writeFile(
      bootstrap,
      renderBootstrap({
        root,
        binary,
        guard,
        executable: process.execPath,
        host: "claude",
      }),
    );
    const protectedFiles = ["setup-pending.json", "installation.json", "guard-retained.sb", "launcher-retained.sh"].map(name => path.join(root, name));
    for (const file of protectedFiles) await fs.writeFile(file, "retained bytes");
    protectedFiles.push(guard, bootstrap);
    const protectedBytes = await Promise.all(protectedFiles.map(file => fs.readFile(file, "utf8")));
    const protectedProbe = `const fs=require('node:fs');console.log(JSON.stringify(${JSON.stringify(protectedFiles)}.map(file=>{try{fs.writeFileSync(file,'overwritten');return 'allowed'}catch(e){return e.code}})));`;
    const protectedResult = JSON.parse((await run("/bin/sh", [bootstrap, "-e", protectedProbe], {
      cwd, env: policyEnvironment(process.env, snapshot), timeout: 45000,
    })).stdout);
    assert.deepEqual(protectedResult, protectedFiles.map(() => "EPERM"));
    assert.deepEqual(await Promise.all(protectedFiles.map(file => fs.readFile(file, "utf8"))), protectedBytes);
    const directResult = JSON.parse((await run(process.execPath, ["-e", protectedProbe], { cwd })).stdout);
    assert.deepEqual(directResult, protectedFiles.map(() => "allowed"));
    for (let i = 0; i < protectedFiles.length; i++) {
      assert.equal(await fs.readFile(protectedFiles[i], "utf8"), "overwritten");
      await fs.writeFile(protectedFiles[i], protectedBytes[i]);
    }
    t.diagnostic("Pending intent, installation, current and retained guard/launcher writes: EPERM with unchanged bytes; direct control overwrote every file.");
    const script = path.join(cwd, "probe.cjs");
    await fs.writeFile(
      script,
      `const fs=require('node:fs'),net=require('node:net');
const result={cwd:process.cwd(),sandbox:process.env.APP_SANDBOX_CONTAINER_ID};
const attempt=(name,fn)=>{try{result[name]=fn()??'allowed'}catch(e){result[name]=e.code}};
attempt('read',()=>fs.readFileSync(${JSON.stringify(path.join(base, "readonly", "canary"))},'utf8'));
attempt('write',()=>fs.writeFileSync(${JSON.stringify(path.join(cwd, "allowed"))},'ok'));
attempt('private',()=>fs.readFileSync(${JSON.stringify(path.join(base, "private", "canary"))},'utf8'));
attempt('state',()=>fs.readFileSync(${JSON.stringify(path.join(root, "canary"))},'utf8'));
attempt('readonly',()=>fs.writeFileSync(${JSON.stringify(path.join(base, "readonly", "write"))},'bad'));
attempt('policy',()=>fs.writeFileSync(${JSON.stringify(path.join(cwd, ".safehouse"))},'bad'));
attempt('snapshot',()=>fs.writeFileSync(${JSON.stringify(path.join(snapshot, ".safehouse"))},'bad'));
const socket=net.connect(${port},'127.0.0.1');socket.setTimeout(2000);
socket.on('connect',()=>{result.network='allowed';socket.destroy()});
socket.on('error',e=>{result.network=e.code});socket.on('timeout',()=>{result.network='timeout';socket.destroy()});
socket.on('close',()=>console.log(JSON.stringify(result)));`,
    );
    const sibling = path.join(base, "private", "canary");
    const empty = await resolvePolicy("", cwd, []);
    const clean = await prepareSnapshot(root, empty);
    const accessProbe = `const fs=require('node:fs'); const result={};
const attempt=(k,f)=>{try{result[k]=f()??'allowed'}catch(e){result[k]=e.code}};
attempt('read',()=>fs.readFileSync(${JSON.stringify(script)},'utf8').length>0);
attempt('write',()=>fs.writeFileSync(${JSON.stringify(path.join(cwd, "allowed"))},'ok'));
attempt('siblingRead',()=>fs.readFileSync(${JSON.stringify(sibling)},'utf8'));
attempt('siblingWrite',()=>fs.writeFileSync(${JSON.stringify(sibling)},'changed'));
console.log(JSON.stringify(result));`;
    const probeAccess = async (snapshotPath: string) => JSON.parse((await run(
      "/bin/sh", [bootstrap, "-e", accessProbe], {
        cwd, env: policyEnvironment(process.env, snapshotPath), timeout: 45000,
      },
    )).stdout);
    const assertAccess = (result: Record<string, unknown>) => {
      assert.equal(result.read, true);
      assert.equal(result.write, "allowed");
      assert.equal(result.siblingRead, "EPERM");
      assert.equal(result.siblingWrite, "EPERM");
    };
    const access = await probeAccess(clean);
    t.diagnostic(`Empty-policy access: ${JSON.stringify(access)}`);
    assertAccess(access);
    assert.equal(await fs.readFile(sibling, "utf8"), "fixture");
    assert.equal(await fs.readFile(path.join(cwd, "allowed"), "utf8"), "ok");
    // An extra sibling grant must make the same denial grader fail.
    await fs.appendFile(path.join(clean, ".safehouse"), `add-dirs=${path.dirname(sibling)}\n`);
    const control = await probeAccess(clean);
    t.diagnostic(`Sibling-grant negative control: ${JSON.stringify(control)}`);
    assert.throws(() => assertAccess(control), assert.AssertionError);
    assert.equal(control.siblingRead, "fixture");
    assert.equal(control.siblingWrite, "allowed");
    assert.equal(await fs.readFile(sibling, "utf8"), "changed");
    await fs.writeFile(sibling, "fixture");
    const malicious = path.join(base, `workspace\nadd-dirs=${path.dirname(sibling)}\n#`);
    await fs.mkdir(malicious, { recursive: true });
    const before = await fs.readdir(path.join(root, "snapshots"));
    await assert.rejects(async () => prepareSnapshot(root,
      await resolvePolicy("", malicious, [])), /Safehouse paths cannot contain/);
    assert.deepEqual(await fs.readdir(path.join(root, "snapshots")), before);
    t.diagnostic("Malicious workspace rejected before bootstrap execution");
    const started = Date.now();
    const probe = await fs.readFile(script, "utf8");
    const output = await run("/bin/sh", [bootstrap, "-e", probe], {
      cwd,
      env: policyEnvironment(process.env, snapshot),
      timeout: 45000,
    });
    const result = JSON.parse(output.stdout);
    t.diagnostic(`Sandbox startup and probes: ${Date.now() - started}ms`);
    assert.equal(result.cwd, cwd);
    assert.equal(result.sandbox, "agent-safehouse");
    assert.equal(result.read, "fixture");
    assert.equal(result.write, "allowed");
    for (const key of [
      "private",
      "state",
      "readonly",
      "policy",
      "snapshot",
      "network",
    ])
      assert.equal(result[key], "EPERM", key);
    const catalogOutput = await run("/bin/sh", [bootstrap, "-e", probe], {
      cwd,
      env: policyEnvironment(process.env, path.join(root, "catalog")),
      timeout: 45000,
    });
    const catalog = JSON.parse(catalogOutput.stdout);
    assert.equal(catalog.cwd, "/");
    assert.equal(catalog.sandbox, "agent-safehouse");
    for (const key of [
      "read",
      "write",
      "private",
      "state",
      "readonly",
      "policy",
      "snapshot",
      "network",
    ])
      assert.equal(catalog[key], "EPERM", `catalog ${key}`);
    await assert.rejects(
      run("/bin/sh", [bootstrap], {
        cwd,
        env: policyEnvironment(
          process.env,
          path.join(root, "preparation-required"),
        ),
        timeout: 15000,
      }),
      /prepared Safehouse snapshot/,
    );
  },
);

test("configured copilot command preserves argv and fails inside Safehouse without host retry", { skip: process.platform !== "darwin" }, async (t) => {
  const { configuredProvider } = await import("../server/providers");
  const base = await fs.mkdtemp(path.join(os.homedir(), ".safehouse-command-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, "workspace"), root = path.join(base, "state"), denied = path.join(base, "denied");
  for (const dir of [cwd, root, denied]) await fs.mkdir(dir);
  const canary = path.join(denied, "canary"), marker = path.join(denied, "host-marker"), allowed = path.join(cwd, "allowed");
  await fs.writeFile(canary, "private");
  const probe = `const fs=require('node:fs');const result={argv:process.argv.slice(1),env:process.env.PROVIDER_SENTINEL==='fixture-only'&&process.env.BASE_SENTINEL==='base-only'&&process.env.OVERRIDE==='source',blocked:!process.env.PASEO_PROBE&&!process.env.NODE_OPTIONS&&!process.env.UNLISTED_SENTINEL};
const attempt=(k,f)=>{try{result[k]=f()??'allowed'}catch(e){result[k]=e.code}};
attempt('write',()=>fs.writeFileSync(${JSON.stringify(allowed)},'workspace'));
attempt('read',()=>fs.readFileSync(${JSON.stringify(allowed)},'utf8'));
attempt('deniedRead',()=>fs.readFileSync(${JSON.stringify(canary)},'utf8'));
attempt('deniedWrite',()=>fs.writeFileSync(${JSON.stringify(marker)},'host'));
console.log(JSON.stringify(result));if(process.argv.includes('--fail'))process.exit(23);`;
  const literal = ["two words", "quote's", "$(touch forbidden)"];
  const configured = await configuredProvider("custom", { copilot: { env: { BASE_SENTINEL: "base-only", OVERRIDE: "base" } }, custom: { extends: "copilot", label: "Custom", env: { PROVIDER_SENTINEL: "fixture-only", OVERRIDE: "source", PASEO_PROBE: "blocked", NODE_OPTIONS: "--trace-warnings" }, command: [process.execPath, "-e", probe, "--", ...literal] } });
  const binary = await findExecutable("safehouse");
  assert.ok(binary);
  const snapshot = await prepareSnapshot(root, await resolvePolicy("", cwd, []));
  const guard = path.join(root, "guard.sb"), bootstrap = path.join(root, "launch.sh");
  await fs.writeFile(guard, guardProfile([root], [], []));
  await fs.writeFile(bootstrap, renderBootstrap({ root, binary, guard, command: configured.command, host: configured.base, envPass: configured.envPass }));
  const launch = (...args: string[]) => run("/bin/sh", [bootstrap, ...args], { cwd, env: policyEnvironment({ ...process.env, PROVIDER_SENTINEL: "fixture-only", BASE_SENTINEL: "base-only", OVERRIDE: "source", UNLISTED_SENTINEL: "not-configured", PASEO_PROBE: "blocked", NODE_OPTIONS: "--trace-warnings" }, snapshot), timeout: 45000 });
  const result = JSON.parse((await launch("protocol arg")).stdout);
  assert.deepEqual(result, { argv: [...literal, "protocol arg"], env: true, blocked: true, write: "allowed", read: "workspace", deniedRead: "EPERM", deniedWrite: "EPERM" });
  assert.equal(await fs.readFile(allowed, "utf8"), "workspace");
  await assert.rejects(launch("--fail"), (e: any) => e.code === 23 && JSON.parse(e.stdout).deniedWrite === "EPERM");
  await assert.rejects(fs.access(marker));
  await assert.rejects(fs.access(path.join(cwd, "forbidden")));
  const catalog = JSON.parse((await run("/bin/sh", [bootstrap], { cwd, env: policyEnvironment({ ...process.env, PROVIDER_SENTINEL: "fixture-only", BASE_SENTINEL: "base-only", OVERRIDE: "source", UNLISTED_SENTINEL: "not-configured", PASEO_PROBE: "blocked", NODE_OPTIONS: "--trace-warnings" }, path.join(root, "catalog")), timeout: 45000 })).stdout);
  assert.equal(catalog.env, true); assert.equal(catalog.blocked, true); assert.equal(catalog.write, "EPERM");
  const direct = JSON.parse((await run(configured.command[0], configured.command.slice(1), { cwd })).stdout);
  assert.equal(direct.deniedRead, "private");
  assert.equal(direct.deniedWrite, "allowed");
  assert.equal(await fs.readFile(marker, "utf8"), "host");
  t.diagnostic("Configured copilot-derived command: allowed workspace read/write, denied sibling read/write, literal argv; exit 23 preserved with no outside marker. Direct negative control accessed sibling.");
});

test("a launch reaches the paths its policy names and no trimmed sibling", { skip: process.platform !== "darwin" }, async (t) => {
  const binary = await findExecutable("safehouse");
  assert.ok(binary, "Safehouse must be installed");
  const base = await fs.mkdtemp(path.join(os.homedir(), ".safehouse-authority-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const q = JSON.stringify;
  const fixture = async (name: string, workspace = "workspace") => {
    const dir = path.join(base, name), cwd = path.join(dir, workspace), root = path.join(dir, "state");
    const secret = path.join(dir, "secret"), shared = path.join(dir, "shared"), lib = path.join(cwd, "lib");
    for (const made of [lib, root, secret, shared]) await fs.mkdir(made, { recursive: true });
    await fs.writeFile(path.join(secret, "canary"), "private");
    const guard = path.join(root, "guard.sb"), bootstrap = path.join(root, "launch.sh");
    await fs.writeFile(guard, guardProfile([root], [], []));
    await fs.writeFile(bootstrap, renderBootstrap({ root, binary, guard, executable: process.execPath, host: "claude" }));
    const launch = async (snapshot: string, body: string): Promise<Record<string, string>> => JSON.parse((await run("/bin/sh", [bootstrap, "-e",
      `const fs=require('node:fs');const r={};const a=(k,f)=>{try{r[k]=f()??'allowed'}catch(e){r[k]=e.code}};${body};console.log(JSON.stringify(r))`,
    ], { cwd, env: policyEnvironment(process.env, snapshot), timeout: 45000 })).stdout);
    const access = `a('secret',()=>fs.readFileSync(${q(path.join(secret, "canary"))},'utf8'));a('workspace',()=>fs.writeFileSync(${q(path.join(cwd, "ordinary"))},'ok'));
a('child',()=>{fs.mkdirSync(${q(path.join(cwd, "made"))},{recursive:true});fs.writeFileSync(${q(path.join(cwd, "made", "file"))},'ok');fs.writeFileSync(${q(path.join(lib, "file"))},'ok')});`;
    return { dir, cwd, root, secret, shared, lib, launch, access };
  };
  const allowed = { secret: "EPERM", workspace: "allowed", child: "allowed" };
  await t.test("ordinary grants, read-only grants, profiles and symlink inputs keep their access", async () => {
    const f = await fixture("ordinary"), [readOnly, profiled] = ["read-only", "profiled"].map((name) => path.join(f.dir, name));
    for (const dir of [readOnly, profiled]) {
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, "canary"), "fixture");
    }
    await fs.symlink(f.shared, path.join(f.cwd, "shared-link"));
    await fs.writeFile(path.join(f.cwd, "extra.sb"), `(allow file-read* (subpath ${q(profiled)}))\n`);
    const policy = await resolvePolicy("add-dirs=./shared-link\nadd-dirs-ro=../read-only\nappend-profile=./extra.sb\n", f.cwd, []);
    const probe = (key: string, dir: string) => `a('${key}Read',()=>fs.readFileSync(${q(path.join(dir, "canary"))},'utf8'));a('${key}Write',()=>fs.writeFileSync(${q(path.join(dir, "file"))},'ok'));`;
    const result = await f.launch(await prepareSnapshot(f.root, policy), f.access + `a('grantWrite',()=>fs.writeFileSync(${q(path.join(f.shared, "file"))},'ok'));` + probe("readOnly", readOnly) + probe("profile", profiled));
    assert.deepEqual(result, { ...allowed, grantWrite: "allowed", readOnlyRead: "fixture", readOnlyWrite: "EPERM", profileRead: "fixture", profileWrite: "EPERM" });
    assert.equal(await fs.readFile(path.join(f.shared, "file"), "utf8"), "ok");
  });
  // Each exact directory has an independently named sibling that a trimmed value would name instead.
  for (const kind of ["workspace", "grant"]) await t.test(`${kind} path with trailing whitespace`, async (t) => {
    const f = await fixture(`whitespace ${kind}`, kind === "workspace" ? "workspace " : "main");
    const exact = kind === "workspace" ? f.cwd : path.join(f.dir, "grant "), trimmed = path.join(f.dir, kind);
    await fs.mkdir(trimmed);
    await fs.writeFile(path.join(trimmed, "canary"), "unintended");
    if (kind === "grant") {
      await fs.mkdir(exact);
      await fs.symlink(exact, path.join(f.cwd, "link"));
    }
    const snapshot = await resolvePolicy(kind === "grant" ? "add-dirs=./link\n" : "", f.cwd, []).then((policy) => prepareSnapshot(f.root, policy)).catch((error: Error) => error);
    if (snapshot instanceof Error) {
      assert.match(snapshot.message, /whitespace/);
      assert.ok(snapshot.message.includes(q(exact)), snapshot.message);
      return assert.deepEqual(await fs.readdir(path.join(f.root, "snapshots")).catch(() => []), []);
    }
    const result = await f.launch(snapshot, `a('exact',()=>fs.writeFileSync(${q(path.join(exact, "nonce"))},'ok'));a('trimmedRead',()=>fs.readFileSync(${q(path.join(trimmed, "canary"))},'utf8'));a('trimmedWrite',()=>fs.writeFileSync(${q(path.join(trimmed, "nonce"))},'bad'));`);
    const observer = { exact: await fs.readFile(path.join(exact, "nonce"), "utf8").catch(() => null), trimmed: await fs.readFile(path.join(trimmed, "nonce"), "utf8").catch(() => null) };
    t.diagnostic(JSON.stringify({ result, observer }));
    assert.deepEqual({ result, observer }, { result: { exact: "allowed", trimmedRead: "EPERM", trimmedWrite: "EPERM" }, observer: { exact: "ok", trimmed: null } });
  });
});


test("absent source defaults protect policy creation and fixed boundaries", { skip: process.platform !== "darwin" }, async (t) => {
  const binary = await findExecutable("safehouse");
  assert.ok(binary);
  const base = await fs.mkdtemp(path.join(os.homedir(), ".safehouse-defaults-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, "workspace"), root = path.join(base, "state"), secret = path.join(base, "private", "canary");
  for (const dir of [cwd, root, path.dirname(secret)]) await fs.mkdir(dir);
  const plugin = path.join(cwd, "protected-code");
  await fs.writeFile(secret, "fixture"); await fs.writeFile(plugin, "fixture");
  const listener = http.createServer((_req, res) => res.end("fixture"));
  listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  t.after(() => listener.close());
  const port = (listener.address() as { port: number }).port;
  assert.equal(await readSource(cwd), null);
  const snapshot = await prepareSnapshot(root, await loadPolicy(cwd, []));
  const guard = path.join(root, "guard.sb"), bootstrap = path.join(root, "launch.sh");
  await fs.writeFile(guard, guardProfile([root], [plugin], [port]));
  await fs.writeFile(bootstrap, renderBootstrap({ root, binary, guard, executable: process.execPath, host: "claude" }));
  const q = JSON.stringify;
  const probe = `const fs=require('node:fs'),net=require('node:net');const r={};
const a=(k,f)=>{try{r[k]=f()??'allowed'}catch(e){r[k]=e.code}};
a('workspace',()=>{fs.writeFileSync(${q(path.join(cwd, 'ok'))},'ok');return fs.readFileSync(${q(path.join(cwd, 'ok'))},'utf8')});
a('private',()=>fs.readFileSync(${q(secret)},'utf8'));
a('policy',()=>fs.writeFileSync(${q(path.join(cwd,'.safehouse'))},'bad'));
a('snapshot',()=>fs.writeFileSync(${q(path.join(snapshot,'.safehouse'))},'bad'));
a('state',()=>fs.writeFileSync(${q(guard)},'bad'));
a('stateRead',()=>fs.readFileSync(${q(guard)},'utf8'));
a('plugin',()=>fs.writeFileSync(${q(plugin)},'bad'));
const s=net.connect(${port},'127.0.0.1');s.setTimeout(2000);s.on('connect',()=>{r.endpoint='allowed';s.destroy()});s.on('error',e=>r.endpoint=e.code);s.on('timeout',()=>{r.endpoint='timeout';s.destroy()});s.on('close',()=>console.log(JSON.stringify(r)));`;
  const launch = async () => JSON.parse((await run("/bin/sh", [bootstrap, "-e", probe], { cwd, env: policyEnvironment(process.env, snapshot), timeout: 45000 })).stdout);
  const grade = (r: Record<string, string>) => {
    assert.equal(r.workspace, "ok");
    for (const key of ["private", "policy", "snapshot", "state", "stateRead", "plugin", "endpoint"]) assert.equal(r[key], "EPERM", key);
  };
  const protectedFiles = [plugin, guard, path.join(snapshot, ".safehouse")];
  const before = await Promise.all(protectedFiles.map(file => fs.readFile(file, "utf8")));
  const result = await launch(); grade(result);
  assert.equal(await readSource(cwd), null);
  assert.deepEqual(await Promise.all(protectedFiles.map(file => fs.readFile(file, "utf8"))), before);
  await fs.writeFile(path.join(snapshot, "workspace.sb"), "; deliberately removed policy guard\n");
  const unguarded = await launch();
  assert.throws(() => grade(unguarded)); assert.equal(unguarded.policy, "allowed");
  assert.equal(await readSource(cwd), "bad");
  await fs.rm(path.join(cwd, ".safehouse"));
  const direct = JSON.parse((await run(process.execPath, ["-e", probe], { cwd, timeout: 10000 })).stdout);
  assert.throws(() => grade(direct));
  for (const key of ["policy", "snapshot", "state", "plugin", "endpoint"]) assert.equal(direct[key], "allowed");
  t.diagnostic(`Defaults: ${JSON.stringify(result)}; guard removal allowed policy creation; direct control violated fixed denials.`);
});

test("a launch grants only the selected account home below an Off daemon home", { skip: process.platform !== "darwin" }, async (t) => {
  const binary = await findExecutable("safehouse");
  assert.ok(binary, "Safehouse must be installed");
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.homedir(), ".safehouse-account-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, "daemon"), root = path.join(home, "safehouse"), homes = path.join(home, "x", "homes");
  const [a, b, ws, outside] = [path.join(homes, "a"), path.join(homes, "b"), path.join(base, "workspace"), path.join(base, "outside")];
  const shared = path.join(home, "x", "shared.txt");
  for (const dir of [a, b, ws, outside, path.join(root, "snapshots")]) await fs.mkdir(dir, { recursive: true });
  for (const [file, text] of [[path.join(a, "sentinel"), "A"], [path.join(b, "sentinel"), "B"], [path.join(home, "config.json"), "{}"],
    [path.join(root, "installation.json"), "{}"], [shared, "S"], [path.join(ws, "ws.txt"), "W"], [path.join(outside, "out.txt"), "X"]])
    await fs.writeFile(file, text);
  for (const [name, target] of [["workspace", path.join(ws, "ws.txt")], ["shared", shared], ["other", path.join(b, "sentinel")], ["outside", path.join(outside, "out.txt")]])
    await fs.symlink(target, path.join(a, `link-${name}`));
  const listener = http.createServer((_req, res) => res.end("daemon"));
  listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  t.after(() => listener.close());
  const port = (listener.address() as { port: number }).port;
  const guard = path.join(root, "guard.sb");
  await fs.writeFile(guard, guardProfile([root], [], []));
  const names = { claude: ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"], codex: ["CODEX_HOME", "CODEX_SQLITE_HOME"] };
  for (const [host, accountEnv] of Object.entries(names))
    await fs.writeFile(path.join(root, `${host}.sh`), renderBootstrap({ root, binary, guard, executable: process.execPath, host, accountEnv }));
  // Each Off snapshot denies the whole daemon home, as an opening without daemon access does.
  const offSnapshot = async () => prepareSnapshot(root, await resolvePolicy("", ws, []), guardProfile([home], [], [port]));
  // The test process may itself run under an account switcher; its values never reach a fixture launch.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !Object.values(names).flat().includes(name)));
  const q = JSON.stringify;
  const probe = (selected: string, other: string) => `const fs=require('node:fs'),net=require('node:net');const r={};
const a=(k,f)=>{try{r[k]=f()??'allowed'}catch(e){r[k]=e.code}};
r.env=${q(Object.values(names).flat())}.map(n=>process.env[n]).filter(Boolean);
a('selected',()=>fs.readFileSync(${q(path.join(selected, "sentinel"))},'utf8'));a('selectedWrite',()=>fs.writeFileSync(${q(path.join(selected, "written"))},'ok'));
a('resolve',()=>fs.realpathSync.native(${q(selected)}));a('resolveJs',()=>fs.realpathSync(${q(selected)}));
a('other',()=>fs.readFileSync(${q(path.join(other, "sentinel"))},'utf8'));a('config',()=>fs.readFileSync(${q(path.join(home, "config.json"))},'utf8'));
a('list',()=>fs.readdirSync(${q(home)}).length);a('plugin',()=>fs.readFileSync(${q(path.join(root, "installation.json"))},'utf8'));
a('parentWrite',()=>fs.writeFileSync(${q(path.join(homes, "escape"))},'bad'));a('outside',()=>fs.readFileSync(${q(path.join(outside, "out.txt"))},'utf8'));
for(const l of ['workspace','shared','other','outside'])a('link-'+l,()=>fs.readFileSync(${q(a)}+'/link-'+l,'utf8'));
const s=net.connect(${port},'127.0.0.1');s.setTimeout(2000);s.on('connect',()=>{r.port='allowed';s.destroy()});s.on('error',e=>r.port=e.code);s.on('timeout',()=>{r.port='timeout';s.destroy()});s.on('close',()=>console.log(JSON.stringify(r)));`;
  const launch = (host: string, snapshot: string, env: Record<string, string>, body = probe(a, b)) =>
    run("/bin/sh", [path.join(root, `${host}.sh`), "-e", body], { cwd: ws, env: { ...policyEnvironment(inherited, snapshot), ...env }, timeout: 45000 });
  const denied = { other: "EPERM", config: "EPERM", list: "EPERM", plugin: "EPERM", parentWrite: "EPERM", outside: "EPERM", port: "EPERM" };
  await t.test("the selected home is usable, other daemon files stay denied, and links reach only allowed targets", async (t) => {
    const result = JSON.parse((await launch("claude", await offSnapshot(), { CLAUDE_CONFIG_DIR: a, CLAUDE_SECURESTORAGE_CONFIG_DIR: a })).stdout);
    t.diagnostic(q(result));
    assert.deepEqual(result, { env: [a, a], selected: "A", selectedWrite: "allowed", resolve: a, resolveJs: a, ...denied,
      "link-workspace": "W", "link-shared": "EPERM", "link-other": "EPERM", "link-outside": "EPERM" });
    assert.equal(await fs.readFile(path.join(a, "written"), "utf8"), "ok");
  });
  await t.test("two launches write separate account profiles and each reaches only its own home", async (t) => {
    const snapshot = await offSnapshot(), results = [];
    for (const [host, selected, other] of [["claude", a, b], ["codex", b, a]]) {
      const env = Object.fromEntries(names[host as "claude"].map((name) => [name, selected]));
      results.push(JSON.parse((await launch(host, snapshot, env, probe(selected, other))).stdout));
    }
    t.diagnostic(q(results));
    assert.deepEqual(results.map((r) => [r.env, r.selected, r.other, r.list]), [[[a, a], "A", "EPERM", "EPERM"], [[b, b], "B", "EPERM", "EPERM"]]);
    const profiles = (await fs.readdir(snapshot)).filter((name) => /^account-\d+\.sb$/.test(name));
    const grants = await Promise.all(profiles.map(async (name) => (await fs.readFile(path.join(snapshot, name), "utf8")).match(/\(subpath "[^"]*"\)/g)));
    assert.deepEqual(grants.sort(), [[`(subpath ${q(a)})`], [`(subpath ${q(b)})`]]);
  });
  await t.test("a home outside the daemon home passes unchanged without a grant", async () => {
    const result = JSON.parse((await launch("claude", await offSnapshot(), { CLAUDE_CONFIG_DIR: outside })).stdout);
    assert.deepEqual([result.env, result.outside, result.selected], [[outside], "EPERM", "EPERM"]);
  });
  await t.test("refused values stop the launch before the harness starts", async () => {
    const snapshot = await offSnapshot();
    for (const [label, value, message] of [["relative", "x/homes/a", /absolute/], ["missing", path.join(homes, "none"), /existing directory/],
      ["daemon home", home, /two levels/], ["one level", path.join(home, "x"), /two levels/], ["plugin state", path.join(root, "snapshots"), /Safehouse state/],
      ["quote", path.join(homes, 'q"q'), /character/], ["backslash", path.join(homes, "b\\s"), /character/],
      ["tab", path.join(homes, "t\tab"), /character/], ["trailing newline", path.join(homes, "n\n"), /character/]] as const) {
      if (label !== "relative" && label !== "missing") await fs.mkdir(value, { recursive: true });
      const failure = await launch("codex", snapshot, { CODEX_SQLITE_HOME: value }).then(() => null, (e) => e);
      assert.deepEqual([failure?.code, failure?.stdout], [78, ""], label);
      assert.match(failure.stderr, /CODEX_SQLITE_HOME/, label);
      assert.match(failure.stderr, message, label);
    }
  });
});

test("a wrapped launch gets the workspace and its grants, and the daemon, state and harness stay protected", { skip: process.platform !== "darwin" }, async (t) => {
  const binary = await findExecutable("safehouse");
  assert.ok(binary, "Safehouse must be installed");
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.homedir(), ".safehouse-wrap-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, "daemon"), root = path.join(home, "safehouse"), ws = path.join(base, "workspace");
  const [granted, readable, other] = ["granted/state", "granted/config", "other"].map((name) => path.join(base, name));
  for (const dir of [ws, granted, readable, other, path.join(root, "snapshots")]) await fs.mkdir(dir, { recursive: true });
  for (const dir of [readable, other]) await fs.writeFile(path.join(dir, "canary"), "fixture");
  await fs.writeFile(path.join(root, "installation.json"), "{}");
  await fs.writeFile(path.join(home, "config.json"), "{}");
  const listener = http.createServer((_req, res) => res.end("daemon"));
  listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  t.after(() => listener.close());
  const port = (listener.address() as { port: number }).port;
  const guard = path.join(root, "guard.sb"), profile = path.join(root, "provider.sb"), launcher = path.join(root, "wrap.sh");
  await fs.writeFile(guard, guardProfile([root], [], []));
  await fs.writeFile(profile, grantProfile(base, { readWrite: ["granted/state"], readOnly: ["granted/config"] }));
  await fs.writeFile(launcher, renderWrapLauncher({ root, binary, guard, features: ["keychain"] }));
  // The harness lies in the writable workspace, so only the launcher's executable rule protects it.
  const harness = path.join(ws, "harness");
  await fs.writeFile(harness, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  const snapshot = await prepareSnapshot(root, await resolvePolicy("", ws, []), guardProfile([home], [], [port]));
  const q = JSON.stringify;
  const probe = `const fs=require('node:fs'),net=require('node:net');const r={};
const a=(k,f)=>{try{r[k]=f()??'allowed'}catch(e){r[k]=e.code}};
a('workspace',()=>fs.writeFileSync(${q(path.join(ws, "written"))},'ok'));a('granted',()=>fs.writeFileSync(${q(path.join(granted, "written"))},'ok'));
a('readable',()=>fs.readFileSync(${q(path.join(readable, "canary"))},'utf8'));a('readableWrite',()=>fs.writeFileSync(${q(path.join(readable, "canary"))},'bad'));
a('other',()=>fs.readFileSync(${q(path.join(other, "canary"))},'utf8'));a('harness',()=>fs.writeFileSync(${q(harness)},'bad'));
a('plugin',()=>fs.readFileSync(${q(path.join(root, "installation.json"))},'utf8'));a('config',()=>fs.readFileSync(${q(path.join(home, "config.json"))},'utf8'));
const s=net.connect(${port},'127.0.0.1');s.setTimeout(2000);s.on('connect',()=>{r.port='allowed';s.destroy()});s.on('error',e=>r.port=e.code);s.on('timeout',()=>{r.port='timeout';s.destroy()});s.on('close',()=>console.log(JSON.stringify(r)));`;
  const result = JSON.parse((await run("/bin/sh", [launcher, "PASEO_HOME", profile, "keychain", harness, "-e", probe], {
    cwd: ws, env: policyEnvironment(process.env, snapshot), timeout: 45000,
  })).stdout);
  t.diagnostic(q(result));
  assert.deepEqual(result, { workspace: "allowed", granted: "allowed", readable: "fixture", readableWrite: "EPERM",
    other: "EPERM", harness: "EPERM", plugin: "EPERM", config: "EPERM", port: "EPERM" });
  assert.match(await fs.readFile(harness, "utf8"), /^#!\/bin\/sh/);
});

test("a wrapped launch denies writes to the harness link and its target by canonical path, however the command names them", { skip: process.platform !== "darwin" }, async (t) => {
  const binary = await findExecutable("safehouse");
  assert.ok(binary, "Safehouse must be installed");
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.homedir(), ".safehouse-wrap-canonical-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, "daemon"), root = path.join(home, "safehouse"), ws = path.join(base, "workspace");
  const bin = path.join(ws, "bin"), lib = path.join(ws, "lib"), alias = path.join(ws, "alias");
  for (const dir of [bin, lib, path.join(root, "snapshots")]) await fs.mkdir(dir, { recursive: true });
  // Everything lies in the writable workspace, so only the launcher's executable rule protects the harness.
  await fs.symlink(bin, alias);
  const target = path.join(lib, "harness-real"), link = path.join(bin, "harness"), script = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`;
  await fs.writeFile(target, script, { mode: 0o755 });
  const guard = path.join(root, "guard.sb"), launcher = path.join(root, "wrap.sh");
  await fs.writeFile(guard, guardProfile([root], [], []));
  await fs.writeFile(launcher, renderWrapLauncher({ root, binary, guard, features: [] }));
  const snapshot = await prepareSnapshot(root, await resolvePolicy("", ws, []), guardProfile([home], [], []));
  const q = JSON.stringify, spare = path.join(ws, "spare");
  const probe = `const fs=require('node:fs');const r={};const a=(k,f)=>{try{f();r[k]='allowed'}catch(e){r[k]=e.code}};
a('target',()=>fs.appendFileSync(${q(target)},'#'));
fs.writeFileSync(${q(spare)},'x');a('replaceLink',()=>fs.renameSync(${q(spare)},${q(link)}));
a('removeLink',()=>fs.unlinkSync(${q(link)}));console.log(JSON.stringify(r));`;
  const launchWith = (command: string, PATH: string) => run("/bin/sh", [launcher, "PASEO_HOME", "", "", command, "-e", probe], {
    cwd: ws, env: policyEnvironment({ ...process.env, PATH }, snapshot), timeout: 45000,
  });
  const results: Record<string, unknown> = {};
  for (const [label, command, PATH] of [
    ["a canonical PATH folder", "harness", `${bin}:/usr/bin:/bin`],
    ["a trailing slash in a PATH folder", "harness", `${bin}/:/usr/bin:/bin`],
    ["a doubled slash in a PATH folder", "harness", `${ws}//bin:/usr/bin:/bin`],
    ["a symlinked PATH folder", "harness", `${alias}:/usr/bin:/bin`],
    ["dot segments in the command", `${bin}/../bin/./harness`, "/usr/bin:/bin"],
    ["a symlinked folder in the command", `${alias}/harness`, "/usr/bin:/bin"],
  ] as const) {
    await fs.rm(link, { force: true });
    await fs.symlink(target, link);
    await fs.writeFile(target, script, { mode: 0o755 });
    const result = JSON.parse((await launchWith(command, PATH)).stdout);
    t.diagnostic(`${label}: ${q(result)}`);
    results[label] = { ...result, intact: await fs.readlink(link).catch(() => null) === target && await fs.readFile(target, "utf8") === script };
  }
  assert.deepEqual(results, Object.fromEntries(Object.keys(results).map((label) =>
    [label, { target: "EPERM", replaceLink: "EPERM", removeLink: "EPERM", intact: true }])));
  // Command substitution drops trailing newlines. A target whose name ends in one is refused, not denied by a shortened rule.
  const newline = path.join(lib, "harness-nl\n");
  await fs.writeFile(newline, script, { mode: 0o755 });
  await fs.symlink(newline, path.join(bin, "nl-harness"));
  const failure = await launchWith("nl-harness", `${bin}:/usr/bin:/bin`).then(() => null, (e) => e);
  assert.deepEqual([failure?.code, failure?.stdout], [78, ""]);
  assert.match(failure.stderr, /control character/);
});
