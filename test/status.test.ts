import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src";
import { messageFor } from "../src/alerts";
import { checkOnce, check as checkService } from "../src/check";
import { ConfigError, type Service, servicesOf } from "../src/config";
import { type MonitorEnv, tick } from "../src/monitor";
import { percent } from "../src/page";
import { statusData } from "../src/status";
import { duration } from "../src/time";

const SITE = "https://site.test/";
const TRACK = "https://track.test/api/auth/ok";
const MINUTE = 60_000;
/** A minute on the hour, so the tests know when the old checks are cleared. */
const T0 = Date.UTC(2026, 10, 12, 14, 0);

beforeEach(async () => {
	await control("/__reset");
	await env.DB.batch(
		["check_result", "daily", "service_state", "incident"].map((table) =>
			env.DB.prepare(`DELETE FROM ${table}`),
		),
	);
});

/** Drives the stand-in for the checked services (test/target-worker.js). */
async function control(path: string, body?: unknown) {
	const response = await fetch(`https://control.test${path}`, {
		method: body === undefined ? "GET" : "POST",
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return response;
}

async function answer(
	url: string,
	how: { status?: number; body?: string; hang?: boolean; times?: number },
) {
	await control("/__set", { [url]: how });
}

/** An EMAIL binding that keeps what it was given, or fails while `failing` says so. */
function mailbox() {
	const sent: { subject: string; text: string; to: string[] }[] = [];
	const box = {
		failing: false,
		sent,
		binding: {
			async send(message: { subject: string; text: string; to: string[] }) {
				if (box.failing)
					throw Object.assign(new Error("refused"), { code: "E_SENDER_NOT_VERIFIED" });
				sent.push(message);
				return { messageId: "test" };
			},
		} as unknown as SendEmail,
	};
	return box;
}

function monitorEnv(box?: ReturnType<typeof mailbox>): MonitorEnv {
	return {
		...env,
		...(box ? { EMAIL: box.binding, ALERT_TO: "owner@example.com" } : {}),
	};
}

const run = (at: number, box?: ReturnType<typeof mailbox>) =>
	tick(monitorEnv(box), at, { retryAfter: 0 });

async function rows(sql: string) {
	return (await env.DB.prepare(sql).all()).results;
}

describe("services", () => {
	it("are read from SERVICES, with 200 expected unless it says", () => {
		expect(
			servicesOf([
				{ id: "site", name: " Website ", url: "https://gateweave.com" },
				{
					id: "track",
					name: "Track",
					url: "https://track.gateweave.com/x",
					expect: 204,
					contains: "ok",
				},
			]),
		).toEqual([
			{ id: "site", name: "Website", url: "https://gateweave.com/", expect: 200 },
			{
				id: "track",
				name: "Track",
				url: "https://track.gateweave.com/x",
				expect: 204,
				contains: "ok",
			},
		]);
	});

	it("may come as JSON text, as the dashboard sets them", () => {
		expect(servicesOf('[{"id":"a","name":"A","url":"https://a.test/"}]')).toEqual([
			{ id: "a", name: "A", url: "https://a.test/", expect: 200 },
		]);
		expect(() => servicesOf("[{")).toThrow("SERVICES is a list of services to check, as JSON.");
	});

	it("refuse a setting they can't check as written", () => {
		const good = { id: "a", name: "A", url: "https://a.test/" };
		const wrong: [unknown, string][] = [
			[[], "SERVICES is a list"],
			["{}", "SERVICES is a list"],
			[[{ ...good, id: "Big" }], "id is lower-case"],
			[[good, good], 'id "a" is there twice'],
			[[{ ...good, name: "" }], "name is a name"],
			[[{ ...good, url: "a.test" }], "url isn't a URL"],
			[[{ ...good, url: "http://a.test/" }], "url is an https URL"],
			[[{ ...good, expect: 99 }], "expect is an HTTP status"],
			[[{ ...good, contains: "" }], "contains is text"],
		];
		for (const [value, message] of wrong) {
			expect(() => servicesOf(value), message).toThrow(ConfigError);
			expect(() => servicesOf(value), message).toThrow(message);
		}
	});
});

describe("a check", () => {
	const track: Service = {
		id: "track",
		name: "Track",
		url: TRACK,
		expect: 200,
		contains: '"ok":true',
	};

	it("passes on the status and text it expects", async () => {
		expect(await checkOnce(track)).toMatchObject({
			service: "track",
			ok: true,
			status: 200,
			error: null,
		});
	});

	it("fails on another status, a redirect included, without following it", async () => {
		await answer(TRACK, { status: 307 });
		expect(await checkOnce(track)).toMatchObject({
			ok: false,
			status: 307,
			error: "Answered 307, not 200.",
		});
	});

	it("fails when the body lacks the text, and never says what the body held", async () => {
		await answer(TRACK, { body: "<h1>Maintenance: secret plans</h1>" });
		const result = await checkOnce(track);
		expect(result).toMatchObject({
			ok: false,
			status: 200,
			error: "The answer isn't the one expected.",
		});
		expect(JSON.stringify(result)).not.toContain("secret");
	});

	it("fails when no answer comes in time", async () => {
		await answer(TRACK, { hang: true });
		expect(await checkOnce(track, fetch, 50)).toMatchObject({
			ok: false,
			status: null,
			error: "No answer in 0.05 s.",
		});
	});

	it("is tried once more, so one dropped request isn't a failure", async () => {
		await answer(TRACK, { status: 502, times: 1 });
		expect(await checkService(track, fetch, { retryAfter: 0 })).toMatchObject({ ok: true });
		expect(await (await control("/__hits")).json()).toEqual({ [TRACK]: 2 });
	});
});

describe("the monitor", () => {
	it("keeps each check, counts the day, and opens no incident while services work", async () => {
		const report = await run(T0);
		expect(report).toMatchObject({ skipped: false, changes: [], alerts: { sent: 0, failed: 0 } });
		expect(report.results.map((r) => [r.service, r.ok])).toEqual([
			["site", true],
			["track", true],
		]);
		expect(
			await rows("SELECT service, at, ok, status, error FROM check_result ORDER BY service"),
		).toEqual([
			{ service: "site", at: T0, ok: 1, status: 200, error: null },
			{ service: "track", at: T0, ok: 1, status: 200, error: null },
		]);
		await run(T0 + MINUTE);
		expect(await rows("SELECT service, day, checks, failures FROM daily ORDER BY service")).toEqual(
			[
				{ service: "site", day: "2026-11-12", checks: 2, failures: 0 },
				{ service: "track", day: "2026-11-12", checks: 2, failures: 0 },
			],
		);
		expect(await rows("SELECT * FROM incident")).toEqual([]);
	});

	it("takes a service down after two failed checks, alerts once, and brings it back", async () => {
		const box = mailbox();
		await run(T0, box);
		await answer(TRACK, { status: 503 });

		// One failed check is not an incident.
		expect((await run(T0 + MINUTE, box)).changes).toEqual([]);
		expect(await rows("SELECT * FROM incident")).toEqual([]);

		const down = await run(T0 + 2 * MINUTE, box);
		expect(down.changes).toEqual([{ service: "track", to: "down", at: T0 + MINUTE }]);
		expect(await rows("SELECT service, started_at, ended_at, error FROM incident")).toEqual([
			{
				service: "track",
				started_at: T0 + MINUTE,
				ended_at: null,
				error: "Answered 503, not 200.",
			},
		]);
		expect(box.sent.map((m) => m.subject)).toEqual(["Track is down"]);
		expect(box.sent[0]?.to).toEqual(["owner@example.com"]);
		expect(box.sent[0]?.text).toContain(
			"Track has failed every check since 14:01 UTC on 12 Nov 2026.",
		);

		// Still down: nothing more is sent.
		await run(T0 + 3 * MINUTE, box);
		expect(box.sent).toHaveLength(1);

		await control("/__reset");
		const back = await run(T0 + 4 * MINUTE, box);
		expect(back.changes).toEqual([{ service: "track", to: "up", at: T0 + 4 * MINUTE }]);
		expect(await rows("SELECT ended_at FROM incident")).toEqual([{ ended_at: T0 + 4 * MINUTE }]);
		expect(box.sent.map((m) => m.subject)).toEqual(["Track is down", "Track is back up"]);
		expect(box.sent[1]?.text).toContain("Track works again since 14:04 UTC, after 3 min down");
		expect(await rows("SELECT service, failures FROM daily ORDER BY service")).toEqual([
			{ service: "site", failures: 0 },
			{ service: "track", failures: 3 },
		]);
		await run(T0 + 5 * MINUTE, box);
		expect(box.sent).toHaveLength(2);
	});

	it("tries an alert that couldn't go again, and tells an outage that ended before it went once", async () => {
		const box = mailbox();
		box.failing = true;
		await answer(TRACK, { status: 500 });
		await run(T0, box);
		expect((await run(T0 + MINUTE, box)).alerts).toEqual({ sent: 0, failed: 1 });

		await control("/__reset");
		box.failing = false;
		expect((await run(T0 + 2 * MINUTE, box)).alerts).toEqual({ sent: 1, failed: 0 });
		expect(box.sent.map((m) => m.subject)).toEqual(["Track was down for 2 min"]);
		expect(await rows("SELECT alerted_at, resolved_alerted_at FROM incident")).toEqual([
			{ alerted_at: T0 + 2 * MINUTE, resolved_alerted_at: T0 + 2 * MINUTE },
		]);
		await run(T0 + 3 * MINUTE, box);
		expect(box.sent).toHaveLength(1);
	});

	it("sends nothing, and keeps the incidents, without ALERT_TO", async () => {
		await answer(SITE, { status: 500 });
		await run(T0);
		expect((await run(T0 + MINUTE)).alerts).toEqual({ sent: 0, failed: 0 });
		expect(await rows("SELECT service, alerted_at FROM incident")).toEqual([
			{ service: "site", alerted_at: null },
		]);
	});

	it("checks a minute once, however often the cron fires for it", async () => {
		await run(T0 + 5_000);
		expect((await run(T0 + 30_000)).skipped).toBe(true);
		expect(await rows("SELECT checks FROM daily")).toEqual([{ checks: 1 }, { checks: 1 }]);
	});

	it("clears checks older than a week on the hour, and keeps the days", async () => {
		const old = T0 - 8 * 24 * 60 * MINUTE;
		await run(old);
		await run(T0 + MINUTE);
		expect(await rows("SELECT COUNT(*) AS n FROM check_result")).toEqual([{ n: 4 }]);
		await run(T0 + 60 * MINUTE);
		expect(await rows("SELECT DISTINCT at FROM check_result ORDER BY at")).toEqual([
			{ at: T0 + MINUTE },
			{ at: T0 + 60 * MINUTE },
		]);
		expect(await rows("SELECT COUNT(DISTINCT day) AS n FROM daily")).toEqual([{ n: 2 }]);
	});
});

describe("the page", () => {
	const page = async (path = "/") => worker.fetch(new Request(`https://status.test${path}`), env);

	it("says all is working, with each service's days and its share of passed checks", async () => {
		const now = Date.now();
		await run(now - MINUTE);
		const response = await page();
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
		const html = await response.text();
		expect(html).toContain("All services are working");
		expect(html).toContain("100% of checks passed");
		expect(html.match(/class="bar /g)).toHaveLength(180);
		expect(html.match(/class="bar ok"/g)).toHaveLength(2);
	});

	it("names what is down, and lists the incident", async () => {
		const now = Date.now();
		await answer(TRACK, { status: 503 });
		await run(now - 2 * MINUTE);
		await run(now - MINUTE);
		const html = await (await page()).text();
		expect(html).toContain("<h1>Track is down</h1>");
		expect(html).toContain("Answered 503, not 200.");
		const data = await (await page("/api/status")).json<{ status: string; incidents: unknown[] }>();
		expect(data.status).toBe("down");
		expect(data.incidents).toEqual([
			{
				service: "track",
				name: "Track",
				startedAt: expect.any(Number),
				endedAt: null,
				error: "Answered 503, not 200.",
			},
		]);
	});

	it("says the checks stopped when none ran for five minutes", async () => {
		await run(Date.now() - 10 * MINUTE);
		const data = await statusData(env, Date.now());
		expect(data.status).toBe("unknown");
		expect(await (await page()).text()).toContain("The checks have stopped");
	});

	it("escapes what it shows", async () => {
		// A name no real setting has, to show it can't reach the page as markup.
		const named = { ...env, SERVICES: [{ id: "x", name: "<b>X</b>", url: "https://x.test/" }] };
		await tick(named, Date.now() - MINUTE, { retryAfter: 0 });
		const response = await worker.fetch(
			new Request("https://status.test/"),
			named as unknown as Env,
		);
		const html = await response.text();
		expect(html).toContain("&lt;b&gt;X&lt;/b&gt;");
		expect(html).not.toContain("<b>X</b>");
	});

	it("answers only GET, at its own paths", async () => {
		expect((await page("/nope")).status).toBe(404);
		expect(
			(await worker.fetch(new Request("https://status.test/", { method: "POST" }), env)).status,
		).toBe(405);
		expect((await page("/favicon.svg")).headers.get("content-type")).toBe("image/svg+xml");
	});
});

describe("words", () => {
	it("give shares rounded down and durations in plain units", () => {
		expect(percent(1)).toBe("100%");
		expect(percent(0.99999)).toBe("99.99%");
		expect(percent(0.5)).toBe("50.00%");
		expect(duration(20_000)).toBe("1 min");
		expect(duration(7 * MINUTE)).toBe("7 min");
		expect(duration(125 * MINUTE)).toBe("2 h 5 min");
		expect(duration(120 * MINUTE)).toBe("2 h");
		expect(duration(28 * 60 * MINUTE)).toBe("1 d 4 h");
	});

	it("tell an open incident, an ended one, and one that ended before its alert", () => {
		const service = { name: "Track", url: TRACK };
		const base = {
			id: 1,
			service: "track",
			started_at: T0,
			error: "Answered 503, not 200.",
			resolved_alerted_at: null,
		};
		expect(
			messageFor({ ...base, ended_at: null, alerted_at: null }, service, "https://s.test").subject,
		).toBe("Track is down");
		expect(
			messageFor({ ...base, ended_at: T0 + 7 * MINUTE, alerted_at: T0 }, service, "https://s.test")
				.subject,
		).toBe("Track is back up");
		expect(
			messageFor(
				{ ...base, ended_at: T0 + 7 * MINUTE, alerted_at: null },
				service,
				"https://s.test",
			).subject,
		).toBe("Track was down for 7 min");
	});
});
