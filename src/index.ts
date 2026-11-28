import { sendMail } from "./alerts";
import { brandOf } from "./brand";
import { watchErrors } from "./errors";
import { postManual } from "./manual";
import { tick } from "./monitor";
import { FAVICON, renderPage } from "./page";
import { lastCheckAt, STALE_MS, statusData } from "./status";
import { duration, MINUTE } from "./time";

const PAGE_HEADERS = {
	"content-security-policy":
		"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/api/manual") {
			if (request.method !== "POST") {
				return new Response("Only POST.", { status: 405, headers: { allow: "POST" } });
			}
			return postManual(request, env);
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Only GET.", { status: 405, headers: { allow: "GET, HEAD" } });
		}
		switch (url.pathname) {
			case "/": {
				const data = await statusData(env, Date.now());
				return new Response(renderPage(data, brandOf(env)), {
					headers: {
						...PAGE_HEADERS,
						"content-type": "text/html; charset=utf-8",
						"cache-control": "no-cache",
					},
				});
			}
			case "/api/status":
				return Response.json(await statusData(env, Date.now()), {
					headers: {
						...PAGE_HEADERS,
						"cache-control": "no-cache",
						"access-control-allow-origin": "*",
					},
				});
			// For a monitor outside Cloudflare, which sees only the status code (and on UptimeRobot's free
			// plan sends HEAD): 503 once no check has run for as long as the page calls "stopped".
			case "/api/fresh": {
				const now = Date.now();
				const at = await lastCheckAt(env);
				const fresh = at !== null && now - at <= STALE_MS;
				const text =
					at === null
						? "No check has run yet."
						: fresh
							? `Checked ${duration(now - at)} ago.`
							: `The checks have stopped: the last ran ${duration(now - at)} ago.`;
				return new Response(text, {
					status: fresh ? 200 : 503,
					headers: {
						...PAGE_HEADERS,
						"content-type": "text/plain; charset=utf-8",
						"cache-control": "no-store",
					},
				});
			}
			case "/favicon.svg":
				return new Response(FAVICON, {
					headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
				});
			default:
				return new Response("Not found.", { status: 404, headers: PAGE_HEADERS });
		}
	},

	async scheduled(controller, env) {
		const at = Math.floor(controller.scheduledTime / MINUTE) * MINUTE;
		// Side by side, so a slow check doesn't hold up the error watch, and one failing doesn't stop
		// the other.
		const [checks, watch] = await Promise.allSettled([
			tick(env, at),
			watchErrors(env, at, (subject, text) => sendMail(env, subject, text)),
		]);
		// Workers Logs keeps these: service ids, keys, outcomes and timings, never a body.
		if (checks.status === "fulfilled") {
			for (const change of checks.value.changes) console.log(JSON.stringify({ change }));
			if (checks.value.alerts.failed > 0) {
				console.error(JSON.stringify({ alertsFailed: checks.value.alerts.failed }));
			}
			// Counts only: what Track answered, and the key, are never logged.
			const { track } = checks.value;
			if (track.filed > 0 || track.noted > 0 || track.gaveUp > 0) {
				console.log(
					JSON.stringify({
						track: { filed: track.filed, noted: track.noted, gaveUp: track.gaveUp },
					}),
				);
			}
			if (track.failed > 0 || track.misconfigured) {
				console.error(
					JSON.stringify({ trackFailed: track.failed, misconfigured: track.misconfigured }),
				);
			}
		}
		if (watch.status === "fulfilled" && watch.value.ran) {
			console.log(
				JSON.stringify({
					errorWatch: watch.value.findings.map((f) => f.key),
					alerted: watch.value.alerted,
				}),
			);
		}
		const failed = [checks, watch].find((result) => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
	},
} satisfies ExportedHandler<Env>;
