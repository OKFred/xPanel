#!/usr/bin/env sh
set -eu

host_name='com.okfred.xpanel'
production_extension_id='diaemdialoooebdennhpgnmobnjabohm'
script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
extension_id=${2:-$production_extension_id}

case "$(uname -m)" in
  x86_64|amd64) host_architecture='x64' ;;
  arm64|aarch64) host_architecture='arm64' ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 2
    ;;
esac
case "$(uname -s)" in
  Darwin) host_platform='darwin' ;;
  Linux) host_platform='linux' ;;
  *)
    echo 'Only macOS and Linux are supported by this installer.' >&2
    exit 2
    ;;
esac
host_executable=${1:-"$script_directory/../dist/sea/$host_platform-$host_architecture/xpanel-native-host"}

case "$extension_id" in
  *[!a-p]*|'')
    echo 'Extension id must contain exactly 32 letters in the range a-p.' >&2
    exit 2
    ;;
esac
if [ "${#extension_id}" -ne 32 ]; then
  echo 'Extension id must contain exactly 32 letters in the range a-p.' >&2
  exit 2
fi
if [ ! -f "$host_executable" ] || [ ! -x "$host_executable" ]; then
  echo "Host executable is missing or not executable: $host_executable" >&2
  exit 2
fi

curl_executable=$(command -v curl 2>/dev/null || true)
case "$curl_executable" in
  /*) ;;
  *)
    echo 'System curl was not found on PATH.' >&2
    exit 2
    ;;
esac
curl_version_line=$("$curl_executable" --disable --version 2>/dev/null | sed -n '1p')
curl_version=$(printf '%s\n' "$curl_version_line" | sed -n 's/^curl \([0-9][0-9]*\)\.\([0-9][0-9]*\).*$/\1 \2/p')
if [ -z "$curl_version" ]; then
  echo 'curl preflight returned an unrecognized version.' >&2
  exit 2
fi
curl_major=${curl_version%% *}
curl_minor=${curl_version#* }
if [ "$curl_major" -lt 7 ] || { [ "$curl_major" -eq 7 ] && [ "$curl_minor" -lt 70 ]; }; then
  echo "curl 7.70.0 or newer is required; found: $curl_version_line" >&2
  exit 2
fi

case "$host_platform" in
  darwin)
    data_directory="$HOME/Library/Application Support/xPanel/NativeHost"
    manifest_directory="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  linux)
    data_root=${XDG_DATA_HOME:-"$HOME/.local/share"}
    config_root=${XDG_CONFIG_HOME:-"$HOME/.config"}
    data_directory="$data_root/xpanel/native-host"
    manifest_directory="$config_root/google-chrome/NativeMessagingHosts"
    ;;
esac

installed_executable="$data_directory/xpanel-native-host"
manifest_path="$manifest_directory/$host_name.json"
mkdir -p "$data_directory" "$manifest_directory"
install -m 0755 "$host_executable" "$installed_executable"

escaped_path=$(printf '%s' "$installed_executable" | sed 's/\\/\\\\/g; s/"/\\"/g')
{
  printf '{\n'
  printf '  "name": "%s",\n' "$host_name"
  printf '  "description": "xPanel secure native HTTP companion",\n'
  printf '  "path": "%s",\n' "$escaped_path"
  printf '  "type": "stdio",\n'
  printf '  "allowed_origins": ["chrome-extension://%s/"]\n' "$extension_id"
  printf '}\n'
} > "$manifest_path"
chmod 0644 "$manifest_path"

echo "Installed $host_name for chrome-extension://$extension_id/"
echo "Manifest: $manifest_path"
