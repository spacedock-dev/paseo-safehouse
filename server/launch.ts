import path from "node:path";
import { providerEnvironmentNames } from "./policy";

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
  const sessionEnvironment = ` --env-pass=${quote([...new Set([...names, ...accountNames])].join(","))}`;
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
