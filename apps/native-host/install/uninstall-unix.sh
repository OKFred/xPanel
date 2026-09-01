#!/usr/bin/env sh
set -eu

host_name='com.okfred.xpanel'
case "$(uname -s)" in
  Darwin)
    data_directory="$HOME/Library/Application Support/xPanel/NativeHost"
    manifest_path="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$host_name.json"
    ;;
  Linux)
    data_root=${XDG_DATA_HOME:-"$HOME/.local/share"}
    config_root=${XDG_CONFIG_HOME:-"$HOME/.config"}
    data_directory="$data_root/xpanel/native-host"
    manifest_path="$config_root/google-chrome/NativeMessagingHosts/$host_name.json"
    ;;
  *)
    echo 'Only macOS and Linux are supported by this uninstaller.' >&2
    exit 2
    ;;
esac

rm -f -- "$manifest_path" "$data_directory/xpanel-native-host"
rmdir -- "$data_directory" 2>/dev/null || true
echo "Uninstalled $host_name"
