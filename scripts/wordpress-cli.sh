#!/usr/bin/env bash
# Local fixture wrapper; all writable WordPress files live on the Scratch mount.
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
exec docker compose -p "${ENTITLE_COMPOSE_PROJECT:-double-entitle-saas-test}" \
  -f "$project_dir/compose.test.yaml" run --rm --no-deps -T \
  -e DOUBLE_ENTITLE_TEST_KEY -e WP_CLI_CACHE_DIR=/wp-tmp/cli-cache wpcli wp "$@"
