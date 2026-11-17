# Knock

Cloudflare Worker that keeps a short-lived IP allowlist, plus OpenWrt clients that sync that list into firewall sets.

A non-empty group key isolates one allowlist. Browsers pass it as `?key=`. Routers pass the same value in `X-Router-Secret`. The Worker does not store a fixed secret.

## Layout

| Path | Role |
| --- | --- |
| `src/index.ts` | Worker and Durable Object |
| `openwrt-http-knock.sh` | OpenWrt `ipset` sync (ash) |
| `openwrt-http-knock.initd` | procd service for the shell client |
| `openwrt-go/` | OpenWrt `nft`/`fw4` sync (Go) |
| `Knock敲门接口.md` | HTTP API |

## Configuration

Hosts and group keys are not stored in source. Copy `.env.example` and fill it in:

- local: `.env` (gitignored)
- OpenWrt: `/etc/knock.env`

```sh
WORKER_BASE_URL=
SHARED_SECRET_ROUTER=
```

`WORKER_BASE_URL` is the Worker origin with no path. `SHARED_SECRET_ROUTER` is the group key. Already-exported variables win over the file. Set `KNOCK_ENV_FILE` to load a different path.

The Go client also accepts `/etc/knock-sync.json`. Environment values override `worker_base_url` and `shared_secret_router` in that file. See `openwrt-go/knock-sync.example.json`.

## Worker

```bash
npm install
npx wrangler dev
npx wrangler deploy
```

Generate types after binding changes: `npm run cf-typegen`.

## OpenWrt shell client

Installs an `ipset` syncer. On the router:

```sh
cp openwrt-http-knock.sh /usr/bin/openwrt-http-knock.sh
chmod +x /usr/bin/openwrt-http-knock.sh
cp .env /etc/knock.env
chmod 600 /etc/knock.env
cp openwrt-http-knock.initd /etc/init.d/http-knock-sync
chmod +x /etc/init.d/http-knock-sync
/etc/init.d/http-knock-sync enable
/etc/init.d/http-knock-sync start
```

## OpenWrt Go client

Syncs into fw4 `nft` sets `knock_ipv4` and `knock_ipv6`. Build and install steps are in `openwrt-go/README.md`.

Do not commit the compiled binaries.

## API

See `Knock敲门接口.md`. Sample addresses in that document are documentation prefixes (`203.0.113.0/24`, `2001:db8::/32`), not live hosts.
