// A stand-in for the services the Worker checks, which every fetch the tests' Worker makes reaches
// (vitest.config.ts). Each URL answers 200 with {"ok":true} until a test says otherwise.
//
// Tests drive it at https://control.test: POST /__set with {"<url>": {status, body, hang, delay,
// times}} makes that URL answer so (`hang` answers 5 s late, `delay` that many milliseconds late;
// `times` limits it to the next N requests),
// /__reset forgets every answer and count, GET /__hits says how often each URL was asked, and
// GET /__last?url=<url> gives the last POST to it: its authorization header and body.

const answers = new Map();
const hits = new Map();
const last = new Map();

export default {
	async fetch(request) {
		const url = new URL(request.url);
		if (url.host === "control.test") {
			switch (url.pathname) {
				case "/__set":
					for (const [target, answer] of Object.entries(await request.json())) {
						answers.set(target, answer);
					}
					return new Response("ok");
				case "/__reset":
					answers.clear();
					hits.clear();
					last.clear();
					return new Response("ok");
				case "/__hits":
					return Response.json(Object.fromEntries(hits));
				case "/__last":
					return Response.json(last.get(url.searchParams.get("url")) ?? null);
			}
			return new Response("no such control", { status: 404 });
		}
		hits.set(url.href, (hits.get(url.href) ?? 0) + 1);
		if (request.method === "POST") {
			last.set(url.href, {
				authorization: request.headers.get("authorization"),
				body: await request.json(),
			});
		}
		const answer = answers.get(url.href);
		if (answer?.times !== undefined) {
			answer.times--;
			if (answer.times <= 0) answers.delete(url.href);
		}
		// Late rather than never: workerd cancels a request that can never be answered.
		if (answer?.hang) await new Promise((done) => setTimeout(done, 5_000));
		if (answer?.delay) await new Promise((done) => setTimeout(done, answer.delay));
		return new Response(answer?.body ?? '{"ok":true}', {
			status: answer?.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	},
};
