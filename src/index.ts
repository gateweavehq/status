import { sendMail } from "./alerts";
import { watchErrors } from "./errors";
import { tick } from "./monitor";
import { FAVICON, renderPage } from "./page";
import { statusData } from "./status";
import { MINUTE } from "./time";

const PAGE_HEADERS = {
	"content-security-policy":
		"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Only GET.", { status: 405, headers: { allow: "GET, HEAD" } });
		}
		switch (url.pathname) {
			case "/": {
				const data = await statusData(env, Date.now());
				return new Response(renderPage(data), {
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
