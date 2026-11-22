import type {
  PluginHandlerContext,
  PluginBeforeRequests,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type { availabilitySchema } from "../shared/contracts";
import { grantProfile, renderBootstrap, renderWrapLauncher } from "./launch";
import { finishPending, savePending, serializeSetup, validateInstallation } from "./setup";
import {
  configuredProvider, derivedBase, launchError, launchWrapProviders, launchWrapSupported, unsupportedError, wrapGrants, type ProviderConfig,
} from "./providers";
import {
  atomicJson,
  atomicWrite,
  capabilities,
  blockedEnvironmentName,
  canonicalDirectory,
  findExecutable,
  guardProfile,
  hash,
  macOnly,
  policyEnvironment,
  policyRevision,
  prepareSnapshot,
  providerEnvironmentNames,
  readJson,
  readSource,
  loadPolicy,
  resolvePolicy,
  run,
  savePolicy,
  type ResolvedPolicy,
} from "./policy";

import { launchChoice, paseoAccessKey, paseoAccessValues, sessionMetadataKey } from "../shared/contracts";

type Paseo = PluginHandlerContext["paseo"];
export const PLUGIN_ID = "paseo-safehouse";
export const HOSTS = ["pi", "claude", "codex"] as const;
export const variant = (provider: string) => `safehouse-${provider}`;
export const native = (provider: string) =>
  HOSTS.find((host) => variant(host) === provider);
export const daemonHome = () =>
  path.resolve(process.env.PASEO_HOME || path.join(homedir(), ".paseo"));
export const stateRoot = () => path.join(daemonHome(), "safehouse");
type Variant = ProviderConfig;
type Source = { provider: string; base: string; source: ProviderConfig | null; baseSource: ProviderConfig | null };
export type Installation = {
  binary: string;
  features: string[];
  version: string;
  home: string;
  port: number;
  source: string;
  entries: Record<string, Variant>;
  sources?: Record<string, Source>;
  unavailable?: Record<string, string>;
  guard: string;
  catalogGuard?: string;
  piCatalogExtensions?: string[];
  /** The generic session launcher for providers on the launch-wrap route. */
  wrapLauncher?: string;
  /** Grant profiles for providers on the launch-wrap route, by provider ID. */
  wrapProfiles?: Record<string, string>;
};
type Receipt = {
  agentId: string;
  cwd: string;
  provider: string;
  digest: string;
  snapshot: string;
  preparedAt: string;
  reason: string;
  daemonAccess?: boolean;
  paseoAccess?: PaseoAccess;
};
type PaseoAccess = (typeof paseoAccessValues)[number];
export const receiptPath = (id: string) =>
  path.join(stateRoot(), "agents", `${hash(id)}.json`);

const agentAccessPath = (id: string) => path.join(stateRoot(), "agents", `${hash(id)}.access.json`);
async function recordedAccess(agentId: string) {
  const record = await readJson<{ agentId?: unknown; access?: unknown }>(agentAccessPath(agentId)).catch(() => ({ agentId: null }));
  if (record && (record.agentId !== agentId || !paseoAccessValues.includes(record.access as PaseoAccess)))
    throw new Error("Safehouse agent access record is unreadable or invalid. Repair the protected record before launch.");
  return record ? record.access as PaseoAccess : null;
}
// Only the creation open reads the label or metadata. The record is written once and never replaced.
async function agentAccess(request: PluginSessionOpenRequest & { metadata?: Record<string, unknown> }) {
  const stored = await recordedAccess(request.agentId);
  if (stored || request.reason !== "create") return stored ?? "workspace";
  const label = request.labels?.[paseoAccessKey], metadata = request.metadata?.[paseoAccessKey];
  if (label !== undefined && metadata !== undefined && label !== metadata)
    throw new Error(`${paseoAccessKey} differs between the label and the metadata. Give one value and create the agent again.`);
  const access = label ?? metadata ?? "workspace";
  if (!paseoAccessValues.includes(access as PaseoAccess))
    throw new Error(`${paseoAccessKey} must be workspace or daemon. Correct the value and create the agent again.`);
  const file = agentAccessPath(request.agentId), temp = `${file}.${randomUUID()}.tmp`;
  await atomicWrite(temp, JSON.stringify({ agentId: request.agentId, access }));
  try { await fs.link(temp, file); } finally { await fs.rm(temp, { force: true }); }
  return access as PaseoAccess;
}

// The launch-wrap route is chosen once, at create, and recorded for every later open of that agent.
const routeMetadataKey = "paseo-safehouse.route";
const routePath = (id: string) => path.join(stateRoot(), "agents", `${hash(id)}.route.json`);
async function wrapRoute(agentId: string) {
  const record = await readJson<{ agentId?: unknown; provider?: unknown; route?: unknown }>(routePath(agentId))
    .catch(() => ({ agentId: null }));
  if (record && (record.agentId !== agentId || record.route !== "wrap" || typeof record.provider !== "string"))
    throw new Error("Safehouse route record is unreadable or invalid. Repair the protected record before launch.");
  return record ? record.provider as string : null;
}
// Only the creation open with the route marker writes the record. It is written once and never replaced.
// On a later open the marker without a record refuses the open; it never selects the wrap.
async function recordWrapRoute(request: PluginSessionOpenRequest & { metadata?: Record<string, unknown> }) {
  const stored = await wrapRoute(request.agentId);
  if (stored !== null) {
    if (stored !== request.provider)
      throw new Error("Safehouse route record names another provider. Repair the protected record before launch.");
    return true;
  }
  if (request.metadata?.[routeMetadataKey] !== "wrap") return false;
  if (request.reason !== "create")
    throw new Error("Safehouse route record is missing; recreate the agent or repair Safehouse state.");
  const file = routePath(request.agentId), temp = `${file}.${randomUUID()}.tmp`;
  await atomicWrite(temp, JSON.stringify({ agentId: request.agentId, provider: request.provider, route: "wrap" }));
  try { await fs.link(temp, file); } finally { await fs.rm(temp, { force: true }); }
  return true;
}

const routingPath = (cwd: string) => path.join(stateRoot(), "workspaces", `${hash(cwd)}.json`);
async function routingChoice(cwd: string): Promise<boolean | null> {
  try {
    const record = JSON.parse(await fs.readFile(routingPath(cwd), "utf8"));
    if (!record || record.cwd !== cwd || typeof record.enabled !== "boolean") throw new Error("Invalid record");
    return record.enabled;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Safehouse routing state is unreadable or invalid. Choose automatic routing again.");
  }
}
export async function setWorkspaceRouting(paseo: Paseo, workspaceId: string, enabled: boolean) {
  const cwd = await workspaceCwd(paseo, workspaceId);
  await atomicJson(routingPath(cwd), { cwd, enabled });
  return { enabled };
}

const accessPath = (cwd: string) => path.join(stateRoot(), "workspaces", `${hash(cwd)}.daemon-access.json`);
async function daemonChoice(cwd: string) {
  let raw: string | null = null;
  try {
    const file = accessPath(cwd);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Invalid record");
    raw = await fs.readFile(file, "utf8");
    const record = JSON.parse(raw);
    if (record.cwd !== cwd || typeof record.enabled !== "boolean") throw new Error("Invalid record");
    return { enabled: record.enabled as boolean, revision: policyRevision(raw) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false, revision: policyRevision(null) };
    throw new Error("Safehouse daemon access state is unreadable or invalid. Repair the protected record before launch.");
  }
}
export async function setDaemonAccess(paseo: Paseo, workspaceId: string, enabled: boolean, revision: string) {
  const cwd = await workspaceCwd(paseo, workspaceId);
  return serializeSetup(accessPath(cwd), async () => {
    if ((await daemonChoice(cwd)).revision !== revision)
      throw new Error("Daemon access changed in another client. Your draft is retained; review the saved choice and retry.");
    await atomicJson(accessPath(cwd), { cwd, enabled });
    return daemonChoice(cwd);
  });
}

export async function workspaceCwd(paseo: Paseo, id: string) {
  const workspace = await paseo.workspaces.ref(id).refresh();
  if (!workspace?.workspaceDirectory)
    throw new Error("The workspace directory is unavailable.");
  return canonicalDirectory(workspace.workspaceDirectory);
}
async function daemonDetails(capturedHome = daemonHome()) {
  const home = await canonicalDirectory(capturedHome);
  const config = await readJson<{
    daemon?: { listen?: string };
    plugins?: Record<string, { path?: string }>;
  }>(path.join(home, "config.json"));
  const pid = await readJson<{ listen?: string }>(path.join(home, "paseo.pid"));
  const listen = pid?.listen ?? config?.daemon?.listen;
  if (!listen || !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(listen))
    throw new Error(
      "Safehouse currently requires a loopback TCP daemon.",
    );
  const source = config?.plugins?.[PLUGIN_ID]?.path;
  if (!source)
    throw new Error(
      "Install Safehouse from its local directory before setup.",
    );
  return {
    home,
    port: Number(listen.split(":").at(-1)),
    source: await fs.realpath(source),
  };
}
export function defaultDaemonPort(listen?: string) {
  return Number(listen?.split(":").at(-1)) || null;
}
async function daemonEndpoints(home: string, port: number) {
  const defaultHome = path.join(homedir(), ".paseo");
  let canonicalDefault = defaultHome;
  try { canonicalDefault = await fs.realpath(defaultHome); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const pid = await readJson<{ listen?: string }>(path.join(defaultHome, "paseo.pid"));
  const config = await readJson<{ daemon?: { listen?: string } }>(path.join(defaultHome, "config.json"));
  const listen = pid?.listen ?? config?.daemon?.listen;
  const defaultPort = defaultDaemonPort(listen);
  return { homes: [...new Set([home, defaultHome, canonicalDefault])], ports: [...new Set([port, ...(defaultPort ? [defaultPort] : [])])] };
}
export async function paseoAppBundle(runtime: { cli?: string; execPath?: string; resourcesPath?: string } = {
  cli: process.env.PASEO_CLI, execPath: process.execPath,
  resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
}) {
  const bundleFor = async (file: string) => {
    const executable = await findExecutable(file);
    if (!executable) return null;
    const canonical = await fs.realpath(executable);
    return canonical.match(/^(.*\.app)\/Contents\/Resources\/bin\/paseo$/)?.[1] ?? null;
  };
  // An explicit hint or PATH command selects the CLI, even when it is not bundled.
  if (runtime.cli?.trim()) return bundleFor(path.resolve(runtime.cli.trim()));
  const cli = await findExecutable("paseo");
  if (cli) return bundleFor(cli);
  const bundles = [
    runtime.resourcesPath?.match(/^(.*\.app)\/Contents\/Resources$/)?.[1],
    runtime.execPath?.match(/^(.*?\.app)\/Contents\//)?.[1],
  ];
  for (const bundle of bundles) {
    if (!bundle) continue;
    const resolved = await bundleFor(path.join(bundle,"Contents/Resources/bin/paseo"));
    if (resolved && resolved === await fs.realpath(bundle)) return resolved;
  }
  return null;
}
async function effectivePolicy(policy: ResolvedPolicy, enabled: boolean, saved: Installation) {
  const details = await daemonDetails(saved.home);
  const endpoints = await daemonEndpoints(details.home, details.port);
  const appBundle = enabled ? await paseoAppBundle() : null;
  return {
    policy: { ...policy, readWrite: enabled ? [...new Set([...policy.readWrite, details.home])] : policy.readWrite,
      readOnly: appBundle ? [...new Set([...policy.readOnly, appBundle])] : policy.readOnly,
      digest: hash(JSON.stringify({ policy: policy.digest, enabled, home: details.home, appBundle, ...endpoints })) },
    guard: enabled ? "" : guardProfile(endpoints.homes, [], endpoints.ports),
  };
}
export async function installation() {
  return readJson<Installation>(path.join(stateRoot(), "installation.json"));
}
async function executableAvailability(saved: Installation | null): Promise<
  z.infer<typeof availabilitySchema> & { binary: string | null }
> {
  if (process.platform !== "darwin") return {
    availability: "unsupported", availabilityError: "A macOS daemon host is required.", binary: null,
  };
  const binary = (saved && path.isAbsolute(saved.binary) ? await findExecutable(saved.binary) : null)
    ?? await findExecutable("safehouse");
  if (!binary) return { availability: "missing", binary: null,
    availabilityError: "Safehouse was not found on the daemon Mac. Install it and check the daemon's PATH.",
  };
  try {
    await capabilities(binary);
    return { availability: "available", availabilityError: null, binary };
  } catch (e) {
    return { availability: "unusable", binary,
      availabilityError: `Safehouse could not run on the daemon Mac: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
export async function availability() {
  const { binary: _binary, ...result } = await executableAvailability(await installation());
  return result;
}
// Reference handles are local: this feature check makes no agent read or write request.
export async function composerAvailability(paseo: Paseo) {
  let composerMetadataSupported = false;
  try {
    const handle = paseo.agents.ref("safehouse-capability-check") as unknown as { setMetadata?: unknown };
    composerMetadataSupported = typeof handle.setMetadata === "function";
  } catch { /* Older or unavailable host: keep the workspace header. */ }
  return { ...await availability(), composerMetadataSupported,
    ownedProviderIds: Object.keys((await installation())?.entries ?? {}) };
}
export async function setup(
  paseo: Paseo,
  options: { piCatalogExtensions?: string[] } = {},
) {
  macOnly();
  const home = await canonicalDirectory(daemonHome());
  const root = path.join(home, "safehouse");
  return serializeSetup(root, () => setupLocked(paseo, options, home, root));
}
async function setupLocked(
  paseo: Paseo, options: { piCatalogExtensions?: string[] }, home: string, root: string,
) {
  const details = await daemonDetails(home);
  const prior = await readJson<Installation>(path.join(root, "installation.json"));
  if (prior !== null) validateInstallation(prior);
  await finishPending(root, paseo, details);
  const stored = await readJson<Installation>(path.join(root, "installation.json"));
  const old = stored === null ? null : validateInstallation(stored);
  const binary = await findExecutable("safehouse");
  if (!binary)
    throw new Error("Install agent-safehouse on the daemon Mac before setup.");
  const caps = await capabilities(binary);
  const piCatalogExtensions: string[] = [];
  for (const extension of options.piCatalogExtensions ??
    old?.piCatalogExtensions ??
    []) {
    if (!path.isAbsolute(extension))
      throw new Error("Pi catalog extensions require absolute paths.");
    piCatalogExtensions.push(await fs.realpath(extension));
  }

  const current = (await paseo.config.get()).config.providers ?? {};
  // Providers that creation sends to the launch-wrap route, by the same rule as routeCreation.
  const wrapProviders = await launchWrapProviders(paseo);
  const wrappable = (id: string) => wrapProviders.has(id) && !derivedBase(id, current);
  const entries: Record<string, Variant> = { ...old?.entries };
  const sources: Record<string, Source> = { ...old?.sources };
  const unavailable: Record<string, string> = {};
  const bootstraps: { file: string; text: string }[] = [];
  const wrappers: { host: string; base: string; config: ProviderConfig; command: string[]; envPass: string[]; accountEnv: string[] }[] = [];
  const protectedPaths = [
    details.source,
    binary,
    await fs.realpath(binary),
    process.execPath,
    await fs.realpath(process.execPath),
  ];
  for (const host of new Set([...HOSTS, ...Object.keys(current), ...Object.values(old?.sources ?? {}).map(source => source.provider)])) {
    if (old?.entries[host] || host.startsWith("safehouse-") || /-safehouse(?:-direct)?$/.test(host)) continue;
    let resolved;
    try { resolved = await configuredProvider(host, current); }
    catch (e) {
      if (!wrappable(host)) unavailable[host] = e instanceof Error ? e.message : String(e);
      continue;
    }
    const { base, config, command, envPass, accountEnv } = resolved;
    const executable = command[0];
    const id = variant(host);
    if (current[id] && !isDeepStrictEqual(current[id], old?.entries[id]))
      throw new Error(
        `Provider ${id} belongs to another configuration. It was not changed.`,
      );
    protectedPaths.push(executable, await fs.realpath(executable));
    wrappers.push({ host, base, config, command, envPass, accountEnv });
    sources[id] = { provider: host, base, source: current[host] ?? null, baseSource: current[base] ?? null };
  }
  for (const [id, source] of Object.entries(sources)) {
    if (!unavailable[source.provider]) continue;
    if (current[id] === undefined) {
      delete entries[id];
      delete sources[id];
    } else {
      sources[id] = { ...source, source: current[source.provider] ?? null, baseSource: current[source.base] ?? null };
    }
  }
  if (!old && !wrappers.length && !Object.keys(entries).length && ![...wrapProviders].some(wrappable))
    throw new Error(
      "No configured harness can be wrapped. Check command arrays and executable availability.",
    );
  const endpoints = await daemonEndpoints(details.home, details.port);
  const guardText = guardProfile([root], protectedPaths, []);
  const guard = path.join(root, `guard-${hash(guardText).slice(0, 16)}.sb`);
  const catalogText = guardText + guardProfile(endpoints.homes, [], endpoints.ports);
  const catalogGuard = path.join(root, `catalog-${hash(catalogText).slice(0, 16)}.sb`);
  const wrapText = renderWrapLauncher({ root, binary, guard,
    features: [...new Set(Object.values(wrapGrants).flatMap(({ enable }) => enable?.length ? [enable.join(",")] : []))] });
  const wrapLauncher = path.join(root, "launchers", `wrap-${hash(wrapText).slice(0, 16)}.sh`);
  bootstraps.push({ file: wrapLauncher, text: wrapText });
  const wrapProfiles: Record<string, string> = {};
  const userHome = await canonicalDirectory(homedir());
  for (const [id, grants] of Object.entries(wrapGrants)) {
    const text = grantProfile(userHome, grants);
    wrapProfiles[id] = path.join(root, `provider-${hash(id).slice(0, 8)}-${hash(text).slice(0, 16)}.sb`);
    bootstraps.push({ file: wrapProfiles[id], text });
  }
  for (const { host, base, config, command, envPass, accountEnv } of wrappers) {
    const text = renderBootstrap({ root, binary, guard, catalogGuard, command, host: base, piCatalogExtensions, envPass, accountEnv });
    const file = path.join(root, "launchers", `${hash(host).slice(0, 16)}-${hash(text).slice(0, 16)}.sh`);
    bootstraps.push({ file, text });
    const retainedMasks = Object.fromEntries(Object.entries(old?.entries[variant(host)]?.env ?? {})
      .filter(([name, value]) => value === "" && blockedEnvironmentName(name)));
    entries[variant(host)] = { ...config, extends: base,
      label: `${host === "pi" ? "Pi" : host[0].toUpperCase() + host.slice(1)} · Safehouse`,
      command: ["/bin/sh", file], env: { ...retainedMasks, ...policyEnvironment(config.env ?? {}, path.join(root, "catalog")) },
      // Follow the source policy. Paseo treats an absent enabled as true; writing it lets refresh replace a stored false.
      paseoTools: { ...config.paseoTools, enabled: config.paseoTools?.enabled !== false } };
  }
  for (const id of Object.keys(entries))
    if (!isDeepStrictEqual(current[id] ?? null, old?.entries[id] ?? null))
      throw new Error(`Provider ${id} belongs to another configuration. It was not changed.`);
  await savePending(root, {
    installation: { binary, ...caps, ...details, entries, sources, unavailable, guard, catalogGuard, piCatalogExtensions, wrapLauncher, wrapProfiles },
    previous: Object.fromEntries(Object.keys(entries).map(id => [id, current[id] ?? null])),
    files: [{ file: guard, text: guardText }, { file: catalogGuard, text: catalogText }, ...bootstraps],
  });
  await finishPending(root, paseo, details);
  return { providers: Object.keys(entries) };
}
async function ready(paseo: Paseo, provider?: string) {
  macOnly();
  const saved = await installation();
  if (!saved)
    throw new Error(
      "SAFEHOUSE_SETUP_REQUIRED: Open Safehouse and configure providers first.",
    );
  const details = await daemonDetails();
  if (saved.home !== details.home || saved.port !== details.port)
    throw new Error(
      "The daemon endpoint changed. Configure Safehouse providers again.",
    );
  if (provider) {
    const current = (await paseo.config.get()).config.providers ?? {};
    const entry = current[provider];
    const source = saved.sources?.[provider];
    if (source && saved.unavailable?.[source.provider])
      throw launchError(source.provider, "source is unavailable; restore it and use Refresh providers in the Safehouse panel");
    if (source && (!isDeepStrictEqual(current[source.provider] ?? null, source.source) ||
        !isDeepStrictEqual(current[source.base] ?? null, source.baseSource)))
      throw launchError(source.provider, "configuration changed; use Refresh providers in the Safehouse panel");
    if (
      !saved.entries[provider] ||
      !isDeepStrictEqual(entry, saved.entries[provider])
    )
      throw new Error(
        "Safehouse provider configuration changed. Review host setup before launch.",
      );
  }
  return saved;
}
export async function preview(paseo: Paseo, cwd: string, raw: string) {
  const saved = await ready(paseo);
  const policy = await resolvePolicy(raw, cwd, saved.features);
  const snapshot = await prepareSnapshot(stateRoot(), policy);
  try {
    await run(
      saved.binary,
      [
        "--trust-workdir-config",
        "--append-profile",
        saved.guard,
        "--",
        "/usr/bin/true",
      ],
      {
        cwd,
        env: policyEnvironment(process.env, snapshot),
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      },
    );
  } finally {
    await fs.rm(snapshot, { recursive: true, force: true });
  }
  return policy;
}
export async function save(
  paseo: Paseo,
  cwd: string,
  raw: string,
  revision: string,
  digest: string,
) {
  const policy = await preview(paseo, cwd, raw);
  if (policy.digest !== digest)
    throw new Error(
      "Resolved access changed since review. Review the new paths and profiles.",
    );
  await savePolicy(cwd, policy, revision);
  return { digest: policy.digest };
}
type CreateRequest = PluginBeforeRequests["agent.create"] & { metadata?: Record<string, unknown>; requirePlugin?: unknown };
export async function routeCreation(request: CreateRequest, paseo: Paseo) {
  const cwd = await canonicalDirectory(request.config.cwd);
  const installed = await installation();
  const selected = installed?.entries[request.config.provider];
  const choice = launchChoice(request.metadata) ?? await routingChoice(cwd);
  // Only wrapCreation sets the route marker. Every other route drops a marker the caller supplied.
  const { [routeMetadataKey]: marker, ...metadata } = request.metadata ?? {};
  const unmarked = marker === undefined ? request : { ...request, metadata };
  if (!selected && choice === false) return unmarked;
  const recover = <T>(operation: Promise<T>) => operation.catch((error: unknown) => {
    if (error instanceof Error && error.name === "SafehouseLaunchError") throw error;
    throw launchError(request.config.provider, error instanceof Error ? error.message : String(error));
  });
  macOnly();
  const provider = selected ? request.config.provider : variant(request.config.provider);
  const host = installed?.sources?.[provider]?.base ?? (selected ? native(provider) : request.config.provider);
  if (!installed?.entries[provider] || !host) {
    const providers = (await paseo.config.get()).config.providers ?? {};
    // A provider that cannot be derived uses the launch wrap where its host reports support.
    if (!selected && !derivedBase(request.config.provider, providers)) {
      if (!(await launchWrapSupported(paseo, request.config.provider, cwd))) throw unsupportedError(request.config.provider);
      return wrapCreation(request, paseo, cwd, recover);
    }
    await recover(configuredProvider(request.config.provider, providers));
    throw launchError(request.config.provider, "Refresh providers in the Safehouse panel to wrap this provider");
  }
  const saved = await recover(ready(paseo, provider));
  await recover(loadPolicy(cwd, saved.features));
  await recover(daemonChoice(cwd));
  let model = request.config.model;
  if (!model) {
    const original = installed.sources?.[provider]?.provider ?? host;
    const catalog = await recover(paseo.providers.listModels(original, { cwd }));
    const models = catalog.models ?? [];
    model = (models.find((m) => m.isDefault) ?? models[0])?.id;
    if (!model && host !== "acp")
      throw launchError(request.config.provider,
        `No model is available for ${request.config.provider}; select or configure a model before launching`,
      );
  }
  return {
    ...unmarked,
    config: {
      ...request.config,
      provider,
      model,
      // Safehouse supplies the sandbox; Codex cannot nest macOS Seatbelt.
      ...(host === "codex"
        ? {
            modeId: "full-access",
            providerOptions: {
              ...request.config.providerOptions,
              sandbox_mode: "danger-full-access",
              approval_policy: "never",
            },
          }
        : host === "claude" ? { modeId: "bypassPermissions" } : {}),
    },
  };
}
/**
 * Host support for the plugin requirement. Keep this the only place that reads the signal.
 *
 * ASSUMPTION: the Paseo task plugin-required-active is not final. It plans `requirePlugin: true` in the
 * agent.create.before result, and a strict create schema without it fails creation on that key. This
 * plugin assumes that a supporting host includes `requirePlugin` as a boolean in every create request.
 * If Paseo chooses another signal, change only this function. With no signal, it returns false and the
 * create result never carries `requirePlugin`.
 */
function hostOffersPluginRequirement(request: CreateRequest) {
  return typeof request.requirePlugin === "boolean";
}
async function wrapCreation(request: CreateRequest, paseo: Paseo, cwd: string, recover: <T>(operation: Promise<T>) => Promise<T>) {
  const saved = await recover(ready(paseo));
  if (!saved.wrapLauncher) throw launchError(request.config.provider, "Refresh providers in the Safehouse panel to wrap this provider");
  await recover(loadPolicy(cwd, saved.features));
  await recover(daemonChoice(cwd));
  return {
    ...request,
    metadata: { ...request.metadata, [routeMetadataKey]: "wrap" },
    // Where offered, Paseo refuses every later open while Safehouse is inactive, so a lost plugin cannot
    // reopen the agent unwrapped. Without it, that open starts the harness unsandboxed (CL's ruling, 2026-11-21).
    ...(hostOffersPluginRequirement(request) ? { requirePlugin: true } : {}),
  };
}
async function prepareWrappedOpening(request: PluginSessionOpenRequest, paseo: Paseo) {
  const saved = await ready(paseo);
  if (!saved.wrapLauncher) throw launchError(request.provider, "Refresh providers in the Safehouse panel to wrap this provider");
  const env = await prepareSession(request, saved);
  const names = [...new Set([...providerEnvironmentNames(Object.keys(request.env ?? {})), "PASEO_HOME"])].join(",");
  const wrap = ["/bin/sh", saved.wrapLauncher, names, saved.wrapProfiles?.[request.provider] ?? "",
    (wrapGrants[request.provider]?.enable ?? []).join(",")];
  return { ...request, env, wrap };
}
export async function prepareOpening(
  request: PluginSessionOpenRequest,
  paseo: Paseo,
) {
  if (!(await installation())?.entries[request.provider])
    return await recordWrapRoute(request) ? prepareWrappedOpening(request, paseo) : request;
  const saved = await ready(paseo, request.provider);
  return { ...request, env: await prepareSession(request, saved) };
}
// Shared by both routes: policy, daemon access choice, per-agent access, snapshot and receipt.
async function prepareSession(request: PluginSessionOpenRequest, saved: Installation) {
  const cwd = await canonicalDirectory(request.cwd);
  const access = await agentAccess(request);
  const enabled = (await daemonChoice(cwd)).enabled || access === "daemon";
  if (enabled && !saved.catalogGuard) throw new Error("Refresh providers before enabling daemon access for a launch.");
  const effective = await effectivePolicy(await loadPolicy(cwd, saved.features), enabled, saved);
  const policy = effective.policy;
  const snapshot = await prepareSnapshot(stateRoot(), policy, effective.guard);
  await atomicJson(receiptPath(request.agentId), {
    agentId: request.agentId,
    cwd,
    provider: request.provider,
    digest: policy.digest,
    snapshot,
    preparedAt: new Date().toISOString(),
    reason: request.reason,
    daemonAccess: enabled,
    paseoAccess: access,
  } satisfies Receipt);
  return policyEnvironment(request.env, snapshot, saved.home);
}
export async function status(paseo: Paseo, workspaceId: string) {
  const cwd = await workspaceCwd(paseo, workspaceId);
  const saved = await installation();
  let error: string | null = null,
    raw: string | null = null,
    policy: ResolvedPolicy | null = null,
    daemonPolicy: ResolvedPolicy | null = null;
  let access = { enabled: false, revision: "" };
  try { access = await daemonChoice(cwd); } catch (e) { error = String(e); }
  let policySource: "defaults" | "file" | null = null;
  let routing: boolean | null = null, routingError: string | null = null;
  try { routing = await routingChoice(cwd); } catch (e) { routingError = String(e); }
  try {
    raw = await readSource(cwd);
    policySource = raw === null ? "defaults" : "file";
    if (saved) {
      const resolved = await resolvePolicy(raw ?? "", cwd, saved.features);
      policy = (await effectivePolicy(resolved, access.enabled, saved)).policy;
      daemonPolicy = access.enabled ? policy : (await effectivePolicy(resolved, true, saved)).policy;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const policyValid = !!policy;
  const executable = await executableAvailability(saved);
  let configured = !!saved;
  if (saved) {
    const providers = (await paseo.config.get()).config.providers ?? {};
    configured = Object.entries(saved.entries).every(([id, entry]) => {
      const source = saved.sources?.[id];
      if (source && saved.unavailable?.[source.provider]) return true;
      return isDeepStrictEqual(providers[id], entry) && (!source || (
        isDeepStrictEqual(providers[source.provider] ?? null, source.source) &&
        isDeepStrictEqual(providers[source.base] ?? null, source.baseSource)));
    });
  }
  configured = configured && executable.availability === "available" && executable.binary === saved?.binary;
  const supported = process.platform === "darwin";
  const state: "unsupported" | "unavailable" | "setup" | "absent" | "invalid" | "ready" | "off" =
    !supported
      ? "unsupported"
      : executable.availability !== "available"
        ? "unavailable"
        : routingError
        ? "invalid"
        : routing === false
          ? "off"
          : error
            ? "invalid"
            : !configured
              ? "setup"
              : "ready";
  const { entries } = await paseo.agents.list();
  // Agents on the launch-wrap route keep their own provider ID. A corrupt record still lists the agent.
  const wrapped = new Set<string>();
  for (const { agent } of entries)
    if (agent.workspaceId === workspaceId && !saved?.entries[agent.provider] &&
        await wrapRoute(agent.id).catch(() => agent.provider) === agent.provider) wrapped.add(agent.id);
  const agents = await Promise.all(
    entries
      .filter(
        ({ agent }) =>
          agent.workspaceId === workspaceId && (saved?.entries[agent.provider] || wrapped.has(agent.id)),
      )
      .map(async ({ agent }) => {
        // Status refresh reconciles UI locators; lifecycle hooks never await metadata writes.
        try {
          const reference = { agentId: agent.id, workspaceId: agent.workspaceId };
          const metadata = (agent as typeof agent & { metadata?: Record<string, unknown> }).metadata;
          if (!isDeepStrictEqual(metadata?.[sessionMetadataKey], reference)) {
            const handle = paseo.agents.ref(agent.id) as unknown as { setMetadata?: (patch: Record<string, unknown>) => Promise<unknown> };
            await handle.setMetadata?.({ [sessionMetadataKey]: reference });
          }
        } catch { /* Publication is best-effort; receipts remain authoritative. */ }
        const receipt = await readJson<Receipt>(receiptPath(agent.id));
        const paseoAccess = await recordedAccess(agent.id).then(stored => stored ?? "workspace", () => null);
        const enabled = access.enabled || paseoAccess === "daemon", expected = enabled ? daemonPolicy : policy;
        return {
          id: agent.id,
          title: agent.title || agent.id,
          provider: agent.provider,
          digest: receipt?.digest ?? null,
          daemonAccess: receipt?.daemonAccess ?? null,
          paseoAccess,
          changed: !receipt || !paseoAccess || (!!expected && (receipt.digest !== expected.digest || receipt.daemonAccess !== enabled)),
          preparedAt: receipt?.preparedAt ?? null,
        };
      }),
  );
  return {
    cwd,
    platform: process.platform,
    availability: executable.availability,
    availabilityError: executable.availabilityError,
    state,
    configured,
    routingEnabled: routing ?? true,
    daemonAccess: access.enabled,
    daemonAccessRevision: access.revision,
    daemonHome: saved?.home ?? daemonHome(),
    policySource,
    raw,
    revision: policyRevision(raw),
    digest: policy?.digest ?? null,
    policyValid,
    error: routingError ?? error,
    unavailable: saved?.unavailable ?? {},
    features: saved?.features ?? [],
    agents,
  };
}
export async function reload(
  paseo: Paseo,
  workspaceId: string,
  agentId: string,
) {
  const agent = paseo.agents.ref(agentId);
  await agent.refresh();
  const provider = agent.current()?.provider ?? "";
  const derived = !!(await installation())?.entries[provider];
  if (agent.workspaceId !== workspaceId || !(derived || await wrapRoute(agentId) === provider))
    throw new Error("Select a Safehouse agent in this workspace.");
  const saved = await ready(paseo, derived ? provider : undefined);
  const cwd = await workspaceCwd(paseo, workspaceId);
  await loadPolicy(cwd, saved.features);
  await daemonChoice(cwd);
  const current = agent as typeof agent & { reload(): Promise<unknown> };
  if (typeof current.reload !== "function")
    throw new Error("Agent reload requires Paseo 0.15.2.");
  await current.reload();
  return { agentId };
}
