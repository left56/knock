## knock-sync (Go)

OpenWrt daemon that long-polls your Worker and syncs IPs into fw4-managed `nft` sets:
- IPv4 -> `knock_ipv4`
- IPv6 -> `knock_ipv6`

`redirect`/`rule` should reference these sets in `/etc/config/firewall`.
Do not use legacy `ipset` CLI mode with this version.

### Build

```bash
cd openwrt-go
GOOS=linux GOARCH=mipsle GOMIPS=softfloat go build -trimpath -ldflags="-s -w" -o knock-sync .
```

Adjust `GOARCH`/`GOMIPS` to your router CPU.

### Install on OpenWrt

```bash
cp knock-sync /usr/bin/knock-sync
chmod +x /usr/bin/knock-sync
cp knock-sync.example.json /etc/knock-sync.json
cp knock-sync.initd /etc/init.d/knock-sync
chmod +x /etc/init.d/knock-sync
```

Copy `../.env.example` to `/etc/knock.env` (`chmod 600`) and fill in `WORKER_BASE_URL` and `SHARED_SECRET_ROUTER`. Those two variables override the same fields in `/etc/knock-sync.json`, so the JSON file can leave them empty. `KNOCK_ENV_FILE` selects a different env file.

Also ensure firewall defines the sets, for example:

```bash
uci add firewall ipset
uci set firewall.@ipset[-1].name='knock_ipv4'
uci set firewall.@ipset[-1].family='ipv4'
uci set firewall.@ipset[-1].match='src_ip'
uci add firewall ipset
uci set firewall.@ipset[-1].name='knock_ipv6'
uci set firewall.@ipset[-1].family='ipv6'
uci set firewall.@ipset[-1].match='src_ip'
uci commit firewall
service firewall restart
```

### Run

```bash
/etc/init.d/knock-sync enable
/etc/init.d/knock-sync start
```
