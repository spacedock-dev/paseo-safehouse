import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parsePolicy, quotePath } from "../shared/policy";

export const run = promisify(execFile);
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function macOnly(platform: string = process.platform) {
  if (platform !== "darwin")
    throw new Error("Safehouse requires a macOS daemon host.");
}
export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function atomicWrite(file: string, data: string) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, data, { mode: 0o600, flag: "wx" });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
export const atomicJson = (file: string, data: unknown) =>
  atomicWrite(file, JSON.stringify(data, null, 2) + "\n");
export async function canonicalDirectory(dir: string) {
  if (!path.isAbsolute(dir))
    throw new Error("The workspace path must be absolute.");
  const real = await fs.realpath(dir);
  if (!(await fs.stat(real)).isDirectory())
    throw new Error("The workspace must be a directory.");
  return real;
}
export async function findExecutable(name: string) {
  const files = name.includes("/")
    ? [name]
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((p) => path.join(p, name));
  for (const file of files) {
    try {
      await fs.access(file, constants.X_OK);
      if ((await fs.stat(file)).isFile())
        return path.join(
          await fs.realpath(path.dirname(file)),
          path.basename(file),
        );
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return null;
}
// Paseo sets these per-agent identifiers after the open hook returns. Only session launchers pass them.
export const paseoIdentityNames = ["PASEO_AGENT_ID", "PASEO_WORKSPACE_ID", "PASEO_AGENT_CWD"];
export const blockedEnvironmentName = (name: string) =>
  /^(SAFEHOUSE_|PASEO_|DYLD_|LD_|BASH_FUNC_)/.test(name) ||
  ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS"].includes(name);
export function providerEnvironmentNames(names: string[]) {
  if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
    throw new Error("Provider environment contains an invalid variable name.");
  return [...new Set(names)].filter((name) => !blockedEnvironmentName(name));
}
export function policyEnvironment(
  input: Record<string, string | undefined>,
  workdir: string,
  daemonHome = "",
): Record<string, string> {
  const result: Record<string, string> = {};
  // Empty values mask daemon inheritance in adapters that merge environments.
  for (const name of new Set([
    ...Object.keys(process.env),
    ...Object.keys(input),
  ])) {
    if (blockedEnvironmentName(name))
      result[name] = "";
    else if (input[name] !== undefined) result[name] = input[name]!;
  }
  return {
    ...result,
    PASEO_HOME: daemonHome,
    SAFEHOUSE_WORKDIR: workdir,
    SAFEHOUSE_ADD_DIRS: "",
    SAFEHOUSE_ADD_DIRS_RO: "",
    SAFEHOUSE_ENV_PASS: "",
    SAFEHOUSE_TRUST_WORKDIR_CONFIG: "1",
  };
}
export async function capabilities(binary: string) {
  macOnly();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        value !== undefined && !/^(SAFEHOUSE_|PASEO_|DYLD_|LD_)/.test(name),
    ),
  ) as Record<string, string>;
  const { stdout } = await run(binary, ["--help"], {
    env,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  const match = /Supported values:\s*([^\n]+)/.exec(stdout);
  if (!match || !stdout.includes("--trust-workdir-config"))
    throw new Error("This Safehouse version lacks required policy support.");
  return {
    features: match[1].split(",").map((x) => x.trim()),
    version: stdout.split("\n")[0].trim(),
  };
}
export async function readSource(cwd: string) {
  const file = path.join(cwd, ".safehouse");
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new Error(".safehouse must be a regular file under 1 MB.");
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
// Safehouse trims each configuration value, so a value with edge whitespace would name a different path.
function policyPath(value: string, exact = true) {
  if (/[:\r\n\0]/.test(value))
    throw new Error("Safehouse paths cannot contain colons, line breaks, or NUL.");
  if (exact && value !== value.trim())
    throw new Error(`Safehouse cannot grant a path that begins or ends with whitespace: ${quotePath(value)}`);
  return value;
}
// The canonical path that the first line of a regular file under 4 KB names, resolved against the file's folder.
// A `.git` link is never followed, and git is never run on repository files that an agent can write.
async function gitLink(file: string, prefix = "") {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size >= 4096) return null;
    const line = (await fs.readFile(file, "utf8")).split("\n")[0];
    if (!line.startsWith(prefix) || line.length === prefix.length) return null;
    return await fs.realpath(path.resolve(path.dirname(file), line.slice(prefix.length)));
  } catch {
    return null;
  }
}
const gitIs = (file: string, kind: "isFile" | "isDirectory") => fs.stat(file).then((s) => s[kind](), () => false);
// Safehouse's repository-root test: a git dir holds a `HEAD` file and `objects` and `refs` folders.
const gitRepo = async (dir: string) => (await gitIs(path.join(dir, "HEAD"), "isFile")) &&
  (await gitIs(path.join(dir, "objects"), "isDirectory")) && (await gitIs(path.join(dir, "refs"), "isDirectory"));
const expressible = (value: string) => { try { return !!policyPath(value); } catch { return false; } };
/**
 * Safehouse's own git access for a workspace that is a worktree root: read-write on a linked worktree's common dir,
 * read-only on the repository's other worktrees. Each link must point back, so files a sandboxed process can
 * write cannot aim a later launch at another folder:
 * 1. the active admin dir is `<common>/worktrees/<id>`, and the common dir passes Safehouse's repository-root test;
 * 2. the admin dir's `gitdir` names `<cwd>/.git`;
 * 3. a listed worktree's own `.git` names its admin dir, and the main checkout's `.git` is the common dir.
 */
export async function gitAccess(cwd: string): Promise<{ commonDir: string | null; worktrees: string[] }> {
  const none = { commonDir: null, worktrees: [] };
  const marker = path.join((cwd = await fs.realpath(cwd).catch(() => cwd)), ".git");
  const stat = await fs.lstat(marker).catch(() => null);
  let common: string, commonDir: string | null = null;
  const worktrees: string[] = [];
  if (stat?.isDirectory()) {
    if (!(await gitRepo(marker))) return none;
    common = marker;
  } else if (stat?.isFile()) {
    const admin = await gitLink(marker, "gitdir: ");
    if (!admin || !(await gitIs(path.join(admin, "HEAD"), "isFile"))) return none;
    const found = await gitLink(path.join(admin, "commondir"));
    // Check 1. The shape test stops a workspace in a folder named `worktrees` from serving as its own admin dir.
    if (!found || path.dirname(admin) !== path.join(found, "worktrees") || !(await gitRepo(found))) return none;
    if ((await gitLink(path.join(admin, "gitdir"))) !== marker) return none; // Check 2.
    common = commonDir = found;
    // Check 3 for the main checkout: a canonical common dir named .git is its `.git` folder.
    if (path.basename(common) === ".git") worktrees.push(path.dirname(common));
  } else return none;
  const entries = path.join(common, "worktrees");
  for (const name of (await fs.readdir(entries).catch(() => [])).sort()) {
    const entry = path.join(entries, name), target = await gitLink(path.join(entry, "gitdir"));
    // Check 3: the worktree's own `.git` names this entry by its canonical path.
    if (target && path.basename(target) === ".git" && (await gitLink(target, "gitdir: ")) === entry)
      worktrees.push(path.dirname(target));
  }
  return {
    commonDir: commonDir && expressible(commonDir) ? commonDir : null,
    worktrees: [...new Set(worktrees)].filter((dir) => dir !== cwd && expressible(dir)),
  };
}
export async function resolvePolicy(
  raw: string,
  cwd: string,
  supported: string[],
) {
  cwd = policyPath(await canonicalDirectory(cwd));
  const parsed = parsePolicy(raw);
  for (const feature of parsed.enable)
    if (!supported.includes(feature))
      throw new Error(`Unsupported Safehouse capability: ${feature}`);
  const resolve = async (value: string, grant = true) => {
    const expanded =
      value === "~"
        ? homedir()
        : value.startsWith("~/")
          ? path.join(homedir(), value.slice(2))
          : value;
    const real = await fs.realpath(path.resolve(cwd, expanded));
    return policyPath(real, grant);
  };
  const readOnly = [
    ...new Set(await Promise.all(parsed.readOnly.map((value) => resolve(value)))),
  ];
  const readWrite = [
    ...new Set(await Promise.all(parsed.readWrite.map((value) => resolve(value)))),
  ];
  const profiles = await Promise.all(
    parsed.profiles.map(async (value) => {
      // A profile is copied into the snapshot, so its own path is never a configuration value.
      const file = await resolve(value, false);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 1024 * 1024)
        throw new Error("Custom profiles must be regular files under 1 MB.");
      const content = await fs.readFile(file, "utf8");
      if (/\(\s*(?:include|import)\b/.test(content.replace(/;[^\n]*/g, "")))
        throw new Error(
          "Custom profiles must be self-contained. Inline imported profiles before review.",
        );
      return { path: file, content };
    }),
  );
  const policy = {
    cwd,
    raw,
    readOnly,
    readWrite,
    enable: [...new Set(parsed.enable)],
    profiles,
    git: await gitAccess(cwd),
  };
  return { ...policy, digest: hash(JSON.stringify(policy)) };
}
export type ResolvedPolicy = Awaited<ReturnType<typeof resolvePolicy>>;
export async function loadPolicy(cwd: string, features: string[]) {
  return resolvePolicy((await readSource(cwd)) ?? "", cwd, features);
}
export function guardProfile(
  readDenied: string[],
  writeDenied: string[],
  ports: number[],
) {
  for (const port of ports)
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid daemon port.");
  const q = JSON.stringify;
  return (
    [
      "; Fixed restrictions after workspace profiles.",
      ...[...new Set(ports)].map(
        (p) => `(deny network-outbound (remote tcp ${q(`*:${p}`)}))`,
      ),
      ...[...new Set(readDenied)].flatMap((p) => [
        `(deny file-read* file-write* (subpath ${q(p)}))`,
        `(deny network-outbound (subpath ${q(p)}))`,
      ]),
      ...[...new Set(writeDenied)].map(
        (p) => `(deny file-write* (subpath ${q(p)}))`,
      ),
    ].join("\n") + "\n"
  );
}
export async function prepareSnapshot(root: string, policy: ResolvedPolicy, daemonGuard = "") {
  policyPath(root);
  policyPath(policy.cwd);
  for (const p of [...policy.readOnly, ...policy.readWrite]) policyPath(p);
  policy.profiles.forEach((profile) => policyPath(profile.path, false));
  const parent = path.join(root, "snapshots");
  const prefix = policyPath(path.join(parent, `${policy.digest.slice(0, 12)}-`));
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = await fs.mkdtemp(prefix);
  try {
    const lines = [`add-dirs=${policyPath(policy.cwd)}`];
    lines.push(
      ...policy.readOnly.map((p) => `add-dirs-ro=${policyPath(p)}`),
      ...policy.readWrite.map((p) => `add-dirs=${policyPath(p)}`),
      // Safehouse's own worktree access, which it grants only to a workdir it detects itself.
      ...(policy.git.commonDir ? [`add-dirs=${policyPath(policy.git.commonDir)}`] : []),
      ...policy.git.worktrees.map((p) => `add-dirs-ro=${policyPath(p)}`),
    );
    lines.push(...policy.enable.map((f) => `enable=${f}`));
    for (let i = 0; i < policy.profiles.length; i++) {
      const file = policyPath(path.join(dir, `profile-${i}.sb`));
      await atomicWrite(file, policy.profiles[i].content);
      lines.push(`append-profile=${file}`);
    }
    const guard = policyPath(path.join(dir, "workspace.sb"));
    await atomicWrite(
      guard,
      guardProfile(
        [],
        [
          path.join(policy.cwd, ".safehouse"),
          ...policy.profiles.map((p) => p.path),
        ],
        [],
      ),
    );
    lines.push(`append-profile=${guard}`);
    if (daemonGuard) {
      const file = policyPath(path.join(dir, "daemon.sb"));
      await atomicWrite(file, daemonGuard);
      lines.push(`append-profile=${file}`);
    }
    await atomicWrite(path.join(dir, ".safehouse"), lines.join("\n") + "\n");
    return dir;
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}
export const policyRevision = (raw: string | null) => hash(JSON.stringify(raw));
export async function savePolicy(
  cwd: string,
  policy: ResolvedPolicy,
  expectedRevision: string,
) {
  const file = path.join(cwd, ".safehouse");
  const lock = await fs.open(`${file}.safehouse-lock`, "wx", 0o600);
  try {
    const current = await readSource(cwd);
    if (policyRevision(current) !== expectedRevision)
      throw new Error(".safehouse changed on disk. Review the new contents.");
    if (current !== policy.raw) await atomicWrite(file, policy.raw);
  } finally {
    await lock.close();
    await fs.rm(`${file}.safehouse-lock`, { force: true });
  }
}
