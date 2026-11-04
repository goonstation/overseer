# Updating Overseer

Production runs one `overseer` container. Its host-side updater temporarily refuses new uploads and restarts, waits for admitted work to finish, then replaces the container. Existing uploads, extraction, publication/rollback/cleanup, and detached restart commands are tracked explicitly. There is a short period of HTTP 503 responses and connection failures; external callers must retry requests that were not accepted.

Uploads retain their direct API contract: HTTP 200 means all artifacts finished publishing. Restart requests return HTTP 202 with an operation ID to poll. Restart operation history is in memory and disappears during replacement.

## Initial deployment

Place the project files in `/opt/overseer`, configure `.env` from `.env.example`, set `API_TOKEN`, verify mapped host UID/GID and absolute storage paths, and create the storage directories. Deploy the drain-aware version once:

```sh
docker compose -f compose.yaml -f compose.production.yaml config --quiet
docker compose -f compose.yaml -f compose.production.yaml up -d --no-build --pull always
```

Older versions without the maintenance client are rejected by the updater before stopping anything. User namespace remapping and host ownership settings remain as documented in the README.

## Run an update

The Docker host needs Bash, Docker with Compose, `flock`, and GNU `sync`. It does not need Node or a separate API-token configuration. The Node maintenance client runs inside the existing container and reads its API token. For private images, configure registry login for the updater account.

```sh
./scripts/update-overseer.sh -f compose.yaml -f compose.production.yaml
```

These two Compose files are the default when no arguments are supplied. Custom arguments are Docker Compose global options, such as `-f` or `--env-file`.

The script:

1. Serializes attempts with a host `flock`, checks maintenance support, pulls the image, and skips replacement if the image ID is unchanged.
2. Validates runtime imports and pins old/new image IDs under unique local tags before refusing new mutations.
3. Drains the current instance. Read-only and maintenance requests remain available; new uploads/restarts receive 503 with `Retry-After: 5`.
4. Waits for all tracked work to finish, then seals the drain only at zero active work. A sealed handoff cannot expire and accidentally admit new mutations.
5. Replaces only `overseer` with `--no-deps --no-build --pull never`. The API is briefly unavailable during recreation.
6. Checks that the new instance is accepting requests and clears the recovery journal.

The fsynced `.overseer-update/attempt` journal records the old container, update token, image ID, and phase. Concurrent invocations skip while the host lock is held. A killed updater is recovered the next time you invoke the script. Keep this directory private and persistent; it is ignored by Git and excluded from Docker builds.

## Image selection and limits

Run the updater manually when you want to check for a new image. `OVERSEER_IMAGE` in `.env` selects the tag or digest to follow (default `ghcr.io/goonstation/overseer:latest`). Use an immutable release/commit tag to hold a specific version.

The updater waits up to ten minutes for draining and one minute for replacement readiness. Export `OVERSEER_UPDATE_DRAIN_TIMEOUT_MS` or `OVERSEER_UPDATE_READY_TIMEOUT_MS` before invoking the script to change these host-side limits. They are not automatically loaded from Compose's `.env`. `OVERSEER_UPDATE_STATE_DIR` selects another private persistent host journal directory.

## Failure and recovery

- Pull/preflight failures leave the existing instance running.
- Drain deadline expiry never forces active work to stop. Recovery resumes the existing instance and revokes the attempt token.
- Unsealed drain leases expire after two minutes without renewal. A resumed attempt cannot be reclaimed by an orphaned maintenance client. Sealed drains remain closed until explicit recovery or container replacement.
- A healthy replacement is retained. An unhealthy replacement is never stopped for rollback merely because readiness failed: it may already have accepted work through the public port. Recovery first requires that replacement to drain and seal with zero active work, then restores the previous image and checks readiness.
- If the replacement is unreachable, changes identity, or cannot prove it is idle, automatic recovery retains the journal and reports failure instead of forcibly stopping potentially active work. Re-run the updater to retry recovery; inspect service logs and the journal if it remains unresolved.
- Do not run a second updater or scale multiple instances against the same game storage. The supplied script serializes its own invocations; unrelated manual container replacement bypasses its safety protocol.

The protocol protects in-flight work during normal controlled updates. Existing job deadlines, disk failure, process crashes, power loss, and forced/manual container termination can still interrupt work. Read-only requests may fail during recreation, and callers must handle the accepted update window.

## Maintenance API

All routes require bearer authentication. POST operations also require a unique 16–128 character `X-Drain-Token` containing letters, digits, underscores, or hyphens; the updater uses UUIDs. A different owner receives 409.

| Route | Method | Meaning |
| --- | --- | --- |
| `/maintenance` | GET | Instance identity, mode, active counts, readiness, and lease expiry |
| `/maintenance/drain` | POST | Acquire a drain and reject new mutations |
| `/maintenance/renew` | POST | Renew an owned unsealed drain |
| `/maintenance/seal` | POST | Seal only an owned drain with zero active work |
| `/maintenance/resume` | POST | Resume and revoke the owned attempt token |

The updater contacts the container directly so it can drain and inspect maintenance state regardless of the public bind address. SIGTERM/SIGINT also close admission and explicitly await tracked work and HTTP shutdown, with the configured final shutdown deadline as a fallback.
