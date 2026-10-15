#!/usr/bin/env bash
# Build file cài đặt. Ví dụ:
#   ./build.sh                 # Linux (.deb)
#   ./build.sh all             # Linux + Windows (cần wine32)
#   ./build.sh --version 1.2.0
set -e
cd "$(dirname "$0")"
exec node scripts/build.js "$@"
