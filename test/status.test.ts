import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src";
import { messageFor } from "../src/alerts";
import { brandOf, userAgentOf } from "../src/brand";
import { checkOnce, check as checkService } from "../src/check";
import { ConfigError, type Service, servicesOf } from "../src/config";
import { errorWatchOf, LAG_MS, QUIET_MS, WINDOW_MS, watchErrors } from "../src/errors";
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
		["check_result", "daily", "service_state", "incident", "error_alert"].map((table) =>
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
	how: { status?: number; body?: string; hang?: boolean; delay?: number; times?: number },
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

/** The line for slow in these tests, well under the stand-in's delay and well over its answers. */
const SLOW = 150;

const run = (at: number, box?: ReturnType<typeof mailbox>) =>
	tick(monitorEnv(box), at, { retryAfter: 0, slowMs: SLOW });

/** Runs the minutes from `from`, one check each. */
async function runs(from: number, count: number, box?: ReturnType<typeof mailbox>) {
	const reports = [];
	for (let i = 0; i < count; i++) reports.push(await run(from + i * MINUTE, box));
	return reports;
}

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

	it("calls a service slow after five slow answers in a row, alerts once, and when it is quick again", async () => {
		const box = mailbox();
		await answer(TRACK, { delay: SLOW + 150 });

		// Four slow answers are not a spell yet.
		const first = await runs(T0, 4, box);
		expect(first.flatMap((r) => r.changes)).toEqual([]);
		expect(await rows("SELECT * FROM incident")).toEqual([]);

		const slow = await run(T0 + 4 * MINUTE, box);
		expect(slow.changes).toEqual([{ service: "track", to: "slow", at: T0 }]);
		expect(await rows("SELECT service, kind, started_at, ended_at FROM incident")).toEqual([
			{ service: "track", kind: "slow", started_at: T0, ended_at: null },
		]);
		const [spell] = await rows("SELECT error FROM incident");
		expect(spell?.error).toMatch(/^Answered in \d+\.\d s\.$/);
		expect(box.sent.map((m) => m.subject)).toEqual(["Track is slow"]);
		expect(box.sent[0]?.text).toContain(
			"Track has taken more than 3 s to answer every check since 14:00 UTC on 12 Nov 2026.",
		);
		// It still works: no check failed, and the page says slow, not down.
		expect(await rows("SELECT failures FROM daily WHERE service = 'track'")).toEqual([
			{ failures: 0 },
		]);
		expect((await statusData(env, T0 + 4 * MINUTE + 1000)).status).toBe("slow");

		// Two answers in time aren't enough to end it; the third is.
		await control("/__reset");
		expect((await runs(T0 + 5 * MINUTE, 2, box)).flatMap((r) => r.changes)).toEqual([]);
		const quick = await run(T0 + 7 * MINUTE, box);
		expect(quick.changes).toEqual([{ service: "track", to: "quick", at: T0 + 5 * MINUTE }]);
		expect(await rows("SELECT ended_at FROM incident")).toEqual([{ ended_at: T0 + 5 * MINUTE }]);
		expect(box.sent.map((m) => m.subject)).toEqual([
			"Track is slow",
			"Track answers quickly again",
		]);
		expect(box.sent[1]?.text).toContain(
			"Track answers in time again since 14:05 UTC, after 5 min slow (from 14:00 UTC on 12 Nov 2026).",
		);
		expect((await statusData(env, T0 + 7 * MINUTE + 1000)).status).toBe("up");
	});

	it("ends a slow spell when the service goes down, and leaves the telling to the outage", async () => {
		const box = mailbox();
		await answer(TRACK, { delay: SLOW + 150 });
		await runs(T0, 5, box);
		await answer(TRACK, { status: 503 });
		const reports = await runs(T0 + 5 * MINUTE, 2, box);
		expect(reports.flatMap((r) => r.changes)).toEqual([
			{ service: "track", to: "down", at: T0 + 5 * MINUTE },
		]);
		expect(
			await rows("SELECT kind, started_at, ended_at FROM incident ORDER BY started_at"),
		).toEqual([
			{ kind: "slow", started_at: T0, ended_at: T0 + 5 * MINUTE },
			{ kind: "down", started_at: T0 + 5 * MINUTE, ended_at: null },
		]);
		expect(box.sent.map((m) => m.subject)).toEqual(["Track is slow", "Track is down"]);

		// Back up and quick: only the outage's end is told.
		await control("/__reset");
		await runs(T0 + 7 * MINUTE, 3, box);
		expect(box.sent.map((m) => m.subject)).toEqual([
			"Track is slow",
			"Track is down",
			"Track is back up",
		]);
		expect(await rows("SELECT * FROM incident WHERE ended_at IS NULL")).toEqual([]);
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

describe("the error watch", () => {
	const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
	/** A quarter hour, when the watch runs. */
	const Q = Date.UTC(2026, 10, 12, 14, 15);

	/**
	 * What the analytics answer: requests and 5xx per host, and invocations and errors per Worker
	 * and per Worker's Durable Objects.
	 */
	async function analytics({
		hosts = {},
		failed = {},
		workers = {},
		objects = {},
	}: {
		hosts?: Record<string, number>;
		failed?: Record<string, Record<number, number>>;
		workers?: Record<string, Record<string, [number, number]>>;
		objects?: Record<string, Record<string, [number, number]>>;
	}) {
		const rows = (byScript: Record<string, Record<string, [number, number]>>) =>
			Object.entries(byScript).flatMap(([scriptName, statuses]) =>
				Object.entries(statuses).map(([status, [requests, errors]]) => ({
					dimensions: { scriptName, status },
					sum: { requests, errors },
				})),
			);
		const data = {
			viewer: {
				accounts: [
					{
						workersInvocationsAdaptive: rows(workers),
						durableObjectsInvocationsAdaptiveGroups: rows(objects),
					},
				],
				zones: [
					{
						all: Object.entries(hosts).map(([host, count]) => ({
							count,
							dimensions: { clientRequestHTTPHost: host },
						})),
						failed: Object.entries(failed).flatMap(([host, statuses]) =>
							Object.entries(statuses).map(([status, count]) => ({
								count,
								dimensions: { clientRequestHTTPHost: host, edgeResponseStatus: Number(status) },
							})),
						),
					},
				],
			},
		};
		await answer(GRAPHQL, { body: JSON.stringify({ data, errors: null }) });
	}

	function watchEnv() {
		return { ...env, ANALYTICS_TOKEN: "analytics-token" };
	}

	/** Runs the watch, sending alerts into `sent`, or failing to while `refuse` is set. */
	function watcher() {
		const sent: { subject: string; text: string }[] = [];
		const state = { refuse: false };
		const watch = (at: number) =>
			watchErrors(watchEnv(), at, async (subject, text) => {
				if (state.refuse) throw new Error("refused");
				sent.push({ subject, text });
			});
		return { sent, state, watch };
	}

	it("reads the settings, and refuses ones it can't use", () => {
		expect(errorWatchOf(undefined)).toBeUndefined();
		expect(errorWatchOf("")).toBeUndefined();
		const account = "0".repeat(32);
		expect(errorWatchOf(JSON.stringify({ account, zone: account, hosts: ["a.test"] }))).toEqual({
			account,
			zone: account,
			hosts: ["a.test"],
			scripts: [],
			minErrors: 10,
			minShare: 0.05,
		});
		const good = { account, zone: account, hosts: ["a.test"] };
		// The ids may come from secrets instead, and the setting's own win.
		const other = "1".repeat(32);
		const bare = JSON.stringify({ hosts: ["a.test"] });
		expect(errorWatchOf(bare, { account, zone: other })).toMatchObject({ account, zone: other });
		expect(errorWatchOf(JSON.stringify(good), { account: other, zone: other })).toMatchObject({
			account,
			zone: account,
		});
		expect(() => errorWatchOf(bare)).toThrow("account is the account's id");
		expect(() => errorWatchOf(bare, { account })).toThrow("zone is the zone's id");
		const wrong: [unknown, string][] = [
			["{", "ERROR_WATCH is an object, as JSON."],
			[[], "ERROR_WATCH is an object."],
			[{ ...good, account: "acct" }, "account is the account's id"],
			[{ ...good, zone: 1 }, "zone is the zone's id"],
			[{ ...good, hosts: ["A Host"] }, "hosts is a list of names"],
			[{ account, zone: account }, "names no host and no script"],
			[{ ...good, minErrors: 0 }, "minErrors is a whole number"],
			[{ ...good, minShare: 2 }, "minShare is a share"],
		];
		for (const [value, message] of wrong) {
			expect(() => errorWatchOf(value), message).toThrow(ConfigError);
			expect(() => errorWatchOf(value), message).toThrow(message);
		}
	});

	it("runs on the quarter hours only, and asks about the 15 minutes that ended two minutes ago", async () => {
		const { watch } = watcher();
		await analytics({});
		expect((await watch(Q + MINUTE)).ran).toBe(false);
		expect(await watch(Q)).toEqual({ ran: true, findings: [], alerted: [] });
		const last = await (await control(`/__last?url=${encodeURIComponent(GRAPHQL)}`)).json<{
			authorization: string;
			body: { variables: Record<string, string> };
		}>();
		expect(last.authorization).toBe("Bearer analytics-token");
		expect(last.body.variables).toEqual({
			account: "00000000000000000000000000000001",
			zone: "00000000000000000000000000000002",
			start: new Date(Q - LAG_MS - WINDOW_MS).toISOString(),
			end: new Date(Q - LAG_MS).toISOString(),
		});
	});

	it("doesn't run without its token", async () => {
		expect((await watchErrors(env, Q, async () => {})).ran).toBe(false);
	});

	it("alerts when a host's 5xx cross both lines, ports and all, and not again for six hours", async () => {
		const { sent, watch } = watcher();
		await analytics({
			hosts: { "track.test": 150, "track.test:443": 50, "site.test": 400, "other.test": 999 },
			// site.test: 12 errors but 3%; other.test isn't watched.
			failed: {
				"track.test": { 500: 9 },
				"track.test:443": { 503: 3 },
				"site.test": { 502: 12 },
				"other.test": { 500: 500 },
			},
		});
		const report = await watch(Q);
		expect(report.findings.map((f) => f.key)).toEqual(["http:track.test"]);
		expect(sent).toEqual([
			{
				subject: "Errors on track.test",
				text: expect.stringContaining(
					"track.test answered 12 of 200 requests with a 5xx (6%) between 13:58 and 14:13 UTC: 500 ×9, 503 ×3.",
				),
			},
		]);
		expect(await watch(Q + WINDOW_MS)).toMatchObject({ alerted: [] });
		expect(sent).toHaveLength(1);
		expect((await watch(Q + QUIET_MS)).alerted).toEqual(["http:track.test"]);
		expect(
			await rows("SELECT key, errors, total, sent_at FROM error_alert ORDER BY window_end"),
		).toEqual([
			{ key: "http:track.test", errors: 12, total: 200, sent_at: Q },
			{ key: "http:track.test", errors: 12, total: 200, sent_at: null },
			{ key: "http:track.test", errors: 12, total: 200, sent_at: Q + QUIET_MS },
		]);
	});

	it("alerts when a Worker's failures cross the lines, by what failed", async () => {
		const { sent, watch } = watcher();
		await analytics({
			hosts: { "track.test": 1000 },
			failed: { "track.test": { 500: 60 } },
			workers: {
				"track-worker": {
					success: [180, 0],
					scriptThrewException: [15, 15],
					exceededResources: [5, 5],
				},
			},
		});
		await watch(Q);
		expect(sent.map((m) => m.subject)).toEqual(["Errors on 2 services"]);
		expect(sent[0]?.text).toContain(
			"The Worker track-worker failed 20 of 200 invocations (10%) between 13:58 and 14:13 UTC: scriptThrewException ×15, exceededResources ×5.",
		);
	});

	it("counts a Durable Object's failures, but not clients that went away", async () => {
		const { sent, watch } = watcher();
		await analytics({
			objects: {
				"track-worker": {
					success: [100, 0],
					clientDisconnected: [400, 400],
					exceededCpu: [30, 30],
				},
			},
		});
		const report = await watch(Q);
		expect(report.findings.map((f) => [f.key, f.errors, f.total])).toEqual([
			["objects-errors:track-worker", 30, 530],
		]);
		expect(sent[0]).toEqual({
			subject: "Errors on track-worker",
			text: expect.stringContaining(
				"The Durable Objects of track-worker failed 30 of 530 invocations (6%)",
			),
		});
	});

	it("doesn't count a Durable Object's response stream disconnects, but counts its errors", async () => {
		const { sent, watch } = watcher();
		// Growth's MCP object between 07:43 and 07:58 UTC on 2026-11-21: one disconnect for each
		// request it answered, one session's cleanup and one alarm reset by a deploy.
		await analytics({
			objects: {
				"track-worker": {
					success: [98, 0],
					responseStreamDisconnected: [17, 17],
					internalError: [1, 1],
					scriptThrewException: [1, 1],
				},
			},
		});
		const report = await watch(Q);
		expect(report.findings).toEqual([]);
		expect(sent).toEqual([]);

		await analytics({
			objects: {
				"track-worker": {
					success: [100, 0],
					responseStreamDisconnected: [20, 20],
					internalError: [12, 12],
				},
			},
		});
		expect((await watch(Q + WINDOW_MS)).alerted).toEqual(["objects-errors:track-worker"]);
		expect(sent[0]?.subject).toBe("Errors on track-worker");
		expect(sent[0]?.text).toContain(
			"The Durable Objects of track-worker failed 12 of 132 invocations (9%)",
		);
		expect(sent[0]?.text).not.toContain("disconnect");
	});

	it("alerts for stream disconnects without starting the Worker's error quiet time", async () => {
		const { sent, watch } = watcher();
		await env.DB.prepare(
			"INSERT INTO error_alert (key, window_end, errors, total, text, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
		)
			.bind("worker:track-worker", Q - WINDOW_MS - LAG_MS, 22, 122, "Combined alert", Q - WINDOW_MS)
			.run();
		await analytics({
			workers: {
				"track-worker": {
					success: [100, 0],
					responseStreamDisconnected: [20, 20],
					internalError: [2, 2],
				},
			},
		});
		const report = await watch(Q);
		expect(report.alerted).toEqual(["worker-streams:track-worker"]);
		expect(report.findings.map(({ key, errors, total }) => [key, errors, total])).toEqual([
			["worker-streams:track-worker", 20, 122],
		]);
		expect(sent[0]?.subject).toBe("Response stream disconnects on track-worker");
		expect(sent[0]?.text).toContain("20 response stream disconnects in 122 invocations (16%)");
		expect(sent[0]?.text).toContain("Other errors in this window: internalError ×2.");

		await analytics({
			workers: {
				"track-worker": {
					success: [100, 0],
					responseStreamDisconnected: [20, 20],
					internalError: [12, 12],
				},
			},
		});
		expect((await watch(Q + WINDOW_MS)).alerted).toEqual(["worker-errors:track-worker"]);
		expect(sent[1]?.subject).toBe("Errors on track-worker");
		expect(sent[1]?.text).toContain("failed 12 of 132 invocations (9%)");
		expect(sent[1]?.text).not.toContain("responseStreamDisconnected");
		expect((await watch(Q + 2 * WINDOW_MS)).alerted).toEqual([]);
		expect((await watch(Q + QUIET_MS)).alerted).toEqual(["worker-streams:track-worker"]);
	});

	it("keeps alerting for a combined Worker spike when both categories are below the threshold", async () => {
		const { sent, watch } = watcher();
		await analytics({
			workers: {
				"track-worker": {
					success: [88, 0],
					responseStreamDisconnected: [6, 6],
					internalError: [6, 6],
				},
			},
		});
		expect((await watch(Q)).alerted).toEqual(["worker-mixed:track-worker"]);
		expect(sent[0]?.subject).toBe("Errors and response stream disconnects on track-worker");
		expect(sent[0]?.text).toContain(
			"6 errors and 6 response stream disconnects in 100 invocations",
		);

		await analytics({
			workers: {
				"track-worker": {
					success: [80, 0],
					responseStreamDisconnected: [10, 10],
					internalError: [10, 10],
				},
			},
		});
		expect((await watch(Q + WINDOW_MS)).alerted).toEqual([
			"worker-errors:track-worker",
			"worker-streams:track-worker",
		]);
		expect(sent[1]?.subject).toBe("Status alerts");
		expect(sent[1]?.text).toContain("failed 10 of 100 invocations");
		expect(sent[1]?.text).toContain("10 response stream disconnects in 100 invocations");
	});

	it("says when it can't read the analytics, once in six hours", async () => {
		const { sent, watch } = watcher();
		await answer(GRAPHQL, { status: 403, body: "{}" });
		expect((await watch(Q)).alerted).toEqual(["watch"]);
		expect(sent[0]).toEqual({
			subject: "The error watch couldn't run",
			text: expect.stringContaining(
				"The error watch couldn't run: The analytics API answered 403.",
			),
		});
		await answer(GRAPHQL, {
			body: JSON.stringify({
				data: null,
				errors: [{ message: "not authorized for that account" }],
			}),
		});
		await watch(Q + WINDOW_MS);
		expect(sent).toHaveLength(1);
		expect(await rows("SELECT text FROM error_alert ORDER BY window_end")).toEqual([
			{ text: "The error watch couldn't run: The analytics API answered 403." },
			{
				text: "The error watch couldn't run: The analytics API refused the query: not authorized for that account",
			},
		]);
	});

	it("tries again on the next quarter hour when the alert couldn't go", async () => {
		const { sent, state, watch } = watcher();
		await analytics({ hosts: { "track.test": 20 }, failed: { "track.test": { 500: 20 } } });
		state.refuse = true;
		expect((await watch(Q)).alerted).toEqual([]);
		state.refuse = false;
		expect((await watch(Q + WINDOW_MS)).alerted).toEqual(["http:track.test"]);
		expect(sent).toHaveLength(1);
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
				kind: "down",
				startedAt: expect.any(Number),
				endedAt: null,
				error: "Answered 503, not 200.",
			},
		]);
	});

	it("names what is slow, with how long it took, and lists the spell", async () => {
		const now = Date.now();
		await answer(TRACK, { delay: SLOW + 150 });
		await runs(now - 5 * MINUTE, 5);
		const html = await (await page()).text();
		expect(html).toContain("<h1>Track is slow</h1>");
		expect(html).toMatch(
			/<span class="state slow"><span class="dot"><\/span>Slow · \d+ ms<\/span>/,
		);
		expect(html).toMatch(/<strong>Track<\/strong> slow since /);
	});

	it("says the checks stopped when none ran for five minutes", async () => {
		await run(Date.now() - 10 * MINUTE);
		const data = await statusData(env, Date.now());
		expect(data.status).toBe("unknown");
		expect(await (await page()).text()).toContain("The checks have stopped");
	});

	it("tells a monitor outside by its status alone whether the checks still run", async () => {
		const empty = await page("/api/fresh");
		expect(empty.status).toBe(503);
		expect(await empty.text()).toBe("No check has run yet.");

		await run(Date.now() - MINUTE);
		const fresh = await page("/api/fresh");
		expect(fresh.status).toBe(200);
		expect(fresh.headers.get("cache-control")).toBe("no-store");
		expect(await fresh.text()).toMatch(/^Checked \d+ min ago\.$/);
		// UptimeRobot's free plan asks with HEAD.
		const head = await worker.fetch(
			new Request("https://status.test/api/fresh", { method: "HEAD" }),
			env,
		);
		expect(head.status).toBe(200);

		await env.DB.prepare("UPDATE service_state SET checked_at = ?1")
			.bind(Date.now() - 10 * MINUTE)
			.run();
		const stopped = await page("/api/fresh");
		expect(stopped.status).toBe(503);
		expect(await stopped.text()).toBe("The checks have stopped: the last ran 10 min ago.");
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

describe("manual entries", () => {
	const KEY = "test-manual-key-with-at-least-32-chars";
	const signed = (body: unknown, key = KEY) =>
		worker.fetch(
			new Request("https://status.test/api/manual", {
				method: "POST",
				headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
			{ ...env, MANUAL_KEY: KEY } as Env,
		);

	it("is off without a key, and refuses a wrong one", async () => {
		const off = await worker.fetch(
			new Request("https://status.test/api/manual", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
			env,
		);
		expect(off.status).toBe(404);
		expect((await signed({ action: "post" }, "wrong")).status).toBe(401);
	});

	it("posts a manual incident, shows it as down, ends it, and alerts once", async () => {
		const box = mailbox();
		const now = Date.now();
		await run(now - MINUTE, box);
		const posted = await signed({
			kind: "incident",
			service: "track",
			text: "Customers can't sign in <yet>.",
			startedAt: now - 30_000,
		});
		expect(posted.status).toBe(201);
		const { id } = await posted.json<{ id: number }>();
		expect(await rows("SELECT service, kind, started_at, ended_at, error FROM incident")).toEqual([
			{
				service: "track",
				kind: "manual",
				started_at: now - 30_000,
				ended_at: null,
				error: "Customers can't sign in <yet>.",
			},
		]);

		let data = await statusData(env, now);
		expect(data.status).toBe("down");
		expect(data.services.find((service) => service.id === "track")).toMatchObject({
			status: "down",
			since: now - 30_000,
		});
		const html = await (await worker.fetch(new Request("https://status.test/"), env)).text();
		expect(html).toContain("manual incident since");
		expect(html).toContain("Customers can't sign in &lt;yet&gt;.");
		expect(html).not.toContain("<yet>");

		await run(now, box);
		expect(box.sent.map((message) => message.subject)).toEqual(["Track incident"]);
		expect((await signed({ action: "end", id: id + 1, endedAt: now })).status).toBe(404);
		expect((await signed({ action: "end", id, endedAt: now })).status).toBe(200);
		await run(now + MINUTE, box);
		expect(box.sent.map((message) => message.subject)).toEqual([
			"Track incident",
			"Track incident ended",
		]);
		data = await statusData(env, now + MINUTE);
		expect(data.status).toBe("up");
	});

	it("posts a maintenance window without changing the service's health", async () => {
		const now = Date.now();
		await run(now - MINUTE);
		const posted = await signed({
			kind: "maintenance",
			service: "site",
			text: "Database upgrade.",
			startedAt: now + 2 * 60 * MINUTE,
			endedAt: now + 3 * 60 * MINUTE,
		});
		expect(posted.status).toBe(201);
		const data = await statusData(env, now);
		expect(data.status).toBe("up");
		expect(data.incidents[0]).toMatchObject({ kind: "maintenance", service: "site" });
		const html = await (await worker.fetch(new Request("https://status.test/"), env)).text();
		expect(html).toContain("maintenance planned for");
	});

	it("refuses entries it can't show as written", async () => {
		const now = Date.now();
		for (const [body, message] of [
			[{ kind: "incident", service: "nope", text: "x" }, "service is not one of SERVICES"],
			[{ kind: "incident", service: "site", text: "" }, "text is 1 to 500"],
			[
				{ kind: "incident", service: "site", text: "x", startedAt: now + 2 * MINUTE },
				"An incident does not start in the future",
			],
			[
				{ kind: "maintenance", service: "site", text: "x", startedAt: now },
				"Maintenance needs endedAt",
			],
			[
				{ kind: "maintenance", service: "site", text: "x", startedAt: now, endedAt: now },
				"endedAt is after startedAt",
			],
		] as const) {
			const response = await signed(body);
			expect(response.status).toBe(400);
			expect((await response.json<{ error: string }>()).error).toContain(message);
		}
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
			kind: "down" as const,
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
		const slow = { ...base, kind: "slow" as const, error: "Answered in 4.8 s." };
		const open = messageFor(
			{ ...slow, ended_at: null, alerted_at: null },
			service,
			"https://s.test",
		);
		expect(open.subject).toBe("Track is slow");
		expect(open.text).toContain("When it turned slow: Answered in 4.8 s.");
		expect(
			messageFor({ ...slow, ended_at: T0 + 7 * MINUTE, alerted_at: T0 }, service, "https://s.test")
				.subject,
		).toBe("Track answers quickly again");
		expect(
			messageFor(
				{ ...slow, ended_at: T0 + 7 * MINUTE, alerted_at: null },
				service,
				"https://s.test",
			).subject,
		).toBe("Track was slow for 7 min");
	});
});

describe("branding", () => {
	const incident = {
		id: 1,
		service: "track",
		kind: "down" as const,
		started_at: T0,
		ended_at: null,
		error: "Answered 503, not 200.",
		alerted_at: null,
		resolved_alerted_at: null,
	};

	it("has neutral defaults that name no one", () => {
		const brand = brandOf({});
		expect(brand).toMatchObject({ name: "Status", pageUrl: undefined, homeUrl: undefined });
		expect(userAgentOf({})).toBe("StatusMonitor/1");
		const { text } = messageFor(incident, { name: "Track", url: TRACK }, undefined);
		expect(text).not.toContain("Gateweave");
		expect(text).not.toContain("Status:");
		expect(text.endsWith("Status checks every minute.")).toBe(true);
	});

	it("drops a PAGE_URL or HOME_URL that is not http(s)", async () => {
		const settings = { PAGE_URL: "javascript:alert(1)", HOME_URL: "ftp://acme.test/" };
		expect(brandOf(settings)).toMatchObject({ pageUrl: undefined, homeUrl: undefined });
		expect(brandOf({ PAGE_URL: "not a url" }).pageUrl).toBeUndefined();
		expect(userAgentOf(settings)).toBe("StatusMonitor/1");
		const html = await (
			await worker.fetch(new Request("https://status.test/"), { ...env, ...settings })
		).text();
		expect(html).not.toContain("javascript:");
		expect(html).not.toContain("ftp://");
	});

	it("takes the name, address and links from settings", async () => {
		const settings = {
			PAGE_NAME: "Acme Status",
			PAGE_DESCRIPTION: "Is Acme up?",
			PAGE_URL: "https://status.acme.test",
			HOME_URL: "https://acme.test",
		};
		expect(userAgentOf(settings)).toBe("StatusMonitor/1 (+https://status.acme.test/)");
		const { text } = messageFor(
			incident,
			{ name: "Track", url: TRACK },
			"https://status.acme.test/",
			"Acme Status",
		);
		expect(text).toContain("Status: https://status.acme.test/");
		expect(text.endsWith("Acme Status checks every minute.")).toBe(true);
		const html = await (
			await worker.fetch(new Request("https://status.test/"), { ...env, ...settings })
		).text();
		expect(html).toContain("<title>Acme Status</title>");
		expect(html).toContain('content="Is Acme up?"');
		expect(html).toContain('href="https://acme.test/"');
		expect(html).not.toContain("Gateweave");
	});
});
