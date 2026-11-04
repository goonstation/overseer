# Overseer

Overseer manages Docker game servers and stages game, BYOND, and rust-g artifacts through an authenticated HTTP API.

## Setup

Requires Linux and Docker Compose. Each server needs a directory at `$SERVERS_ROOT/<server>/game` with an executable `tools/server/dc` wrapper.

```sh
cp .env.example .env
openssl rand -hex 32
```

Put the generated value in `API_TOKEN`, then configure:

- `SERVERS_ROOT`, `BYOND_ROOT`, `RUSTG_ROOT`: existing absolute host paths.
- `GAME_USER_OWNER`, `GAME_USER_GROUP`: numeric host ownership IDs for game files.
- `OVERSEER_IMAGE`: production image tag or digest; defaults to `ghcr.io/goonstation/overseer:latest`.

Compose mounts storage at identical host/container paths. With `userns-remap`, use the game's **mapped host UID/GID**. Overseer alone uses `userns_mode: host` for Docker socket access and ownership changes; game containers retain their remapping.

Start the published image:

```sh
docker compose -f compose.yaml -f compose.production.yaml up -d --no-build --pull always
```

For a local build, use `docker compose up -d --build`. Run one instance per shared game storage. The API binds to host loopback on port `8564` by default; configure `OVERSEER_BIND_ADDRESS` for remote access through a trusted HTTPS endpoint.

## API

Every request requires `Authorization: Bearer <API_TOKEN>`.

| Endpoint | Purpose |
| --- | --- |
| `GET /status` | All servers, or one with `?server=...` |
| `POST /restart?server=...` | Start a restart; returns `202` and a polling URL |
| `GET /operations/<id>` | Restart progress and outcome |
| `GET /build/check` | Check artifacts using `server`, `buildstamp`, `byond`, and `rustg` |
| `POST /build/upload?server=...` | Upload artifacts; returns `200` after publication |
| `POST /fallback/upload` | Upload a flat tar.gz of `<server>.sqlite` fallback databases |
| `GET /maintenance` | Drain state and active work |

Build uploads accept multipart fields `build`, `byond`, and `rustg` containing ZIP or tar.gz archives. Builds replace `game/update`; runtime archives contain version directories, and installed versions are immutable.

See the [reference](docs/reference.md) for examples, configuration, archive rules, errors, and recovery.

## Updating

```sh
./scripts/update-overseer.sh
```

The script pulls the configured image, waits for active uploads and restarts, then replaces Overseer. New mutations receive `503` with `Retry-After` during draining; the API is briefly unavailable during replacement. Callers must retry rejected requests.

See [update and recovery instructions](docs/unattended-updates.md).

## Development

Requires Node.js 22.16 or newer.

```sh
npm ci
npm run check
npm test
npm run build
npm start
```

TypeScript sources live in `src/`, tests in `tests/`, and compiled output in `dist/`.
