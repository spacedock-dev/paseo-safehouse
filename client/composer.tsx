import { useEffect, useLayoutEffect, useState, type ComponentType } from "react";
import { Pressable, Text, View } from "react-native";
import * as sdk from "@getpaseo/plugin/client";
import * as ui from "@getpaseo/plugin/client/ui";
import {
  availabilityRpc, draftPlan, installationUrl, launchMetadataKey, launchUnavailableKey, sessionMetadataKey, sessionLabel, statusRpc,
} from "../shared/contracts";

type Choice = "on" | "off";
export type Composer = {
  context: "agent" | "draft" | "new-workspace";
  agent: { provider: string | null; metadata: Readonly<Record<string, unknown>> };
  setMetadata(patch: Record<string, boolean | string | null>): Promise<void>;
};
type SelectProps = {
  title: string; icon: "Lock"; value: Choice; disabled?: boolean;
  options: readonly { value: Choice; label: string; description?: string }[];
  onValueChange(event: { value: Choice }): Promise<void>;
};
type ActionProps = { title: string; icon: "Lock"; onPress(event: object): void };
// Optional public 0.16 exports; namespace imports also compile and load on 0.15.
export const composerSdk = sdk as typeof sdk & { useComposer?: () => Composer };
export const composerUi = ui as typeof ui & { Select?: ComponentType<SelectProps>; Action?: ComponentType<ActionProps> };
export function supportsComposer(client: { addComposerItem?: unknown }, metadataSupported: boolean) {
  return metadataSupported && typeof client.addComposerItem === "function" &&
    typeof composerSdk.useComposer === "function" && typeof composerUi.Select === "function";
}
export function draftChoice(composer: Composer, owned: readonly string[]): Choice | undefined {
  if (owned.includes(composer.agent.provider ?? "")) return "on";
  const value = composer.agent.metadata[launchMetadataKey];
  return value === true ? "on" : value === false ? "off" : undefined;
}
export function setDraftChoice(composer: Composer, owned: readonly string[], value: Choice) {
  if (composer.context === "agent" || owned.includes(composer.agent.provider ?? ""))
    return Promise.reject(new Error("This agent's Safehouse provider is fixed."));
  return composer.setMetadata({ [launchMetadataKey]: value === "on" });
}
export function SafehouseComposer({ theme, onReady, openDetails }: {
  theme: { colors: { foregroundMuted: string } };
  onReady: (agentId: string) => () => void; openDetails: (workspaceId: string) => void;
}) {
  const composer = composerSdk.useComposer!();
  const Select = composerUi.Select!;
  const readAvailability = sdk.useRpc(availabilityRpc);
  const readStatus = sdk.useRpc(statusRpc);
  const reference = composer.agent.metadata[sessionMetadataKey] as { agentId?: unknown; workspaceId?: unknown } | null;
  const agentId = typeof reference?.agentId === "string" ? reference.agentId : "";
  const workspaceId = typeof reference?.workspaceId === "string" ? reference.workspaceId : "";
  const target = JSON.stringify([composer.context, agentId, workspaceId, composer.agent.provider]);
  const [session, setSession] = useState<{ target: string; label: string } | null>(null);
  const readyId = composer.context === "agent" && session?.target === target ? agentId : "";

  type Availability = Awaited<ReturnType<typeof readAvailability>>;
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [error, setError] = useState("");
  const [initializationError, setInitializationError] = useState("");
  const [retry, setRetry] = useState(0);
  const [planTried, setPlanTried] = useState("");
  const [planFailure, setPlanFailure] = useState<{ signature: string; message: string } | null>(null);
  const launchValue = composer.agent.metadata[launchMetadataKey];
  const provider = composer.agent.provider ?? "";
  const owned = availability?.ownedProviderIds ?? [];
  const unavailableReasons = availability?.unavailable ?? {};
  const reason = composer.context !== "agent" && Object.hasOwn(unavailableReasons, provider) ? unavailableReasons[provider] : undefined;
  const plan = composer.context === "agent" || !availability ? null
    : draftPlan({ provider: composer.agent.provider, metadata: composer.agent.metadata, owned, unavailable: unavailableReasons });
  // One attempt per plan: a rejected write is not retried until the provider, launch value or reason changes.
  const planSignature = plan ? JSON.stringify([composer.context, provider, launchValue, composer.agent.metadata[launchUnavailableKey] ?? null, reason ?? null]) : "";
  useLayoutEffect(() => {
    if (composer.context === "agent" || typeof launchValue === "boolean") return;
    if (Object.hasOwn(composer.agent.metadata, launchMetadataKey)) {
      setInitializationError("Invalid Safehouse choice."); return;
    }
    let active = true;
    setInitializationError("");
    void composer.setMetadata({ [launchMetadataKey]: true }).catch((e) => {
      if (active) setInitializationError(e instanceof Error ? e.message : String(e));
    });
    return () => { active = false; };
    // A new snapshot or retry starts a new attempt; availability polling does not.
  }, [composer.context, launchValue, retry]);
  async function refresh() {
    try { setAvailability(await readAvailability({})); setError(""); }
    catch (e) { setAvailability(null); setError(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        if (composer.context === "agent") {
          const status = agentId && workspaceId ? await readStatus({ workspaceId }) : null;
          const agent = status?.agents.find(a => a.id === agentId && a.provider === composer.agent.provider);
          if (active) setSession(agent && status ? { target, label: sessionLabel(agent, status.policyValid) } : null);
        } else { const next = await readAvailability({}); if (active) { setAvailability(next); setError(""); } }
      } catch (e) { if (active) { setSession(null); setAvailability(null); setError(String(e)); } }
    };
    void poll(); const timer = setInterval(() => void poll(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [readAvailability, readStatus, target]);
  useEffect(() => readyId ? onReady(readyId) : undefined, [readyId, onReady]);
  useEffect(() => {
    if (!plan || planTried === planSignature) return;
    setPlanTried(planSignature);
    let active = true;
    composer.setMetadata(plan).catch((e) => {
      if (active) setPlanFailure({ signature: planSignature, message: e instanceof Error ? e.message : String(e) });
    });
    return () => { active = false; };
  }, [planSignature]);
  if (composer.context === "agent") {
    if (!readyId) return null;
    const title = `${session!.label}. Open Safehouse details`;
    const Action = composerUi.Action;
    if (Action) return <Action title={title} icon="Lock" onPress={() => openDetails(workspaceId)} />;
    return <Pressable accessibilityRole="button" accessibilityLabel={title}
      onPress={() => openDetails(workspaceId)} style={{ padding: 6 }}>
      <ui.Icon name="Lock" size={16} color={theme.colors.foregroundMuted} />
    </Pressable>;
  }
  const fixed = owned.includes(provider);
  // With a reason, only an Off that is already written is shown; On cannot be chosen.
  const choice = typeof launchValue === "boolean" && !(reason && launchValue) ? draftChoice(composer, owned) : undefined;
  const failure = initializationError || (planSignature && planFailure?.signature === planSignature ? planFailure.message : "");
  const reasonTitle = reason ? `Safehouse unavailable for ${provider} · ${reason}` : "";
  const unavailable = availability && availability.availability !== "available";
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  // A fragment, not a wrapper view: the host lays out each node, so the toolbar item stays as narrow as the
  // control and a sheet row gets the full width, where a long title truncates and the value stays visible.
  return <>
    {choice ? <Select title={reasonTitle || (fixed ? "Safehouse On · explicit provider" : "Safehouse")} icon="Lock"
      value={choice} disabled={!availability || fixed || !!reason}
      options={[
        { value: "on", label: "On", description: reason ? `Unavailable: ${reason}` : "Run this new agent inside Safehouse." },
        { value: "off", label: "Off", description: `Run this new agent without Safehouse.${reasonTitle ? ` ${reasonTitle}.` : ""}` },
      ]} onValueChange={({ value }) => setDraftChoice(composer, owned, value)} /> :
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={muted}>{failure ? `Safehouse choice failed: ${failure}` : "Safehouse checking"}</Text>
        {initializationError ? <Pressable accessibilityRole="button" onPress={() => setRetry(retry + 1)}>
          <Text style={muted}>Retry Safehouse choice</Text>
        </Pressable> : null}
      </View>}
    {unavailable || error ? <>
      <Pressable accessibilityRole="link" onPress={() => sdk.openExternalUrl(installationUrl)}>
        <Text style={muted}>{error ? "Safehouse check failed" : "Safehouse unavailable"} · Install on daemon Mac</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => void refresh()}><Text style={muted}>Check again</Text></Pressable>
    </> : null}
  </>;
}
