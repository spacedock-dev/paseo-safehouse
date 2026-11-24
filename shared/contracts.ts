import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const workspace = z.object({ workspaceId: z.string().min(1) });
export const availabilitySchema = z.object({
  availability: z.enum(["available", "missing", "unusable", "unsupported"]),
  availabilityError: z.string().nullable(),
});
export const availabilityRpc = defineRpc({
  name: "safehouse.availability",
  input: z.object({}),
  output: availabilitySchema.extend({
    composerMetadataSupported: z.boolean(),
    ownedProviderIds: z.array(z.string()),
    // Providers that creation of an On draft refuses, with the reason.
    unavailable: z.record(z.string(), z.string()),
  }),
});
// Only the creation open reads this label or metadata key; a per-agent record decides later opens.
export const paseoAccessKey = "paseo-safehouse.paseo-access";
export const paseoAccessValues = ["workspace", "daemon"] as const;

export const installationUrl = "https://github.com/eugene1g/agent-safehouse#install";
export const statusRpc = defineRpc({
  name: "safehouse.status",
  input: workspace,
  output: z.object({
    ...availabilitySchema.shape,
    cwd: z.string(),
    platform: z.string(),
    state: z.enum(["unsupported", "unavailable", "setup", "absent", "invalid", "ready", "off"]),
    configured: z.boolean(),
    routingEnabled: z.boolean(),
    daemonAccess: z.boolean(),
    daemonAccessRevision: z.string(),
    daemonHome: z.string(),
    raw: z.string().nullable(),
    policySource: z.enum(["defaults", "file"]).nullable(),
    revision: z.string(),
    digest: z.string().nullable(),
    policyValid: z.boolean(),
    error: z.string().nullable(),
    unavailable: z.record(z.string(), z.string()),
    // The per-daemon experimental wrap setting; null when its file is invalid.
    experimentalWrap: z.boolean().nullable(),
    // Whether any provider on this host has Paseo's per-session launch wrapper; the setting has no effect without one.
    launchWrapHost: z.boolean(),
    features: z.array(z.string()),
    agents: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        provider: z.string(),
        digest: z.string().nullable(),
        changed: z.boolean(),
        daemonAccess: z.boolean().nullable(),
        paseoAccess: z.enum(paseoAccessValues).nullable(),
        preparedAt: z.string().nullable(),
      }),
    ),
  }),
});
export const routingRpc = defineRpc({
  name: "safehouse.set-workspace-routing",
  input: workspace.extend({ enabled: z.boolean() }),
  output: z.object({ enabled: z.boolean() }),
});
export const experimentalWrapRpc = defineRpc({
  name: "safehouse.set-experimental-wrap",
  input: z.object({ enabled: z.boolean() }),
  output: z.object({ enabled: z.boolean() }),
});
export const daemonAccessRpc = defineRpc({
  name: "safehouse.set-daemon-access",
  input: workspace.extend({ enabled: z.boolean(), revision: z.string() }),
  output: z.object({ enabled: z.boolean(), revision: z.string() }),
});
export const setupRpc = defineRpc({
  name: "safehouse.setup",
  input: z.object({
    piCatalogExtensions: z.array(z.string().min(1)).optional(),
  }),
  output: z.object({ providers: z.array(z.string()) }),
});
export const previewRpc = defineRpc({
  name: "safehouse.preview",
  input: workspace.extend({ raw: z.string().max(1048576) }),
  output: z.object({
    digest: z.string(),
    readOnly: z.array(z.string()),
    readWrite: z.array(z.string()),
    enable: z.array(z.string()),
    profiles: z.array(z.object({ path: z.string(), content: z.string() })),
  }),
});
export const saveRpc = defineRpc({
  name: "safehouse.save",
  input: workspace.extend({
    raw: z.string().max(1048576),
    revision: z.string(),
    digest: z.string(),
  }),
  output: z.object({ digest: z.string() }),
});
export const reloadRpc = defineRpc({
  name: "safehouse.reload",
  input: workspace.extend({ agentId: z.string() }),
  output: z.object({ agentId: z.string() }),
});
export const headerLabel = (state: string) =>
  ({
    ready: "Safehouse On",
    invalid: "Safehouse error",
    absent: "Safehouse Off",
    off: "Safehouse Off",
    unsupported: "Safehouse unavailable",
    unavailable: "Safehouse unavailable",
    setup: "Safehouse setup",
  })[state] ?? "Safehouse checking";

// Only initial creation reads this key. Existing sessions retain their provider.
export const launchMetadataKey = "paseo-safehouse.launch";
export function launchChoice(metadata?: Record<string, unknown>): boolean | undefined {
  if (!metadata || !Object.hasOwn(metadata, launchMetadataKey)) return undefined;
  const value = metadata[launchMetadataKey];
  if (typeof value !== "boolean")
    throw new Error("paseo-safehouse.launch must be a boolean. Choose On or Off and retry.");
  return value;
}

// Marks an Off that Safehouse wrote because the draft's provider is unavailable, so that Off can be undone.
// The server ignores it; a user's own Off never carries it.
export const launchUnavailableKey = "paseo-safehouse.launch-unavailable";
/** The metadata patch that keeps a draft's choice consistent with the provider reasons, or null for none. */
export function draftPlan({ provider, metadata, owned, unavailable }: {
  provider: string | null; metadata: Readonly<Record<string, unknown>>; owned: readonly string[]; unavailable: Record<string, string>;
}): Record<string, boolean | string | null> | null {
  const id = provider ?? "", launch = metadata[launchMetadataKey], marked = Object.hasOwn(metadata, launchUnavailableKey);
  if (owned.includes(id) || typeof launch !== "boolean") return null;
  if (id && Object.hasOwn(unavailable, id)) {
    if (launch) return { [launchMetadataKey]: false, [launchUnavailableKey]: id };
    return marked && metadata[launchUnavailableKey] !== id ? { [launchUnavailableKey]: id } : null;
  }
  if (!marked) return null;
  return launch ? { [launchUnavailableKey]: null } : { [launchMetadataKey]: true, [launchUnavailableKey]: null };
}

// A mutable UI locator, never launch authority or evidence of sandbox entry.
export const sessionMetadataKey = "paseo-safehouse.session";
export function sessionLabel(agent: { preparedAt: string | null; changed: boolean }, policyValid: boolean) {
  return agent.preparedAt
    ? !policyValid ? "Safehouse · policy prepared; current policy unavailable"
      : agent.changed ? "Safehouse · policy changed" : "Safehouse · policy prepared"
    : "Safehouse · no launch record";
}
