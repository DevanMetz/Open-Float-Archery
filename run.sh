#!/bin/sh
if command -v python3 >/dev/null 2>&1; then
  exec python3 tools/server.py 4178
elif command -v python >/dev/null 2>&1; then
  exec python tools/server.py 4178
else
  echo "Error: Python 3 is required to run the OpenFloat server." >&2
  exit 1
fi
