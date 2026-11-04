# Configuration and operations reference

See the [README](../README.md) for setup and [update instructions](unattended-updates.md) for manual container replacement.

## Configuration

All values below are optional except `API_TOKEN`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_TOKEN` | required | At least 32 characters, no whitespace |
| `SERVER_HOST` / `SERVER_PORT` | `127.0.0.1` / `8564` | HTTP listener |
| `SERVERS_ROOT` | `/servers` | Server directories |
| `BYOND_ROOT` / `RUSTG_ROOT` | `/byond` / `/rust-g` | Installed version directories |
| `CONTAINER_PREFIX` | `ss13-` | Prefix used to select Docker containers |
| `GAME_USER_OWNER` / `GAME_USER_GROUP` | `306969` / `306969` | Numeric ownership of extracted artifacts |
| `MAX_UPLOAD_BYTES` | `536870912` | Compressed bytes per archive (512 MiB) |
| `MAX_REQUEST_BYTES` | `1610678272` | Entire multipart body, including overhead |
| `MAX_EXTRACTED_BYTES` | `2147483648` | Uncompressed bytes per archive (2 GiB) |
| `MAX_ARCHIVE_ENTRIES` | `100000` | Maximum files and directories per archive |
| `UPLOAD_TIMEOUT_MS` | `300000` | Complete upload, extraction, and publication deadline |
| `REQUEST_TIMEOUT_MS` | `330000` | HTTP body receipt timeout; must exceed upload deadline |
| `COMMAND_TIMEOUT_MS` | `120000` | Maximum duration of each subprocess |
| `RESTART_TIMEOUT_MS` | `300000` | Overall restart command sequence deadline |
| `OPERATION_LIMIT` / `OPERATION_TTL_MS` | `1000` / `86400000` | Retained restart history count and lifetime |
| `SENTRY_DSN` | unset | Optional Sentry error reporting |

Extraction runs in a separate Node process with a 384 MiB V8 old-generation heap limit; this is not a hard limit on total process memory. Entries and file contents are processed sequentially through bounded streams. Decompressed tar data, including metadata and padding, is capped at `MAX_EXTRACTED_BYTES + MAX_ARCHIVE_ENTRIES * 1024 + 8 MiB`, and an individual extended tar header is limited to 4 MiB by the parser. File, request, entry, extraction, and time limits apply independently. Allow enough disk space for compressed uploads, staged extraction, and an old pending build during replacement. Configured root directories may be symlinks; server-selected descendants and destination versions may not.

Server and runtime version identifiers must start with an ASCII letter or digit and contain only letters, digits, `_`, `.`, and `-`, with at most 128 characters. Build stamps are nonnegative safe integers. Duplicate required query parameters are rejected.

### Docker Compose with user namespace remapping

Copy `.env.example` to `.env`, set `API_TOKEN`, configure the three storage roots as existing absolute host paths, and verify the host ownership IDs. Then run:

```sh
docker compose config --quiet
docker compose up -d --build
docker compose logs -f overseer
```

`compose.yaml` runs Overseer as `0:0` with `userns_mode: host`. This disables user namespace remapping for Overseer only, allowing access to the root-owned Docker socket and ownership changes on host bind mounts. The daemon's `userns-remap` setting remains enabled, and game containers still inherit it unless their own configuration overrides it. This is an administrative exception: Overseer runs with host-visible root identity and controls the host Docker daemon. See [Docker's user namespace documentation](https://docs.docker.com/engine/security/userns-remap/#disable-namespace-remapping-for-a-container).

Because Overseer uses the host user namespace, `GAME_USER_OWNER` and `GAME_USER_GROUP` must be the numeric IDs **on the host** corresponding to the user that runs the game. For a single mapping beginning at container ID zero, host ID equals the mapping's host base plus the game's container ID. For example, a host UID base of `231072` and game UID `1000` give `GAME_USER_OWNER=232072`; calculate the GID separately from its own mapping. Multiple mapping ranges require using the range that contains the game's ID. The example value `306969` is an existing project default, not a universal remapping value. See [Docker's mapping explanation](https://docs.docker.com/engine/security/userns-remap/#about-remapping-and-subordinate-user-and-group-ids).

On the production host, inspect the running game's user and its actual namespace maps:

```sh
docker exec ss13-alpha id
GAME_CONTAINER_PID=$(docker inspect --format '{{.State.Pid}}' ss13-alpha)
sudo cat "/proc/$GAME_CONTAINER_PID/uid_map"
sudo cat "/proc/$GAME_CONTAINER_PID/gid_map"
```

Replace `ss13-alpha` with a running game container. `docker exec ... id` shows the configured exec user; if the entrypoint drops privileges, use the actual DreamDaemon process's IDs instead. Confirm the resulting host IDs against existing game files with `stat -c '%u:%g' /absolute/path/to/a/game-owned-file`. Overseer writes those host IDs directly; it does not apply an additional remapping offset. Do not change Docker's daemon configuration or change the game containers to `userns_mode: host` for this setup.

The worker service mounts each storage root at the same host and container path and refuses to create missing bind sources. Mount any additional paths needed by your server wrappers as described above. It binds the API to host loopback by default; set `OVERSEER_BIND_ADDRESS` if remote access is needed. `SERVER_HOST` is overridden to `0.0.0.0` inside the container, and `SERVER_PORT` controls both the published and listening port. Increase `OVERSEER_STOP_GRACE_PERIOD` beyond the larger of your upload/restart deadlines plus the five-second application shutdown allowance if you raise those deadlines. Run one worker against shared game storage.

### Published images

GitHub Actions publishes `linux/amd64` images to `ghcr.io/goonstation/overseer` after the Node 22 and 24 CI checks pass. `.github/workflows/ci.yml` calls the reusable `.github/workflows/docker.yml` on default-branch pushes and `v*` tag pushes. Pull requests and other branches run CI without publishing. To publish manually, run **CI** through the Actions tab on the default branch or an existing `v*` tag.

- Default-branch builds publish `latest`, the branch name, and `sha-<full-commit-sha>`.
- Version tags such as `v1.2.3` publish `1.2.3`, `1.2`, and the commit tag. Prerelease versions receive their full prerelease version and commit tags. `latest` tracks the default branch.

The workflow authenticates with GitHub's built-in `GITHUB_TOKEN`; no additional registry credentials are required. Publishing has `packages: write` permission, while CI tests keep read-only repository access. Builds use pinned action revisions, OCI source labels, and GitHub Actions layer caching. If an existing package is managed separately, grant this repository Actions write access to that package. Configure the package's visibility in GitHub Packages if anonymous pulls are desired.

```sh
docker pull ghcr.io/goonstation/overseer:latest
```

The supplied `compose.production.yaml` selects the published image. Configure `OVERSEER_IMAGE` in `.env` to choose a tag or digest. Deploy Overseer initially:

```sh
docker compose -f compose.yaml -f compose.production.yaml up -d --no-build --pull always
```

After the initial deployment, run the updater below to wait for existing work before replacement.

## API

Every route requires `Authorization: Bearer <API_TOKEN>`. Responses use JSON and `Cache-Control: no-store`. Examples assume `API_TOKEN` is set in the caller's environment.

```sh
curl -H "Authorization: Bearer $API_TOKEN" \
  'http://127.0.0.1:8564/status'
```

| Method and path | Parameters | Result |
| --- | --- | --- |
| `GET /status` | Optional `server` | Map of server names to status |
| `POST /restart` | Required `server` | `202` with operation ID and polling URL |
| `GET /operations/<id>` | None | Current restart operation, or `404` if unknown/expired |
| `GET /build/check` | `server`, `buildstamp`, `byond`, `rustg` | `outdated: { game, byond, rustg }` |
| `POST /build/upload` | Required `server`; multipart files | `200` after every artifact has been published |
| `GET /maintenance` | None | Drain state, instance identity, and active upload/restart counts |

Status includes stopped containers, `health: null` for containers without a health check, `startedAt`, and `restarting`. If one container cannot be inspected, its entry has `status: "unknown"` and an error while other entries remain available. Docker listing failures produce `500`.

Build checks compare the incoming stamp against the greater of the live `game/.env.build` and pending `game/update/.env.build` stamps. Missing metadata means stamp zero; filesystem permission and other read errors are reported rather than treated as missing. Runtime checks look for the requested installed version directory.

### Restarts

```sh
curl -X POST -H "Authorization: Bearer $API_TOKEN" \
  'http://127.0.0.1:8564/restart?server=alpha'
```

The response contains `id`, `server`, `state`, `step`, timestamps, `error`, and `statusUrl`. The `Location` header provides `/operations/<id>`. Poll that URL with authentication until `state` becomes `succeeded` or `failed`.

For a running container, Overseer sends `USR2` to `DreamDaemon`, runs `./dc down`, then `./dc up -d` in the server's `game/tools/server` directory. For stopped containers it skips the signal. A failed command stops the sequence and records the failed step. A server with health `starting` or a busy target returns `409`.

`202` means the restart was accepted. `succeeded` means the command sequence completed; use `/status` to monitor game health afterward. Operation history is bounded and in memory; it expires and disappears when Overseer restarts.

### Artifact uploads

```sh
curl -H "Authorization: Bearer $API_TOKEN" \
  -F 'build=@build.tar.gz;type=application/gzip' \
  -F 'byond=@byond.zip;type=application/zip' \
  'http://127.0.0.1:8564/build/upload?server=alpha'
```

Supply one to three files, with each field name used at most once:

- `build`: game files directly at the archive root, typically including `.env.build`. Replaces `game/update` entirely, removing files absent from the new build. It does not replace the running game directory; your server's startup/update mechanism must consume `update`.
- `byond`: one or more version directories, such as `516.1666/bin/...`, installed below `BYOND_ROOT`.
- `rustg`: one or more version directories, such as `3.4.0/librust_g.so`, installed below `RUSTG_ROOT`.

Accepted media types are `application/zip` and `application/gzip` (tar.gz). The declared type selects the parser; the archive must actually parse successfully. Text fields, empty archives, unknown fields, repeated fields, encrypted ZIPs, links, special files, sparse tar files, duplicate normalized paths, absolute paths, and parent traversal are rejected. Package required runtime links as regular files. Executable bits are preserved, other file permissions become `660`, executable files and directories become `770`, and ownership comes from configuration. Archive-provided ownership and special permission bits are ignored.

Installed runtime versions are immutable: publishing an existing version returns `409`. Use a new version identifier or perform explicit operator maintenance after checking all consumers of that version.

Overseer writes each archive into a unique private `.overseer-stage-*` directory on its destination filesystem, validates and extracts it there, and waits for all files before publication. Uploads and restarts targeting the same server conflict. Shared runtime targets are also locked. Conflicting mutations receive `409`.

Each artifact is published by rename. All names are checked before publication; if a later rename fails, previously published artifacts are rolled back. A replacement temporarily moves the old `update` into staging, so readers may see a short interval without `update`. Readers outside Overseer must coordinate with deployment. A multipart batch is not a filesystem transaction and a process/power failure can interrupt publication. HTTP `200` is returned only after every artifact finishes. Ordinary failure, timeout, or disconnection cancels the upload and cleans staging. A failed rollback preserves its recovery directory and logs the path.

### Fallback databases

Upload a flat tar.gz containing files such as `main1.sqlite` and `main2.sqlite`:

```sh
curl -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/gzip' \
  --data-binary @fallbacks.tar.gz \
  http://127.0.0.1:8564/fallback/upload
```

Each file replaces `$SERVERS_ROOT/<server>/game/data/fallback.sqlite`; the server's `game` directory must already exist. Missing `data` directories are created. Files receive mode `660` and configured game ownership. Success returns `200` with `{ "message": "Success", "servers": ["main1", "main2"] }`.

The whole archive is validated first. Empty archives, nested directories, unexpected filenames, unknown servers, links, and unsafe paths reject the batch. Existing upload size, extraction, entry-count, and timeout limits apply. Uploads share server locks with builds and restarts and are included in update draining.

Supply self-contained SQLite snapshots, and ensure the destination fallback databases are not being written by the game or another process. Existing `-wal`, `-shm`, or `-journal` sidecars cause `409`; this check cannot coordinate external writers. Database contents are copied as provided, without schema or integrity validation.

Each replacement uses an atomic rename on its destination filesystem, so readers see a complete old or new file. A failed publication rolls back earlier replacements; rollback failure preserves a logged recovery directory. The batch is not a filesystem transaction: concurrent readers can observe different generations, and a process/power failure can interrupt it. Once publication commits, a later timeout during staging cleanup does not undo it.

### Errors and client migration

| Status | Meaning |
| --- | --- |
| `400` | Invalid metadata, fields, multipart body, or unsafe/corrupt archive |
| `401` | Missing or incorrect bearer token |
| `404` | Server, route, or operation not found |
| `405` | Wrong HTTP method; see `Allow` header |
| `408` | Upload deadline exceeded |
| `409` | Target busy, startup in progress, or installed version conflict |
| `413` | Compressed archive or complete request is too large |
| `415` | Unsupported archive media type |
| `500` | Internal filesystem, Docker, or subprocess failure |
| `503` | Overseer is draining or operation capacity is full; retry after the indicated delay |

Errors have `{ "message": "..." }`; internal subprocess output and paths are logged server-side instead of being returned to callers. Configure proxy body sizes and timeouts to match the service. A proxy or Node's own HTTP parser may reject a request before application JSON handling.

Clients must use bearer authentication and POST for restarts. Upload callers wait for HTTP `200` after completed publication; restart callers poll the operation URL after HTTP `202`. During updates, retry rejected `503` requests after `Retry-After` and retry connection failures once the container is available. Previously accepted malformed identifiers or link-containing runtime archives require repackaging.

## Operations and recovery

Run one instance. Keep managed storage on a local filesystem with working rename semantics. Record service errors through stderr or optional Sentry; restart errors include operation ID, server, and failed step. SIGTERM/SIGINT stop accepting requests and allow bounded in-flight work to drain, with a final forced shutdown deadline.

After a process crash or power loss, stop Overseer and other writers before inspecting `.overseer-stage-*` directories under `game`, `BYOND_ROOT`, and `RUSTG_ROOT`:

1. Inspect `game/update` and any staging `previous` directory. If `update` is missing and `previous` is the desired pending build, rename `previous` back to `update` on that filesystem.
2. Check runtime versions and pending builds against the intended release. An interrupted multipart batch may have published only some artifacts. Complete or revert that release deliberately; do not overwrite a version in use.
3. Remove abandoned staging directories only after recovering any needed `previous` or `contents` data. They are not automatically removed at startup because they may contain the only recoverable copy.
4. For a failed restart, inspect `/status`, Docker logs, and the recorded step. If the service stopped between compose down and up, use the server's `tools/server/dc` wrapper to bring it back up after diagnosing the failure.

Subprocess deadlines terminate the invoked Linux process group, including children that stay in that group. Custom `dc` scripts must not detach background mutation processes into other groups. Remote Docker actions already accepted by the daemon may continue after a CLI timeout. Check actual container state before retrying.

