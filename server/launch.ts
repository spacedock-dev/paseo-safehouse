import path from "node:path";
import { paseoIdentityNames, providerEnvironmentNames } from "./policy";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** A host-side bootstrap. Both branches replace themselves with Safehouse. */
export function renderBootstrap(input: {
  root: string;
  binary: string;
  guard: string;
  catalogGuard?: string;
  executable?: string;
  command?: string[];
  host: string;
  piCatalogExtensions?: string[];
  envPass?: string[];
  accountEnv?: string[];
}) {
  const { root, binary, guard, host } = input;
  const command = input.command ?? [input.executable!];
  if (!command.length || command.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !command[0])
    throw new Error("Safehouse requires a nonempty literal command array.");
  const argv = command.map(quote).join(" ");
  const names = [...providerEnvironmentNames(input.envPass ?? []), "PASEO_HOME"];
  const environment = names.length ? ` --env-pass=${quote(names.join(","))}` : "";
  const snapshots = path.join(root, "snapshots");
  // Account names reach only prepared sessions, after the host validates each value.
  const accountNames = providerEnvironmentNames(input.accountEnv ?? []);
  const sessionEnvironment = ` --env-pass=${quote([...new Set([...names, ...paseoIdentityNames, ...accountNames])].join(","))}`;
  const home = quote(path.dirname(root)), state = quote(root);
  const accountFunctions = accountNames.length ? `account_fail() {
  echo "Safehouse: $1 $2" >&2
  exit 78
}
account_home() {
  [ -n "$2" ] || return 0
  case "$2" in /*) ;; *) account_fail "$1" 'must be an absolute path.' ;; esac
  # The final dot keeps trailing newlines that command substitution removes.
  account_dir=$(cd -P -- "$2" 2>/dev/null && pwd -P && echo .) || account_fail "$1" 'must name an existing directory.'
  account_dir=\${account_dir%?.}
  case "$account_dir" in *\\"*|*\\\\*|*[[:cntrl:]]*) account_fail "$1" 'contains a quote, backslash or control character.' ;; esac
  case "$account_dir" in
    ${state}|${state}/*) account_fail "$1" 'cannot name Safehouse state.' ;;
    ${home}/*/*) ;;
    ${home}|${home}/*) account_fail "$1" 'must be at least two levels below the daemon home.' ;;
    *) return 0 ;;
  esac
  account_rule="(allow file-read* file-write* (subpath \\"$account_dir\\"))"
  /usr/bin/grep -Fqx -- "$account_rule" "$account_profile" && return 0
  printf '%s\\n' "$account_rule" >> "$account_profile"
  # Path resolution reads the metadata of each ancestor. Metadata does not permit a listing.
  while [ "$account_dir" != ${home} ]; do
    account_dir=\${account_dir%/*}
    printf '(allow file-read-metadata (literal "%s"))\\n' "$account_dir" >> "$account_profile"
  done
}
` : "";
  const accountChecks = accountNames.length ? `          account_profile="$SAFEHOUSE_WORKDIR/account-$$.sb"
          : > "$account_profile"
${accountNames.map((name) => `          account_home ${name} "\${${name}-}"\n`).join("")}` : "";
  const accountProfile = accountNames.length ? ' --append-profile "$account_profile"' : "";
  const catalogArgs =
    host === "pi"
      ? " --no-extensions" +
        (input.piCatalogExtensions ?? [])
          .map((file) => ` --extension ${quote(file)}`)
          .join("")
      : "";
  return `#!/bin/sh
set -eu
if [ "$(/usr/bin/uname -s)" != Darwin ]; then
  echo 'Safehouse requires macOS.' >&2
  exit 78
fi
if [ "\${SAFEHOUSE_WORKDIR-}" = ${quote(path.join(root, "catalog"))} ]; then
  # Catalog discovery has no workspace policy or session-opening hook.
  cd /
  export SAFEHOUSE_WORKDIR=''
  exec ${quote(binary)}${environment} --workdir '' --append-profile ${quote(input.catalogGuard ?? guard)} -- ${argv}${catalogArgs} "$@"
fi
${accountFunctions}case "\${SAFEHOUSE_WORKDIR-}" in
  ${quote(snapshots)}/*)
    snapshot_name=\${SAFEHOUSE_WORKDIR#${quote(snapshots + "/")}}
    case "$snapshot_name" in
      ''|.|..|*/*) ;;
      *)
        if [ -f "$SAFEHOUSE_WORKDIR/.safehouse" ]; then
${accountChecks}          exec ${quote(binary)}${sessionEnvironment} --trust-workdir-config${accountProfile} --append-profile ${quote(guard)} -- ${argv} "$@"
        fi
        ;;
    esac
    ;;
esac
echo 'A prepared Safehouse snapshot is required for this launch.' >&2
exit 78
`;
}

/**
 * The session launcher for the launch-wrap route. Paseo runs
 * `[/bin/sh, file, names, profile, features, command, ...args]`, where the first three values come from the open hook.
 * Only a prepared snapshot runs. `features` must be one of the given sets, or empty.
 */
export function renderWrapLauncher(input: { root: string; binary: string; guard: string; features: string[] }) {
  const { root, binary, guard } = input;
  if (input.features.some((set) => !/^[a-z0-9-]+(,[a-z0-9-]+)*$/.test(set)))
    throw new Error("Safehouse wrap features must be comma-separated feature names.");
  const snapshots = path.join(root, "snapshots");
  return `#!/bin/sh
set -eu
fail() {
  echo "Safehouse: $1" >&2
  exit 78
}
[ "$(/usr/bin/uname -s)" = Darwin ] || fail 'requires macOS.'
[ "$#" -ge 4 ] || fail 'the wrapped launch has no command.'
names=$1 provider_profile=$2 features=$3
shift 3
case "$names" in ''|*[!A-Za-z0-9_,]*) fail 'invalid environment names.' ;; esac
case "$provider_profile" in ''|${quote(root + "/")}*) ;; *) fail 'the provider profile is outside Safehouse state.' ;; esac
case "$features" in ${["''", ...input.features.map(quote)].join("|")}) ;; *) fail 'unsupported Safehouse features for a wrapped launch.' ;; esac
case "\${SAFEHOUSE_WORKDIR-}" in
  ${quote(snapshots)}/*) snapshot_name=\${SAFEHOUSE_WORKDIR#${quote(snapshots + "/")}} ;;
  *) fail 'a prepared Safehouse snapshot is required for this launch.' ;;
esac
case "$snapshot_name" in ''|.|..|*/*) fail 'a prepared Safehouse snapshot is required for this launch.' ;; esac
[ -f "$SAFEHOUSE_WORKDIR/.safehouse" ] || fail 'a prepared Safehouse snapshot is required for this launch.'
# Paseo chooses the harness executable. Deny writes to it, as setup does for derived providers.
# Resolve it like the direct exec Paseo would make: a path as given, otherwise the first PATH match.
executable=
case "$1" in
  */*) if [ -f "$1" ] && [ -x "$1" ]; then executable=$1; fi ;;
  *)
    rest="\${PATH-}:"
    while [ -n "$rest" ]; do
      dir=\${rest%%:*} rest=\${rest#*:}
      if [ -f "\${dir:-.}/$1" ] && [ -x "\${dir:-.}/$1" ]; then executable="\${dir:-.}/$1"; break; fi
    done
    ;;
esac
[ -n "$executable" ] || fail "command $1 is unavailable."
case "$executable" in /*) ;; *) fail "command $1 does not resolve to an absolute path." ;; esac
# Seatbelt matches canonical paths. The rule names the command itself under its canonical folder, so a link
# stays protected, and the target it resolves to. The final dot keeps trailing newlines that command substitution removes.
folder=$(cd -P -- "\${executable%/*}/" && /bin/pwd -P && echo .) || fail "command $1 cannot be resolved."
folder=\${folder%?.}
link="\${folder%/}/\${executable##*/}"
real=$(/bin/realpath -- "$executable" && echo .) || fail "command $1 cannot be resolved."
real=\${real%?.}
case "$link$real" in *\\"*|*\\\\*|*[[:cntrl:]]*) fail 'the command path contains a quote, backslash or control character.' ;; esac
exec_profile="$SAFEHOUSE_WORKDIR/exec-$$.sb"
printf '(deny file-write* (literal "%s") (literal "%s"))\\n' "$link" "$real" > "$exec_profile"
shift
# Build the options in front of the harness argv. The guard profile stays last.
set -- --append-profile "$exec_profile" --append-profile ${quote(guard)} -- "$executable" "$@"
if [ -n "$provider_profile" ]; then set -- --append-profile "$provider_profile" "$@"; fi
set -- --trust-workdir-config "$@"
if [ -n "$features" ]; then set -- --enable="$features" "$@"; fi
exec ${quote(binary)} --env-pass="$names" "$@"
`;
}

/** Access to folders below `home`, with metadata reads on their ancestors. */
export function grantProfile(home: string, grants: { readWrite?: string[]; readOnly?: string[] }) {
  const rules = new Set<string>();
  for (const [access, folders] of [["file-read* file-write*", grants.readWrite ?? []], ["file-read*", grants.readOnly ?? []]] as const)
    for (const relative of folders) {
      const folder = path.resolve(home, relative);
      if (!folder.startsWith(home + "/") || /["\\\x00-\x1f]/.test(folder)) throw new Error(`Invalid provider grant ${relative}.`);
      rules.add(`(allow ${access} (subpath ${JSON.stringify(folder)}))`);
      for (let dir = path.dirname(folder); dir.startsWith(home + "/"); dir = path.dirname(dir))
        rules.add(`(allow file-read-metadata (literal ${JSON.stringify(dir)}))`);
    }
  return [...rules].map((rule) => rule + "\n").join("");
}
