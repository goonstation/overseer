#!/usr/bin/env bash
# Run on the production Docker host. Requires Docker Compose, Bash, flock, and sync.
set -Eeuo pipefail
umask 077

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$project_dir"
compose_args=("$@")
if (( ${#compose_args[@]} == 0 )); then
  compose_args=(-f compose.yaml -f compose.production.yaml)
fi
state_dir="${OVERSEER_UPDATE_STATE_DIR:-$project_dir/.overseer-update}"
mkdir -p "$state_dir"
chmod 700 "$state_dir"
exec 9>"$state_dir/lock"
if ! flock -n 9; then
  echo 'Another Overseer update is active; skipping'
  exit 0
fi
state_file="$state_dir/attempt"
override="$state_dir/pinned.yaml"
drain_timeout="${OVERSEER_UPDATE_DRAIN_TIMEOUT_MS:-600000}"
ready_timeout="${OVERSEER_UPDATE_READY_TIMEOUT_MS:-60000}"
old_container=''
attempt_token=''
old_image=''
phase='preparing'

compose() { docker compose "${compose_args[@]}" "$@"; }
container_id() {
  local value
  value="$(compose ps -q "$1")"
  [[ "$value" =~ ^[a-f0-9]{12,64}$ ]] || { echo "Expected one running $1 container" >&2; return 1; }
  printf '%s' "$value"
}
maintenance() {
  local container="$1" action="$2" timeout_ms=5000
  if [[ "$action" == wait ]]; then timeout_ms="$drain_timeout"; fi
  if [[ "$action" == await-ready ]]; then timeout_ms="$ready_timeout"; fi
  # Read the API token from the container environment, never host command arguments.
  docker exec --env "OVERSEER_UPDATE_DRAIN_TOKEN=$attempt_token" \
    --env "OVERSEER_UPDATE_CLIENT_TIMEOUT_MS=$timeout_ms" \
    "$container" node --enable-source-maps /app/dist/scripts/maintenance.js "$action"
}
write_state() {
  printf '%s\n' "$old_container" "$attempt_token" "$old_image" "$phase" > "$state_file.tmp"
  sync -f "$state_file.tmp"
  mv "$state_file.tmp" "$state_file"
  sync -f "$state_dir"
}
read_state() {
  local fields=()
  mapfile -t fields < "$state_file"
  [[ ${#fields[@]} == 4 ]] || { echo 'Invalid updater recovery journal' >&2; return 1; }
  old_container="${fields[0]}"; attempt_token="${fields[1]}"
  old_image="${fields[2]}"; phase="${fields[3]}"
  [[ "$old_container" =~ ^[a-f0-9]{12,64}$ &&
     "$attempt_token" =~ ^[a-zA-Z0-9_-]{16,128}$ && "$old_image" =~ ^sha256:[a-f0-9]{64}$ &&
     "$phase" =~ ^(preparing|replacing)$ ]] || { echo 'Invalid updater recovery fields' >&2; return 1; }
}
clear_state() {
  rm -f "$state_file" "$override"
  sync -f "$state_dir"
  # Remove only this attempt's temporary tags; never force removal of an in-use image.
  docker image rm "overseer-update:$attempt_token" "overseer-rollback:$attempt_token" >/dev/null 2>&1 || true
}
write_override() {
  printf 'services:\n  overseer:\n    image: %s\n' "$1" > "$override"
}
replace_worker() {
  docker compose "${compose_args[@]}" -f "$override" up -d --no-deps --no-build --pull never overseer
}
recover() {
  local current
  read_state
  current="$(container_id overseer 2>/dev/null || true)"
  if [[ "$current" == "$old_container" ]]; then
    # Revokes the attempt so an orphaned docker-exec client cannot re-enter a drain.
    maintenance "$old_container" resume >/dev/null
    clear_state
    echo 'Existing Overseer resumed'
    return
  fi
  if [[ -n "$current" ]] && maintenance "$current" await-ready >/dev/null; then
    clear_state
    echo 'Replacement Overseer is accepting requests'
    return
  fi
  # The replacement may already have accepted work on its public port. Never
  # stop it for rollback without a fresh drain and zero-active-work proof.
  [[ "$phase" == replacing && -n "$current" ]] || { echo 'No running replacement to drain; preserving recovery journal' >&2; return 1; }
  echo 'Checking whether the replacement can safely drain for rollback' >&2
  maintenance "$current" wait >/dev/null
  [[ "$(container_id overseer)" == "$current" ]] || { echo 'Container identity changed during recovery' >&2; return 1; }
  maintenance "$current" sealed >/dev/null
  echo 'Restoring the previous image after the replacement drained' >&2
  docker image tag "$old_image" "overseer-rollback:$attempt_token"
  write_override "overseer-rollback:$attempt_token"
  replace_worker
  current="$(container_id overseer)"
  maintenance "$current" await-ready >/dev/null
  clear_state
  echo 'Previous image restored and accepting requests'
}
cleanup() {
  local result=$? recovery_result=0
  trap - EXIT INT TERM
  if [[ -f "$state_file" ]]; then
    # Run the proof outside an if/|| condition: Bash otherwise suppresses errexit
    # inside recover and could stop work after a failed safety check.
    set +e
    (set -Eeuo pipefail; recover)
    recovery_result=$?
    set -e
    if (( recovery_result != 0 )); then
      echo "Recovery incomplete; no potentially active replacement was forcibly stopped. Journal: $state_file" >&2
      result=1
    fi
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -f "$state_file" ]]; then
  echo 'Recovering a previous update attempt'
  recover
  exit 0
fi
old_container="$(container_id overseer)"
# Refuse legacy installations before changing or stopping anything.
maintenance "$old_container" ready >/dev/null
image="$(compose config --images overseer)"
[[ -n "$image" && "$image" != *$'\n'* ]] || { echo 'Expected one configured worker image' >&2; exit 1; }
compose pull overseer
new_image="$(docker image inspect --format '{{.Id}}' "$image")"
old_image="$(docker inspect --format '{{.Image}}' "$old_container")"
[[ "$new_image" =~ ^sha256:[a-f0-9]{64}$ && "$old_image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid image identity' >&2; exit 1; }
if [[ "$new_image" == "$old_image" ]]; then
  echo 'Overseer is already using the current image'
  exit 0
fi
# Check runtime imports before temporarily refusing new mutations.
docker run --rm --network none --entrypoint node "$new_image" --input-type=module -e \
  'await import("./dist/app.js"); await import("./dist/lifecycle.js"); await import("./dist/scripts/maintenance.js"); await import("node:fs/promises").then(fs => fs.access("./dist/scripts/extract_archive.js"))'
read -r attempt_token < /proc/sys/kernel/random/uuid
phase=preparing
write_state
# Pin both image identities: a registry tag changing mid-update cannot change the handoff.
docker image tag "$new_image" "overseer-update:$attempt_token"
docker image tag "$old_image" "overseer-rollback:$attempt_token"
echo 'Draining uploads, restarts, and cleanup; new mutations receive HTTP 503'
maintenance "$old_container" wait >/dev/null
[[ "$(container_id overseer)" == "$old_container" ]] || { echo 'Container identity changed; refusing replacement' >&2; exit 1; }
maintenance "$old_container" sealed >/dev/null
write_override "overseer-update:$attempt_token"
phase=replacing
write_state
replace_worker
new_container="$(container_id overseer)"
[[ "$new_container" != "$old_container" ]] || { echo 'Worker was not replaced' >&2; exit 1; }
maintenance "$new_container" await-ready >/dev/null
clear_state
echo 'Overseer updated and accepting requests'
