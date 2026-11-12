import { tick } from "./monitor";
import { FAVICON, renderPage } from "./page";
import { statusData } from "./status";

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
		const report = await tick(env, controller.scheduledTime);
		// Workers Logs keeps this: service ids, outcomes and timings, never a body.
		for (const change of report.changes) console.log(JSON.stringify({ change }));
		if (report.alerts.failed > 0)
			console.error(JSON.stringify({ alertsFailed: report.alerts.failed }));
	},
} satisfies ExportedHandler<Env>;
