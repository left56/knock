import { DurableObject } from "cloudflare:workers";

declare global {
	interface Env {
	}
}

const ROUTER_AUTH_HEADER = "X-Router-Secret";
const PHONE_AUTH_QUERY_PARAM = "key";
const MANUAL_IP_QUERY_PARAM = "ip";
const LONG_POLLING_TIMEOUT_MS = 55_000;
const IP_EXPIRATION_TIME_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

type AllowedIpRecord = {
	timestamp: number;
	location: string;
};

type AllowedIpWithTtl = {
	ip: string;
	location: string;
	ttl_ms: number;
	ttl_formatted: string;
};

type RouterResponse = {
	ips: string[];
	last_updated: number;
	status: "updated" | "timeout" | "current" | "cleaned";
};

type IpUpdateRequest = {
	ip: string;
	action: "add" | "remove";
	location: string;
	group_key: string;
};

function isValidIpAddress(value: string): boolean {
	// Accept standard IPv4 and IPv6 formats.
	// Zone identifiers are intentionally not supported.
	const ipv4 =
		/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
	const ipv6 =
		/^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(([0-9a-fA-F]{1,4}:){1,7}:)|(([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4})|(([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2})|(([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3})|(([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4})|(([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5})|([0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6}))|(:((:[0-9a-fA-F]{1,4}){1,7}|:)))(%.+)?$/;
	return ipv4.test(value) || ipv6.test(value);
}

function isIpv6Address(value: string): boolean {
	return value.includes(":");
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

function getDoStub(env: Env): DurableObjectStub<MyDurableObject> {
	return env.MY_DURABLE_OBJECT.get(env.MY_DURABLE_OBJECT.idFromName("global-ip-manager"));
}

function extractClientLocation(request: Request): string {
	const cf = request.cf as
		| (IncomingRequestCfProperties & {
				asOrganization?: string;
		  })
		| undefined;
	if (!cf) return "Unknown";

	const parts: string[] = [];
	if (cf.city) parts.push(cf.city);
	if (cf.country) parts.push(cf.country);

	let location = parts.join(", ");
	if (!location) location = "Unknown";

	if (cf.asOrganization) {
		return location === "Unknown" ? cf.asOrganization : `${location} (${cf.asOrganization})`;
	}
	if (location === "Unknown" && cf.latitude && cf.longitude) {
		return `Lat: ${cf.latitude}, Lon: ${cf.longitude}`;
	}
	return location;
}

function htmlEscape(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderHtmlPage(
	currentIp: string,
	status: string,
	ipsWithTtl: AllowedIpWithTtl[],
	showIpv4AuthButton: boolean,
): string {
	const items =
		ipsWithTtl.length === 0
			? "<p>当前没有可用 IP。</p>"
			: `<h2>当前白名单 IP</h2><ul>${ipsWithTtl
					.map(
						(item) =>
							`<li><span class="ip">${htmlEscape(item.ip)}</span><span class="location">${htmlEscape(item.location)}</span><span class="ttl" data-ttl-ms="${item.ttl_ms}">剩余 ${htmlEscape(item.ttl_formatted)}</span></li>`,
					)
					.join("")}</ul>`;

	const ipv4AuthBlock = showIpv4AuthButton
		? `<div style="margin-top:16px;padding:12px;border:1px solid #d0d7de;border-radius:8px;background:#f6f8fa;">
  <p style="margin:0 0 8px 0;">当前默认已使用 IPv6 认证。如需 IPv4，可手动触发。</p>
  <p id="ipv4Status" style="margin:0 0 8px 0;color:#57606a;">点击“使用 IPv4 认证”开始获取 IPv4 地址。</p>
  <button id="fetchIpv4Btn" type="button">使用 IPv4 认证</button>
  <button id="confirmIpv4Btn" type="button" disabled>确认并跳转 IPv4 认证</button>
</div>`
		: "";

	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>HTTP Knock 状态</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f7fb; margin: 0; padding: 20px; color: #1f2328; }
.card { max-width: 720px; margin: 0 auto; background: #fff; border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,0.08); padding: 20px; }
h1 { margin-top: 0; color: #0a58ca; }
ul { list-style: none; padding: 0; margin: 0; }
li { display: grid; grid-template-columns: 1fr 2fr auto; gap: 8px; margin-bottom: 8px; padding: 8px 10px; background: #f2f6ff; border-left: 4px solid #3d7eff; border-radius: 6px; word-break: break-all; }
.ip { font-weight: 600; color: #0a58ca; }
.location { color: #57606a; }
.ttl { color: #24292f; }
.status { margin-bottom: 16px; }
@media (max-width: 640px) { li { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="card">
  <h1>上报成功</h1>
  <p class="status">你的 IP <strong>${htmlEscape(currentIp)}</strong> 已处理，状态: <strong>${htmlEscape(status)}</strong></p>
  ${items}
  ${ipv4AuthBlock}
  <p style="margin-top:16px;color:#57606a;">提示：白名单默认有效期 10 分钟，页面每 5 分钟自动刷新一次。</p>
</div>
<script>
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => location.reload(), REFRESH_INTERVAL_MS);
const formatMs = (ms) => {
  if (ms <= 0) return "已过期";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes + "m " + seconds + "s";
};
setInterval(() => {
  document.querySelectorAll(".ttl").forEach((el) => {
    const current = Number(el.dataset.ttlMs || "0") - 1000;
    el.dataset.ttlMs = String(current);
    el.textContent = "剩余 " + formatMs(current);
  });
}, 1000);

const fetchIpv4Btn = document.getElementById("fetchIpv4Btn");
const confirmIpv4Btn = document.getElementById("confirmIpv4Btn");
const ipv4Status = document.getElementById("ipv4Status");
let pendingIpv4 = "";

if (fetchIpv4Btn && confirmIpv4Btn && ipv4Status) {
  const isIpv4 = (value) => /^(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(\\.(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}$/.test(value);
  const providers = [
    "https://ipv4.icanhazip.com",
    "https://api4.ipify.org?format=text",
  ];

  fetchIpv4Btn.addEventListener("click", async () => {
    pendingIpv4 = "";
    confirmIpv4Btn.disabled = true;
    ipv4Status.textContent = "正在获取 IPv4...";
    let lastError = "";
    for (const provider of providers) {
      try {
        const res = await fetch(provider, { method: "GET", headers: { "Accept": "text/plain" } });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const candidate = (await res.text()).trim();
        if (!isIpv4(candidate)) throw new Error("Invalid IPv4: " + candidate);
        pendingIpv4 = candidate;
        confirmIpv4Btn.disabled = false;
        ipv4Status.textContent = "已获取 IPv4: " + candidate + "。点击“确认并跳转 IPv4 认证”。";
        return;
      } catch (err) {
        lastError = (err && err.message) ? err.message : String(err);
      }
    }
    ipv4Status.textContent = "获取 IPv4 失败，请重试。错误: " + (lastError || "Unknown error");
  });

  confirmIpv4Btn.addEventListener("click", () => {
    if (!pendingIpv4) return;
    const next = new URL(location.href);
    next.searchParams.set("ip", pendingIpv4);
    location.href = next.toString();
  });
}
</script>
</body>
</html>`;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const stub = getDoStub(env);

		if (url.pathname === "/long_poll_for_ip_updates" && request.method === "GET") {
			const routerSecret = request.headers.get(ROUTER_AUTH_HEADER);
			if (!routerSecret || routerSecret.trim().length === 0) {
				return json({ error: "unauthorized" }, 401);
			}
			const since = Number(url.searchParams.get("since") ?? "0");
			return stub.fetch(
				new Request("https://do/long_poll_for_ip_updates", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ since, group_key: routerSecret }),
				}),
			);
		}

		if (url.pathname === "/get_current_ips" && request.method === "GET") {
			const routerSecret = request.headers.get(ROUTER_AUTH_HEADER);
			if (!routerSecret || routerSecret.trim().length === 0) {
				return json({ error: "unauthorized" }, 401);
			}
			return stub.fetch(
				new Request("https://do/get_current_ips_internal", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ group_key: routerSecret }),
				}),
			);
		}

		if ((url.pathname === "/" || url.pathname === "/api/report") && request.method === "GET") {
			const phoneSecret = url.searchParams.get(PHONE_AUTH_QUERY_PARAM);
			if (!phoneSecret || phoneSecret.trim().length === 0) {
				return json({ error: "unauthorized" }, 401);
			}
			const manualIp = url.searchParams.get(MANUAL_IP_QUERY_PARAM);
			if (manualIp && !isValidIpAddress(manualIp)) {
				return json(
					{
						error: "invalid_ip",
						message: `Query parameter '${MANUAL_IP_QUERY_PARAM}' is not a valid IPv4/IPv6 address.`,
					},
					400,
				);
			}

			const clientIp = manualIp ?? request.headers.get("CF-Connecting-IP");
			if (!clientIp) {
				return json({ error: "missing_client_ip" }, 400);
			}
			const showIpv4AuthButton = !manualIp && url.pathname === "/" && isIpv6Address(clientIp);

			const action = url.searchParams.get("action") === "remove" ? "remove" : "add";
			const payload: IpUpdateRequest = {
				ip: clientIp,
				action,
				location: extractClientLocation(request),
				group_key: phoneSecret,
			};

			const doResponse = await stub.fetch(
				new Request("https://do/update_single_ip", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				}),
			);
			const doData = (await doResponse.json()) as {
				status: string;
				ips_with_ttl: AllowedIpWithTtl[];
			};

			if (url.pathname === "/api/report") return json(doData, doResponse.status);

			return new Response(renderHtmlPage(clientIp, doData.status, doData.ips_with_ttl, showIpv4AuthButton), {
				headers: { "Content-Type": "text/html; charset=utf-8" },
				status: doResponse.status,
			});
		}

		return new Response(
			"HTTP Knock Worker is running. Use /?<PHONE_AUTH_QUERY_PARAM>=<secret> or /api/report?<PHONE_AUTH_QUERY_PARAM>=<secret>.",
			{
				status: 200,
				headers: { "Content-Type": "text/plain; charset=utf-8" },
			},
		);
	},
} satisfies ExportedHandler<Env>;

export class MyDurableObject extends DurableObject<Env> {
	private groupIpMaps = new Map<string, Map<string, AllowedIpRecord>>();
	private groupLastUpdated = new Map<string, number>();
	private groupPending = new Map<string, Map<number, (response: Response) => void>>();
	private nextPendingId = 1;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			const savedMaps = await this.ctx.storage.get<Record<string, [string, AllowedIpRecord][]>>("group_ip_maps");
			if (savedMaps) {
				for (const [groupKey, entries] of Object.entries(savedMaps)) {
					this.groupIpMaps.set(groupKey, new Map(entries));
				}
			}
			const savedUpdated = await this.ctx.storage.get<Record<string, number>>("group_last_updated");
			if (savedUpdated) {
				for (const [groupKey, ts] of Object.entries(savedUpdated)) {
					this.groupLastUpdated.set(groupKey, ts);
				}
			}
			this.removeExpiredIpsForAllGroups();
			await this.ensureAlarm();
		});
	}

	private formatTtl(ms: number): string {
		if (ms <= 0) return "Expired";
		const totalSeconds = Math.floor(ms / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}m ${seconds}s`;
	}

	private getIpMap(groupKey: string): Map<string, AllowedIpRecord> {
		let map = this.groupIpMaps.get(groupKey);
		if (!map) {
			map = new Map<string, AllowedIpRecord>();
			this.groupIpMaps.set(groupKey, map);
		}
		return map;
	}

	private getLastUpdated(groupKey: string): number {
		return this.groupLastUpdated.get(groupKey) ?? 0;
	}

	private getPendingMap(groupKey: string): Map<number, (response: Response) => void> {
		let pending = this.groupPending.get(groupKey);
		if (!pending) {
			pending = new Map<number, (response: Response) => void>();
			this.groupPending.set(groupKey, pending);
		}
		return pending;
	}

	private removeExpiredIps(groupKey: string): boolean {
		let changed = false;
		const now = Date.now();
		const ipMap = this.getIpMap(groupKey);
		for (const [ip, record] of ipMap.entries()) {
			if (record.timestamp + IP_EXPIRATION_TIME_MS <= now) {
				ipMap.delete(ip);
				changed = true;
			}
		}
		return changed;
	}

	private removeExpiredIpsForAllGroups(): boolean {
		let changed = false;
		for (const groupKey of this.groupIpMaps.keys()) {
			changed = this.removeExpiredIps(groupKey) || changed;
		}
		return changed;
	}

	private getNonExpiredIpsWithTtl(groupKey: string): AllowedIpWithTtl[] {
		const now = Date.now();
		const list: AllowedIpWithTtl[] = [];
		const ipMap = this.getIpMap(groupKey);
		for (const [ip, record] of ipMap.entries()) {
			const ttlMs = record.timestamp + IP_EXPIRATION_TIME_MS - now;
			if (ttlMs > 0) {
				list.push({
					ip,
					location: record.location,
					ttl_ms: ttlMs,
					ttl_formatted: this.formatTtl(ttlMs),
				});
			}
		}
		list.sort((a, b) => b.ttl_ms - a.ttl_ms);
		return list;
	}

	private getNonExpiredIps(groupKey: string): string[] {
		return this.getNonExpiredIpsWithTtl(groupKey).map((item) => item.ip);
	}

	private async persistAndBroadcast(groupKey: string, status: RouterResponse["status"]): Promise<void> {
		const now = Date.now();
		this.groupLastUpdated.set(groupKey, now);
		const serializableMaps: Record<string, [string, AllowedIpRecord][]> = {};
		for (const [key, map] of this.groupIpMaps.entries()) {
			serializableMaps[key] = Array.from(map.entries());
		}
		const serializableUpdated: Record<string, number> = {};
		for (const [key, ts] of this.groupLastUpdated.entries()) {
			serializableUpdated[key] = ts;
		}
		await this.ctx.storage.put("group_ip_maps", serializableMaps);
		await this.ctx.storage.put("group_last_updated", serializableUpdated);
		const payload: RouterResponse = {
			ips: this.getNonExpiredIps(groupKey),
			last_updated: now,
			status,
		};
		this.broadcast(groupKey, payload);
	}

	private broadcast(groupKey: string, payload: RouterResponse): void {
		const response = json(payload);
		const pending = this.getPendingMap(groupKey);
		for (const resolve of pending.values()) {
			resolve(response.clone());
		}
		pending.clear();
	}

	private async ensureAlarm(): Promise<void> {
		const alarm = await this.ctx.storage.getAlarm();
		const now = Date.now();
		if (alarm === null || alarm < now) {
			await this.ctx.storage.setAlarm(now + CLEANUP_INTERVAL_MS);
		}
	}

	async alarm(): Promise<void> {
		const cleanedGroups: string[] = [];
		for (const groupKey of this.groupIpMaps.keys()) {
			if (this.removeExpiredIps(groupKey)) {
				cleanedGroups.push(groupKey);
			}
		}
		for (const groupKey of cleanedGroups) {
			await this.persistAndBroadcast(groupKey, "cleaned");
		}
		await this.ensureAlarm();
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/get_current_ips_internal" && request.method === "POST") {
			const body = (await request.json()) as { group_key?: string };
			if (!body.group_key) return json({ error: "missing_group_key" }, 400);
			this.removeExpiredIps(body.group_key);
			return json({
				ips: this.getNonExpiredIps(body.group_key),
				last_updated: this.getLastUpdated(body.group_key),
				status: "current",
			} satisfies RouterResponse);
		}

		if (url.pathname === "/update_single_ip" && request.method === "POST") {
			const body = (await request.json()) as Partial<IpUpdateRequest>;
			if (!body.ip || typeof body.ip !== "string") {
				return json({ error: "invalid_ip" }, 400);
			}
			if (body.action !== "add" && body.action !== "remove") {
				return json({ error: "invalid_action" }, 400);
			}
			if (!body.group_key || typeof body.group_key !== "string") {
				return json({ error: "missing_group_key" }, 400);
			}
			const location = typeof body.location === "string" ? body.location : "Unknown";
			let status = "not_changed";
			const ipMap = this.getIpMap(body.group_key);

			if (body.action === "add") {
				ipMap.set(body.ip, { timestamp: Date.now(), location });
				status = "added_or_refreshed";
				await this.persistAndBroadcast(body.group_key, "updated");
			} else if (body.action === "remove") {
				const removed = ipMap.delete(body.ip);
				status = removed ? "removed" : "not_found";
				if (removed) {
					await this.persistAndBroadcast(body.group_key, "updated");
				}
			}

			return json({
				status,
				ips: this.getNonExpiredIps(body.group_key),
				ips_with_ttl: this.getNonExpiredIpsWithTtl(body.group_key),
				last_updated: this.getLastUpdated(body.group_key),
			});
		}

		if (url.pathname === "/long_poll_for_ip_updates" && request.method === "POST") {
			const body = (await request.json()) as { since?: number; group_key?: string };
			if (!body.group_key) return json({ error: "missing_group_key" }, 400);
			this.removeExpiredIps(body.group_key);
			const groupLastUpdated = this.getLastUpdated(body.group_key);

			if (typeof body.since === "number" && groupLastUpdated > body.since) {
				return json({
					ips: this.getNonExpiredIps(body.group_key),
					last_updated: groupLastUpdated,
					status: "updated",
				} satisfies RouterResponse);
			}

			return new Promise<Response>((resolve) => {
				const id = this.nextPendingId++;
				const pending = this.getPendingMap(body.group_key as string);
				const timeout = setTimeout(() => {
					pending.delete(id);
					resolve(
						json({
							ips: this.getNonExpiredIps(body.group_key as string),
							last_updated: this.getLastUpdated(body.group_key as string),
							status: "timeout",
						} satisfies RouterResponse),
					);
				}, LONG_POLLING_TIMEOUT_MS);

				pending.set(id, (response) => {
					clearTimeout(timeout);
					resolve(response);
				});
			});
		}

		return new Response("Durable Object: Not Found", { status: 404 });
	}
}
