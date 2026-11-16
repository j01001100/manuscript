#!/bin/zsh
# Double-click to open Manuscript. Close this window (or press Ctrl+C) to quit.
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if curl -s -o /dev/null http://localhost:4747/api/health; then
  open http://localhost:4747
  exit 0
fi
(sleep 1; open http://localhost:4747) &
exec node server.js
