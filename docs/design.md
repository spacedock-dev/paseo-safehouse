# Design

Safehouse for Paseo applies workspace policies to new agent processes on macOS.
This document specifies the intended behavior. The [validation plan](validation.md) defines the release gates.

## Workspace policy

New agents use Safehouse unless their draft choice, or inherited workspace choice, disables automatic routing.
Creation uses the request directory before any workspace ID or header exists.
An absent `.safehouse` selects default access without creating a file or routing record.
The file authorizes its declared access by default. Launch does not require a separate approval record.
The policy file and its custom profiles are trusted inputs for each new process.
Invalid directives, unavailable paths, and unsupported capabilities fail rather than fall back to an ordinary launch.

The panel offers **Review access** to inspect or edit directory grants, capabilities, and custom profiles.
**Refresh providers** remains available after setup. The panel lists unavailable providers and their reasons.
**Save policy** writes the source file after preview and a check for concurrent edits.
Existing policy bytes remain unchanged unless the user edits them.
Default access includes the writable workspace and Safehouse’s built-in system, toolchain, network, temporary-directory, and harness access.
No additional directories, optional capabilities, or custom profiles apply. Fixed plugin protections remain active.
The panel can create a policy; optional capabilities start unselected.

The policy fingerprint includes the canonical workspace, source bytes, resolved grants, and custom profile contents.
It identifies launch snapshots and policy changes. Defaults and an empty file have the same effective fingerprint.
A separate edit revision distinguishes absence from an empty file. Each reviewed candidate retains its captured revision.
Concurrent source changes invalidate the review and preserve the draft until the user reviews access again.
Safehouse supplies baseline system, toolchain, network, and harness access. The panel distinguishes this baseline from additional grants.

New processes use the current policy. Running processes keep their captured snapshots.
If `.safehouse` disappears, subsequent launches and reloads use defaults.
Invalid, unreadable, oversized, non-regular, and symlinked sources block Safehouse launches.
Their stored providers do not change to ordinary providers automatically.

## User interface

Paseo 0.16 supplies a per-draft Safehouse Select in workspace and New workspace composers.
The lock control offers **On** and **Off**, which set a boolean `paseo-safehouse.launch` agent metadata key.
A layout effect initializes missing draft metadata to true, including New workspace drafts. It preserves existing true and false values.
The control shows a choice only after its current composer snapshot contains a boolean.
Pending initialization shows neutral feedback. A rejected initialization shows an error and an explicit retry action.
Callers without metadata use the saved workspace choice at creation, or On when no choice is saved.
Only absent or boolean metadata is accepted; malformed present values, including raw null, reject creation.
The SDK removes the key when `setMetadata` receives null; it does not send that null as a choice.
An explicit boolean skips the inherited routing record, including a malformed record. Absent metadata requires a valid saved record.
Explicit owned Safehouse providers always remain On, and existing agents retain their stored provider on reload regardless of mutable metadata.
Each draft owns its metadata. Paseo resets the consumed draft after successful submission and retains it on retry.

The client registers the composer only when `addComposerItem`, `useComposer`, `Select`, and the daemon's metadata capability are present.
Namespace imports preserve compatibility with older SDK exports. The minimum Paseo version remains 0.15.
The existing 5-second refresh retries capability discovery; an RPC failure keeps the fallback header until discovery succeeds.
Missing or unusable executable results still carry the metadata capability and owned provider IDs.
Compatibility and metadata transport are verified on Paseo 0.15.3 and 0.16.0-beta.2, not on other runtime versions.
A capable client and daemon show no workspace header. The Safehouse panel displays and edits the workspace default on both versions.
Older and mixed hosts retain this header:

| Workspace state                     | Header                | Action                       |
| ----------------------------------- | --------------------- | ---------------------------- |
| No policy, ready providers          | Safehouse On          | Inspect defaults or add access |
| Saved Off choice                    | Safehouse Off         | Enable automatic Safehouse   |
| Valid policy and ready providers    | Safehouse On          | Inspect or edit access       |
| Invalid policy or unreadable inputs | Safehouse error       | Show the specific error      |
| Provider setup required             | Safehouse setup       | Configure providers          |
| Non-macOS host                      | Safehouse unavailable | Explain the host requirement |

The header describes automatic routing. Its menu changes the workspace choice or opens the policy panel. The panel shows error details.
The user selects ordinary providers and models in Paseo’s existing picker.
Paseo also exposes the configured Safehouse variants in that picker.

Each agent’s status describes its own launch policy, not the current workspace policy.
Policy preparation alone does not prove that a process entered the sandbox.
The initial implementation reports a prepared policy until runtime evidence supports a stronger status.

On Paseo 0.16, an existing Safehouse agent shows one Lock action inside its composer.
Its accessible label distinguishes prepared, changed, missing launch records, and unavailable current policy.
The action opens the agent's workspace panel through an explicit workspace ID, regardless of focus.
Older hosts retain the pill above the composer.

Each workspace status refresh publishes `paseo-safehouse.session: { agentId, workspaceId }` on its owned Safehouse agents.
Both IDs come from the daemon's agent record. Publication patches only this metadata key when its value differs.
Publication failures leave receipt status available and retry on the next refresh. Lifecycle hooks never publish metadata.
The reference is a mutable UI locator. It grants no authority and does not prove preparation or sandbox entry.

The agent composer uses its existing refresh timer to resolve the referenced workspace's status.
It requires a matching agent ID and provider in that status before it shows the lock.
Missing, malformed, unmatched, or failed references retain the pill. A changed target discards prior results and ignores late responses.
Each mounted inline action reports readiness. The registration hides its agent's pill until the last ready instance loses readiness or unmounts.
If status fails, the last-known session action remains available with an unavailable label. A successful status refresh removes obsolete session actions.
The header menu selects **Enable automatic Safehouse**, **Disable automatic Safehouse**, or **Review policy**.
The selection applies across clients until changed. It leaves policy bytes and running agents unchanged.
The daemon stores one atomic record per canonical workspace beneath protected `safehouse/workspaces/` state.
Malformed records block creation. Disable requires a resolvable workspace but does not parse the policy.
Explicit enable persists without a policy. New launches then use defaults.
Executable availability takes precedence over the saved routing choice in the header. The panel reports both the saved choice and policy errors.
Existing Safehouse agents use the current file or defaults on resume, regardless of automatic routing.
When current policy resolution fails, receipts retain their preparation status and show that the current policy is unavailable.

On older hosts, the header changes a shared workspace choice. Concurrent launches can observe the same choice.

## Executable availability

The host-only `safehouse.availability` RPC takes no workspace input.
Workspace status uses the same read-only probe and retains its required workspace identity.
Both report available, missing, unusable, or unsupported. Missing and unusable produce the workspace state `unavailable`.
The probe checks the saved absolute executable first, then the daemon PATH if that path is inaccessible.
It runs the existing bounded help command to require policy support. Non-macOS hosts skip the executable probe.
A saved executable that fails its help check remains unusable until repaired or explicitly replaced through provider refresh.

A usable saved path remains available outside PATH.
A replacement at another path requires **Refresh providers** before the saved launchers are configured.
Detection preserves installation records, policies, workspace choices, receipts, and running agents.
The panel retains unsaved edits during polling and **Check again**.

On Paseo 0.15, **Safehouse unavailable** opens the existing panel directly.
The panel supplies daemon-Mac installation instructions, an official link, and **Check again**.
The Paseo 0.16 composer supplies installation instructions and Check again, and retains the header fallback on older hosts.
Executable availability does not promise provider configuration or valid workspace policy.
The availability RPC also returns the daemon metadata capability and owned provider IDs for accurate composer registration and fixed explicit-provider display.
The generic composer has no workspace identity. Its host guidance links to installation instructions without choosing a workspace tab.

## Launch architecture

The plugin uses provider variants that extend Paseo’s native adapters.
Each variant has a fixed command array that starts a protected bootstrap.
The bootstrap replaces itself with Safehouse and the native harness.
Paseo appends protocol arguments and manages the conversation.

```text
Ordinary provider selection
    → creation hook checks the draft override, then the saved directory choice
    → unless Off, select the Safehouse variant and validate file or defaults
    → opening hook prepares a protected policy snapshot
    → bootstrap starts Safehouse with the native harness
```

| Component | Responsibility                                                                      |
| --------- | ----------------------------------------------------------------------------------- |
| Plugin    | Policy review, workspace routing, protected snapshots, status, and reload controls  |
| Paseo     | Native adapters, model selection, process supervision, and conversation persistence |
| Safehouse | Policy generation and macOS sandbox enforcement                                     |

### Provider configuration

Generated IDs use `safehouse-{source}`. Setup skips these IDs and legacy `*-safehouse` or `*-safehouse-direct` aliases to prevent nested wrappers. Existing entries remain unchanged; an occupied unowned target causes setup to fail.

The plugin adds variants such as `safehouse-pi`, with `extends: "pi"` and a command array of this form:

```json
["/bin/sh", "/protected/launchers/pi-<content-hash>.sh"]
```

The generated bootstrap quotes each configured command element literally, then appends Paseo’s protocol arguments.
Session environment selects the protected policy snapshot.
Setup collects valid environment names explicitly configured on the source and its base provider.
Both bootstrap branches pass these names through Safehouse. The bootstrap contains names, not environment values.
Policy, loader, Node and shell-control variables remain blocked.
The plugin supplies the captured daemon home through `PASEO_HOME` and passes it explicitly through Safehouse. Other `PASEO_*` variables remain masked. Unlisted daemon variables retain Safehouse’s default sanitization.
Ordinary provider configuration remains intact. Installation rejects collisions with unrelated provider entries.
Explicit command arrays support built-in factories and direct derivatives of those factories.
A derived variant extends the same built-in and retains source overrides, including native environment and tool-restriction inheritance.
Generic custom ACP variants retain `extends: "acp"`. Identity-specific ACP adapters fail explicitly.
The small factory compatibility list reflects Paseo 0.15.3. The public API has no factory-capability query.
Ambiguous inheritance, unavailable executables, and missing commands outside Pi/Claude/Codex defaults fail before execution.
A provider that cannot be derived, such as a plugin-supplied adapter, uses the launch-wrap route when the host supports it.
Otherwise creation fails with `<provider> is not supported by Safehouse yet; disable automatic Safehouse to run it unsandboxed.` The panel lists the same text.
The installation records source and base configuration. Drift blocks launch with an instruction to configure Safehouse again.
Setup retains owned variants for existing agents. Ownership comes from the protected installation record, not the provider suffix.
Paseo’s provider settings own the `enabled` and `order` fields of an owned entry, so ownership and drift checks ignore them and Refresh providers keeps the user’s values.
The variant’s default environment selects restricted catalog discovery.
Prepared launches require an existing snapshot directly beneath the plugin’s snapshot directory.
Missing or malformed environment values fail before the harness starts.

### Plugin-supplied providers

Paseo plugins can register providers, for example `antigravity`, `muse`, `fx`, `hoplite` and `goose`.
These providers cannot be extended, so no `safehouse-<id>` variant exists for them.
On a host with a per-session launch wrapper, Safehouse wraps their sessions instead.
With automatic Safehouse on, creation selects the first route that applies:

1. **Derived route.** A provider with a derivable base uses `safehouse-<id>`, as described above. Codex always takes this route, even when its host can wrap it.
2. **Wrap route.** The provider cannot be derived, and its `paseo.providers.snapshot()` entry has `launchWrap: true`.
3. **Refusal.** Otherwise creation fails with the refusal text above.

Host support comes only from static data: the provider snapshot and the create request. A failed snapshot read counts as no support.
**Refresh providers** applies the same rule: it lists a configured provider as unsupported only when creation would refuse it.
Setup succeeds when the only providers on the host use the wrap route, and writes the wrap launcher.

On the wrap route, creation keeps the provider ID and configuration.
It validates the installation, policy and daemon access record, then adds the metadata marker `paseo-safehouse.route: "wrap"`.
Only this route sets the marker. Every other create removes a marker that the caller supplied, so the marker cannot select the wrap.
Where the host offers the plugin requirement, creation also returns `requirePlugin: true`. Paseo then refuses to open the agent while Safehouse is inactive.
The plugin requirement is not final in Paseo. Safehouse treats a boolean `requirePlugin` in the `agent.create.before` request as support.
`hostOffersPluginRequirement` in `server/service.ts` is the only check of this signal.
A host without the signal rejects an unknown create key, so Safehouse then returns no `requirePlugin`.
The creation open writes `agents/<hash>.route.json` once, by hard link, and never replaces it.
Every later open of that agent reads the record, including resume and history opens. A record for another provider, or a corrupt record, fails the open.
Metadata alone never wraps an agent. An agent without the marker and without a record opens as before.
A later open whose metadata has the marker but whose record is missing fails: "Safehouse route record is missing; recreate the agent or repair Safehouse state."

The open prepares the snapshot and receipt as the derived route does, and returns `wrap: ["/bin/sh", <launcher>, <names>, <profile>, <features>]`.
Paseo then starts `[...wrap, command, ...args]`.
Setup writes the generic launcher `launchers/wrap-<hash>.sh` on every **Refresh providers**. An installation without it asks for **Refresh providers**.
The launcher requires a prepared snapshot and checks its arguments:
- environment names contain only `[A-Za-z0-9_,]`;
- the provider profile is in the Safehouse state;
- the features are empty or a set from `wrapGrants`.

It resolves the harness like a direct exec: a path as given, otherwise the first `PATH` match.
It denies writes to the command under its canonical folder, which keeps a link protected, and to the real path the command resolves to.
Seatbelt matches canonical paths, so `//`, `.`, `..` and symlinked folders in `PATH` or the command do not weaken the rule. A path with a quote, backslash or control character, including a trailing newline, is refused.
It then runs `safehouse --env-pass=<names> [--enable=<features>] --trust-workdir-config [--append-profile <provider>] --append-profile <exec> --append-profile <guard> -- <harness> <args…>`.
The guard is last. A failed check exits with code 78 before Safehouse starts.

`wrapGrants` in `server/providers.ts` lists what each wrapped provider needs for its own sign-in and configuration:

| Provider | Read-write | Read-only | Safehouse features |
| --- | --- | --- | --- |
| Antigravity | `~/.gemini/antigravity-cli` | `~/.gemini/config` | `keychain`: `agy` loads its sign-in token from the macOS keychain, and Safehouse has no `agy` profile. |

Setup renders each entry into `provider-<id>-<hash>.sb`, with metadata reads on each ancestor folder. Other wrapped providers get only the workspace policy.
The panel lists agents with a route record together with `safehouse-*` agents, and **Reload** accepts them.

The wrap route has these limits:
- **Keep daemon access Off.** Paseo's host terminal tools, such as `create_terminal`, run outside any wrap.
- **Work before the open hook is not wrapped.** This includes draft command and control discovery, and the catalog lookup during creation without a model. For Antigravity, the ACP initialize probe during creation runs unwrapped.
- **Host operations are not wrapped.** These include usage queries, version checks and availability probes.
- **Existing agents are never wrapped retroactively.** They have no route record and no plugin requirement.
- **On a host without the plugin requirement, plugin loss removes the sandbox.** If the Safehouse plugin is disabled, removed or crashes, the next open of a wrapped agent starts its harness unsandboxed, and Paseo shows no error. On a host with the requirement, Paseo refuses that open instead.
- **A provider without a `wrapGrants` entry may fail to sign in.** This applies to Goose, Fx and Hoplite.
- **There is no account-home passthrough** on the wrap route.

### Provider setup recovery

Setup stores a protected `setup-pending.json` record before it changes provider configuration.
The record contains the intended installation, previous target entries, native source configuration, and complete guard and launcher bytes.
Setup writes immutable guard and launcher files before it publishes their commands.
It reads provider configuration again before it commits `installation.json` and removes the pending record.
A lost response or process interruption leaves enough evidence for the next setup call to complete the same plan.
Old guard and launcher generations remain available to existing sessions.

Recovery rejects changed targets, changed native sources, malformed state, and a changed daemon identity.
It preserves the pending record on failure and never adopts an unrecorded provider entry.
Calls share a queue for each daemon home within one process.
The public API has no compare-and-swap operation, so external writers can race with setup.
Exact readback detects resulting conflicts, but cannot exclude another daemon or an external writer.

Refresh retains an unavailable source's owned variant and immutable files, but marks that variant inactive.
Healthy providers and policy controls remain usable. New launches and reopen preparation reject inactive variants until their source returns.
Running processes retain their existing files and provider. Refresh does not reassign them.
If the public variant is also absent, refresh drops only its local ownership metadata.
An interrupted pending plan still rejects source conflicts instead of discarding its evidence.

Paseo recursively merges provider objects and retains omitted nested fields.
A refresh that requires nested-field deletion fails before any file or configuration write.
The previous installation remains intact.
Refresh retains previous empty masks for reserved environment names, even if those names disappear from the daemon environment.
This does not retain deleted user environment fields or nonempty values.
Atomic file replacement covers process interruption, but does not guarantee recovery from power loss or filesystem corruption.

### Lifecycle hooks

The beta targets Paseo 0.15.3 and Safehouse 0.12.0. Earlier evidence used Paseo 0.15.2.

| Integration point      | Behavior                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `agent.create.before`  | Detect and validate policy, preserve the selected model, and select the Safehouse variant |
| `agent.open.before`    | Load current policy and prepare environment for creation or resume                        |
| Provider command array | Start the bootstrap, then Safehouse and the native harness                                |
| Plugin panel and RPCs  | Review access, report readiness, and reload selected agents                               |

On hosts without the launch wrapper, the opening hook cannot change executable arguments, and provider configuration supplies the execution mechanism.
On hosts with it, the opening hook returns `wrap` for plugin-supplied providers. See [Plugin-supplied providers](#plugin-supplied-providers).
Creation hooks exclude Paseo’s internal agents. The beta must attempt the selected harness inside Safehouse, including harnesses outside the initial three adapters.
The local candidate wraps configured command arrays when the public adapter API preserves their semantics.
Providers without a usable exposed command fail with an explicit recovery path.
A failed sandboxed launch must report the failure without an unsandboxed retry.
The user can explicitly disable Safehouse for subsequent launches through the workspace header menu.

### Policy snapshots

The plugin copies the resolved effective policy into protected state outside the workspace.
Each snapshot contains canonical grants and copies of custom profiles.
`SAFEHOUSE_WORKDIR` selects the snapshot directory. An explicit grant supplies access to the actual workspace.
The harness retains the actual workspace as its process directory.
State paths use the canonical daemon home, so a symlinked `--home` launches.

The plugin removes inherited policy overrides from session environment and applies its own values.
Fixed final restrictions protect plugin state, snapshots, and plugin code.
Off snapshots also restrict daemon homes and captured local endpoints.
Changing a source file after preparation cannot change the prepared snapshot.
The opening hook resolves the source again before preparing the snapshot. Later source changes affect only subsequent processes.

The fixed restrictions name fixed paths.
They hold only while each protected folder is outside the workspace and outside every read-write grant.
A process that can write a folder containing a protected folder can rename the containing folder and reach the protected contents at the new path.
A plugin checkout inside a sandboxed workspace or grant meets that condition, so plugin development is done outside the sandbox.
A grant on a folder that contains the daemon home or the installed plugin meets it too.

Safehouse trims whitespace around each configured path.
Resolution therefore rejects a workspace or grant whose canonical path begins or ends with whitespace, and the policy file and editor reject a quoted path with edge whitespace.

Like Safehouse run from a shell, the plugin fixes a process's access when that process launches, and every launch and reload resolves the policy's paths again.
The snapshot denies the managed process writes to `.safehouse` and to each resolved profile file at its path.
It does not stop the process from changing other files, links, or folders it can write, so a later launch or reload at the same paths can resolve to a different policy or grant.
That includes a link or folder on the way to a grant or profile, a granted file, the workspace folder itself, and a symbolic link through which the workspace was opened.
A later launch uses whatever the paths lead to then.

### Workspace daemon access

The panel stores **Allow Paseo daemon access** in `safehouse/workspaces/<canonical-cwd-hash>.daemon-access.json`.
The protected record contains `cwd` and `enabled`. A missing record means Off; an invalid or unreadable record blocks launch.
A separate save serializes revision checks and atomic replacement per workspace within the plugin process.
This save does not modify the policy source or routing record. Stale saves retain the client draft.

Each opening captures the choice, active home, default home, and their available local TCP ports.
The effective preparation digest includes that capture and the policy digest. Receipts record the prepared choice.
Older receipts show unknown access and require reload. Saving does not change existing snapshots.
On adds a writable grant for the canonical active home. It omits the daemon restrictions.
On resolves the daemon process’s `PASEO_CLI` hint, then its PATH, and adds the resolved CLI app bundle as a read-only grant.
When neither selects a CLI, discovery checks the current runtime’s resources or executable path for its app bundle.
The fallback requires an executable `Contents/Resources/bin/paseo` inside that same canonical bundle.
An explicit invalid hint or a selected non-bundled CLI supplies no implicit grant. Discovery does not scan directories or use provider-specific PATH values.
The preparation digest includes that path. Off omits this implicit app grant; explicit policy grants retain their normal behavior.
Off appends daemon restrictions after custom profiles. Unconditional protection still covers plugin state, code, executables, policy sources, and snapshots.
Catalog discovery always uses its fixed Off guard. Existing installations require **Refresh providers** before an On launch.

The active installation must use loopback TCP. Port restrictions cover IPv4, IPv6, and hostname aliases through the existing `*:port` matcher.
The matcher can also block remote hosts on the same port. Unix sockets beneath the protected homes remain denied with Off.
Endpoint changes require fresh preparation. This mechanism does not monitor network changes in running processes.
Remote, proxy, relay, other service routes, and previously delegated work remain outside this direct-process boundary.
On permits sandbox escape through the daemon. It does not override restrictive user profiles. On also allows the native Paseo tools: Paseo injects them when `mcp.injectIntoAgents` is on, and on a daemon without a password the agent MCP endpoint serves the full catalog, browser tools included, without a credential.

One new agent can get daemon access without changing the workspace setting: create it with the label `paseo-safehouse.paseo-access=daemon`, for example `paseo run --label paseo-safehouse.paseo-access=daemon`. The choice is fixed at creation; later label or metadata changes do not change it, and the agent's workers do not inherit it. Daemon access includes the native Paseo tools as described above. `browser_upload` can pass the browser a host file through a workspace symlink.
Only the opening with reason `create` reads the value, and it writes `safehouse/agents/<agent-id-hash>.access.json` once with an exclusive link. Later openings read only that record; an agent without one uses the workspace setting. An unknown value, or a label and metadata that differ, fails creation. Effective access is the workspace setting OR `daemon`. Receipts and status record `paseoAccess`, and status compares each agent with its own effective digest.

### Account homes

An account-switching plugin can select an account home at session open. Claude variants pass `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`, and Codex variants pass `CODEX_HOME` and `CODEX_SQLITE_HOME`. Other bases, including Pi, pass no account names. Only prepared launches pass them; catalog discovery uses the harness's default home.
The opening hook cannot see these values, because Paseo runs opening hooks in plugin-id order and a switcher can run after Safehouse. The host-side launcher therefore checks each non-empty value before it starts Safehouse:

1. The value must be an absolute path to an existing directory. The launcher resolves it with `cd -P` and `pwd -P`.
2. The resolved path cannot contain `"`, `\` or control characters, because it goes into a Seatbelt string.
3. A path in `<daemon home>/safehouse`, the daemon home itself, or a directory one level below the daemon home stops the launch.
4. A path at least two levels below the daemon home gets a read and write grant for its subtree, and metadata-only grants for each ancestor up to the daemon home. Codex resolves the path and needs this metadata. Metadata does not permit a listing.
5. A path outside the daemon home passes without a grant. Policy and the Safehouse harness profiles decide its access.

A failure stops the launch with exit 78 and names the variable. The launcher passes the values unchanged. It writes the grants to `account-<pid>.sb` in the protected snapshot and appends that profile after the snapshot's Off deny and before the fixed guard, so plugin state stays denied. An `--add-dirs` grant would lose to the Off deny.
The grant does not follow links. A link inside the home reaches its target only when policy already allows the target. With Off, links to shared files elsewhere in the daemon home stay denied; a switcher that keeps shared files there needs daemon access On.
The two-level rule stops a grant of the whole home or of Paseo's top-level state. It does not identify every directory that Paseo owns: a trusted source that names a directory such as `<home>/agents/<name>` receives that subtree. Values come only from provider configuration, Paseo and enabled plugins.
Each launch reads the values at that opening, so a new session after a switch gets only the new home. Running sessions keep their grant. Existing installations require **Refresh providers**; older launchers drop the account variables.

### Provider discovery

The ordinary provider supplies the picker’s model catalog before workspace routing occurs.
This discovery retains Paseo’s host-side behavior and is outside the harness sandbox guarantee.
The creation hook preserves a selected or default model before selecting the variant.
A generic ACP harness can start without a model when its native catalog is empty.
Other empty-catalog cases report the selected provider and explicit ordinary-launch recovery.

Variant discovery bypasses the opening hook and receives the provider’s default environment.
The bootstrap changes its directory to `/` and starts Safehouse with an explicitly empty workdir grant.
Discovery retains Safehouse’s baseline harness access and fixed protections for plugin state and daemon endpoints.
It receives no workspace grants or workspace custom profiles.

The explicit Pi variant’s restricted discovery disables automatic extension loading. Its cached catalog can differ from the ordinary picker. An explicit `piCatalogExtensions` list can load extensions that register models.
The `safehouse.setup` RPC accepts absolute extension paths and persists them in the installation record.
Later setup calls preserve the list unless they supply a replacement. An empty array clears it.
These paths do not grant filesystem access. Extensions and dependencies must remain readable under the catalog sandbox.
Model providers from omitted extensions are absent from the catalog.
Normal Pi sessions retain their configured extensions and workspace policy.
Use the ordinary Pi picker to select models from native configuration without harness-specific Safehouse controls.
An isolated 0.15.3 probe selected a current Lunaroute model and completed sandboxed tool calls with an empty extension-path list.
Native session extensions can import files outside their configuration directory. Those dependencies require explicit workspace-policy access.
A denied import can appear as a missing-module error. Safehouse does not add grants automatically.

The catalog marker selects a restricted launch mode, not a protocol authorization check.
If a caller uses that marker for a conversation, the process retains catalog restrictions and receives no workspace access.
Supported session launches require the opening hook, which validates the workspace policy and supplies a snapshot.

### Provider permission modes

For Claude, the creation hook selects `modeId: bypassPermissions` after provider and policy validation.
Paseo 0.15.3 maps this mode to SDK `permissionMode: bypassPermissions` and supplies `allowDangerouslySkipPermissions: true`.
These SDK keys are not valid Claude `providerOptions`.
This applies to ordinary Claude selections, explicit Safehouse variants, and supported direct Claude derivatives.
Pi has no selectable permission mode. Its built-in tools run without a normal command approval flow.
Pi configuration remains unchanged. Extensions and custom hooks can retain their own controls.
For Codex, the creation hook selects **Full Access** after provider and policy validation.
It copies `providerOptions` and sets `sandbox_mode: danger-full-access` and `approval_policy: never`.
These explicit values override conflicting request configuration and provider defaults, which take precedence over the selected mode.
Safehouse enforces the outer process boundary. Codex does not create an inner sandbox or request tool approvals.
Other provider options and the selected model remain intact. The hook does not mutate the caller’s request.
Explicit tool restrictions remain intact.
Ordinary launches with a saved Off choice retain their selected mode and provider options.

Paseo stores the normalized Claude mode and Codex values with each new managed session and supplies them during native resume.
The opening hook validates the current workspace policy and prepares the outer sandbox snapshot.
Resume support covers sessions created with this normalization. Existing and imported sessions retain their stored settings.
The opening hook cannot change permission modes or provider options. Stored-session migration requires a separate design.

### Reload and resume

A running process retains its launch policy.
Reload validates the current policy, stops the selected process, and resumes its native conversation under a new snapshot.
Other agents continue running. Resume must preserve conversation history without repeating the initial task.
Detached descendants can retain the previous sandbox policy.

## Security boundary

Safehouse restricts the harness process and its children. The Paseo daemon remains outside that sandbox.
Daemon-side tools, MCP services, and external services have separate authority.
Explicit creation MCP maps and hook-local MCP maps and tools pass through unchanged.
Wrapped providers copy the source provider's `paseoTools` policy. When the daemon enables injection, Paseo adds its tool bridge to every Safehouse agent; without daemon access, the port guard blocks the bridge and the agent has no Paseo tools.
Off snapshots protect daemon homes and captured control ports. On grants direct CLI/API access with whole-daemon authority.
The daemon and plugin host remain trusted.
Additional MCP services can provide access outside the process sandbox. Users must consider each service's authority.
Other enabled plugins are not prohibited.
Harness-native services and enabled credentials retain their own authority.

Automatic workspace routing depends on an active plugin.
The installed API cannot enforce workspace routing after the plugin is disabled or removed.
Configured variants must still enter Safehouse or fail. They must never fall back to ordinary provider commands.

## Future upstream API opportunities

These improvements are outside the first beta requirements.

| Opportunity | Useful upstream API | Current approach or limitation |
| --- | --- | --- |
| Per-draft Safehouse choice and readiness | Creation-form contribution with persisted, namespaced draft values | Workspace header menu governs subsequent launches across clients. See [launch controls](launch-controls.md). |
| Safe launch for additional provider adapters | Session launch wrapper, with a plugin requirement | Used for plugin-supplied providers when the host reports the wrapper. Without the requirement, plugin loss reopens wrapped agents unsandboxed. Discovery and host operations stay unwrapped. |
| Consistent discovery lifecycle | Catalog hook with explicit configuration and launch context | Protected bootstrap handles discovery separately from session opening. |
| Final external-capability visibility | Final merged MCP/tool inventory and an optional veto | Disclose external authority; hook-local maps cannot establish global filtering. |
| Permission changes during reopen | Supported mutation of effective provider options before resume | Persist compatible creation options and test native resume. |
| Sandboxed workspace tools | Scoped terminal execution and environment APIs | [Workspace capabilities](workspace-capabilities.md) remains a separate design draft. |
