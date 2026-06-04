#!/bin/sh
':' /*
set -eu
script_dir=${0%/*}
if [ "$script_dir" = "$0" ]; then
  script_dir=.
fi
root=$(CDPATH= cd -- "$script_dir/.." && pwd)
node_bin=${GEMINI_MD_EXPORT_NODE:-}
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  node_bin=
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then
      node_bin=$candidate
      break
    fi
  done
fi
if [ -z "$node_bin" ] && command -v node >/dev/null 2>&1; then
  node_bin=$(command -v node)
fi
if [ -z "$node_bin" ]; then
  printf '%s\n' 'gemini-md-export native host: Node.js not found.' >&2
  exit 127
fi
exec "$node_bin" "$root/src/native-host.mjs" "$@"
*/

import '../src/native-host.mjs';
