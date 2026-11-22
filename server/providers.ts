import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { findExecutable, providerEnvironmentNames } from "./policy";

type Paseo = PluginHandlerContext["paseo"];
export type Providers = NonNullable<Awaited<ReturnType<Paseo["config"]["get"]>>["config"]["providers"]>;
export type ProviderConfig = Providers[string] & {
  extends?: string; command?: string[]; env?: Record<string, string>;
  paseoTools?: { enabled?: boolean; disabledTools?: string[] };
};
// Paseo 0.15.3 exposes no factory capability query. Only these built-in
// factories preserve adapter behavior when extended under another id.
const factories = ["pi", "claude", "codex", "copilot", "cursor", "opencode", "omp"];
const specialAcp = ["cursor", "kimi", "kiro", "traecli", "hub-e2e"];
// Account switchers set these names at session open. The launcher validates and grants them.
const accountEnvironment: Record<string, string[]> = {
  claude: ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"],
  codex: ["CODEX_HOME", "CODEX_SQLITE_HOME"],
};
export const launchError = (id: string, reason: string) => Object.assign(new Error(
  `Safehouse provider ${id}: ${reason}. Repair the reported problem and retry. When a workspace header is available, Disable automatic Safehouse there permits a separate ordinary launch.`,
), { name: "SafehouseLaunchError" });
export const unsupportedError = (id: string) => Object.assign(new Error(
  `${id} is not supported by Safehouse yet; disable automatic Safehouse to run it unsandboxed.`,
), { name: "SafehouseLaunchError" });
/** The base factory a safehouse-<id> entry can extend, or null when the public configuration cannot derive one. */
export function derivedBase(id: string, providers: Providers) {
  const config = (providers[id] ?? {}) as ProviderConfig;
  const base = factories.includes(id) ? id : config.extends;
  if (!base || (!factories.includes(base) && base !== "acp") ||
      (base === "acp" && specialAcp.includes(id)) ||
      (base !== id && base !== "acp" && providers[base]?.extends)) return null;
  return base;
}
/**
 * What a provider on the launch-wrap route needs for its own sign-in and configuration.
 * Folders are relative to the user home. `enable` lists Safehouse optional features.
 * A provider without an entry gets only the workspace policy.
 */
export const wrapGrants: Record<string, { readWrite?: string[]; readOnly?: string[]; enable?: string[] }> = {
  // agy keeps state, logs and conversations in ANTIGRAVITY_HOME (default ~/.gemini/antigravity-cli),
  // reads config.json and mcp_config.json from ~/.gemini/config, and loads its sign-in token from the
  // macOS keychain. Safehouse has no agy profile, so the keychain integration is enabled here.
  antigravity: { readWrite: [".gemini/antigravity-cli"], readOnly: [".gemini/config"], enable: ["keychain"] },
};
/**
 * Host support for the launch-wrap hook, read from the static provider snapshot entry.
 * A host without the hook has no `launchWrap` field or no snapshot call. A failed read counts as no support.
 */
export async function launchWrapProviders(paseo: Paseo, cwd?: string) {
  const providers = paseo.providers as unknown as {
    snapshot?: (options?: { cwd?: string }) => Promise<{ entries?: { provider?: unknown; launchWrap?: unknown }[] }>;
  } | undefined;
  if (typeof providers?.snapshot !== "function") return new Set<string>();
  try {
    const { entries } = await providers.snapshot(cwd ? { cwd } : undefined);
    return new Set(Array.isArray(entries) ? entries.flatMap((entry) =>
      typeof entry?.provider === "string" && entry.launchWrap === true ? [entry.provider] : []) : []);
  } catch { return new Set<string>(); }
}
export async function launchWrapSupported(paseo: Paseo, id: string, cwd: string) {
  return (await launchWrapProviders(paseo, cwd)).has(id);
}
export async function configuredProvider(id: string, providers: Providers) {
  const config = (providers[id] ?? {}) as ProviderConfig;
  const base = derivedBase(id, providers);
  if (!base) throw unsupportedError(id);
  const command = config.command ?? (base !== id ? providers[base]?.command : undefined) ??
    (["pi", "claude", "codex"].includes(base) ? [base] : undefined);
  if (!Array.isArray(command) || !command.length || command.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !command[0])
    throw launchError(id, "a nonempty explicit command array is required");
  const executable = await findExecutable(command[0]);
  if (!executable) throw launchError(id, `executable ${command[0]} is unavailable`);
  // Retain source overrides and native base inheritance. Copying merged tool
  // restrictions here would apply the base's restrictions twice in the registry.
  const envPass = providerEnvironmentNames([...Object.keys(providers[base]?.env ?? {}), ...Object.keys(config.env ?? {})]);
  const accountEnv = providerEnvironmentNames(accountEnvironment[base] ?? []);
  return { base, config, envPass, accountEnv, command: [executable, ...command.slice(1)] };
}
