import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { servicesOf } from "../src/config";
import { type MonitorEnv, tick } from "../src/monitor";
import { fileIncidents, SLOW_FILE_AFTER_MS, TRACK_RETRY_MS, trackOf } from "../src/track";

const TRACK = "https://track.test/api/auth/ok";
const TRACK_ENDPOINT = "https://track-issues.test/mcp";
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 12, 14, 0);
/** Looks like an agent member's key: gwt_ and 43 characters. */
const KEY = `gwt_${"k9Qx_-".repeat(8).slice(0, 43)}`;
const SLOW = 150;

interface Call {
	name: string;
	args: Record<string, unknown>;
	authorization: string | null;
	signal: AbortSignal | null | undefined;
}

/**
 * A stand-in for Track's /mcp, which the Worker reaches through the `send` it is given. It keeps
 * the issues and comments it was asked for, and fails the way a test says.
 */
function fakeTrack() {
	const fake = {
		calls: [] as Call[],
		issues: [] as { key: string; title: string; description: string; priority: string }[],
		comments: [] as { key: string; body: string }[],
		/** An HTTP status to answer, or "network" to fail like a dropped connection. */
		failing: undefined as number | "network" | undefined,
		/** Make the issue, then fail as if the answer got lost. */
		loseNextAnswer: false,
		send: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url !== TRACK_ENDPOINT) return fetch(input, init);
			const body = JSON.parse(String(init?.body)) as {
				method: string;
				params: { name: string; arguments: Record<string, unknown> };
			};
			const headers = new Headers(init?.headers);
			fake.calls.push({
				name: body.params.name,
				args: body.params.arguments,
				authorization: headers.get("authorization"),
				signal: init?.signal,
			});
			if (fake.failing === "network") throw new TypeError("network lost");
			if (fake.failing !== undefined) return new Response("down", { status: fake.failing });
			const args = body.params.arguments;
			let result: Record<string, unknown>;
			if (body.params.name === "create_issue") {
				const key = `WEB-${100 + fake.issues.length}`;
				fake.issues.push({
					key,
					title: String(args.title),
					description: String(args.description),
					priority: String(args.priority),
				});
				if (fake.loseNextAnswer) {
					fake.loseNextAnswer = false;
					throw new TypeError("network lost");
				}
				result = { key, title: args.title };
			} else if (body.params.name === "search_issues") {
				result = { issues: fake.issues.map(({ key, title }) => ({ key, title })) };
			} else {
				fake.comments.push({ key: String(args.key), body: String(args.body) });
				result = { id: "c1", body: args.body };
			}
			// Track answers in server-sent events.
			const message = JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: {
					content: [{ type: "text", text: JSON.stringify(result) }],
					structuredContent: result,
				},
			});
			return new Response(`event: message\ndata: ${message}\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch,
		named: (name: string) => fake.calls.filter((call) => call.name === name),
	};
	return fake;
}

function mailbox() {
	const sent: { subject: string }[] = [];
	const box = {
		failing: false,
		sent,
		binding: {
			async send(message: { subject: string }) {
				if (box.failing) throw new Error("refused");
				sent.push(message);
				return { messageId: "test" };
			},
		} as unknown as SendEmail,
	};
	return box;
}

const SETTINGS = {
	TRACK_URL: "https://track-issues.test",
	TRACK_WORKSPACE: "gateweave",
	TRACK_TEAM: "WEB",
	TRACK_LABELS: "Operations",
	TRACK_KEY: KEY,
	PAGE_URL: "https://status.test",
};

function monitorEnv(box?: ReturnType<typeof mailbox>, settings: object = SETTINGS): MonitorEnv {
	return {
		...env,
		...(box ? { EMAIL: box.binding, ALERT_TO: "owner@example.com" } : {}),
		...settings,
	};
}

const run = (
	at: number,
	track: ReturnType<typeof fakeTrack>,
	box?: ReturnType<typeof mailbox>,
	settings?: object,
) => tick(monitorEnv(box, settings), at, { send: track.send, retryAfter: 0, slowMs: SLOW });

async function control(path: string, body?: unknown) {
	return fetch(`https://control.test${path}`, {
		method: body === undefined ? "GET" : "POST",
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function rows(sql: string) {
	return (await env.DB.prepare(sql).all()).results;
}

/** Takes Track down at T0 + 1 min, as the monitor does after two failed checks. */
async function outage(track: ReturnType<typeof fakeTrack>, box?: ReturnType<typeof mailbox>) {
	await run(T0, track, box);
	await control("/__set", { [TRACK]: { status: 503 } });
	await run(T0 + MINUTE, track, box);
	return run(T0 + 2 * MINUTE, track, box);
}

async function addIncident(
	kind: "down" | "slow",
	startedAt: number,
	endedAt: number | null = null,
) {
	await env.DB.prepare(
		"INSERT INTO incident (service, started_at, ended_at, error, kind) VALUES ('track', ?1, ?2, 'Answered in 4.8 s.', ?3)",
	)
		.bind(startedAt, endedAt, kind)
		.run();
}

beforeEach(async () => {
	await control("/__reset");
	await env.DB.batch(
		["check_result", "daily", "service_state", "incident", "error_alert"].map((table) =>
			env.DB.prepare(`DELETE FROM ${table}`),
		),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("filing an incident in Track", () => {
	it("files an outage at once, as one issue with the right fields", async () => {
		const track = fakeTrack();
		const report = await outage(track);

		expect(report.track).toMatchObject({ filed: 1, failed: 0 });
		expect(track.calls).toHaveLength(1);
		const [call] = track.calls;
		expect(call?.name).toBe("create_issue");
		expect(call?.authorization).toBe(`Bearer ${KEY}`);
		// Every call has its own timeout.
		expect(call?.signal).toBeInstanceOf(AbortSignal);
		expect(call?.args).toMatchObject({
			workspace: "gateweave",
			team: "WEB",
			title: "Incident: Track down since 2026-11-12 14:01 UTC",
			priority: "high",
			labels: ["Operations"],
		});
		const description = String(call?.args.description);
		expect(description).toContain("Service: Track");
		expect(description).toContain("Kind: outage (down)");
		expect(description).toContain("Started: 2026-11-12 14:01 UTC");
		expect(description).toContain("What the check saw: Answered 503, not 200.");
		expect(description).toContain("Status page: https://status.test/");
		const id = ((await rows("SELECT id FROM incident")) as { id: number }[])[0]?.id;
		expect(description).toContain(`status-incident:${id}`);
		// Nothing a person shouldn't read, and no address that isn't on the page.
		expect(description).not.toContain(KEY);
		expect(description).not.toContain("track.test");
		expect(
			await rows(
				"SELECT track_issue, track_filed_at, track_attempts, track_retry_at FROM incident",
			),
		).toEqual([
			{
				track_issue: "WEB-100",
				track_filed_at: T0 + 2 * MINUTE,
				track_attempts: 0,
				track_retry_at: null,
			},
		]);
	});

	it("files an incident once, over later runs and over two runs at the same time", async () => {
		const track = fakeTrack();
		await outage(track);
		await run(T0 + 3 * MINUTE, track);
		await run(T0 + 4 * MINUTE, track);
		expect(track.issues).toHaveLength(1);

		// Two crons that overlap, each having read the incident before the other noted its issue.
		await addIncident("down", T0 + 10 * MINUTE);
		const env2 = monitorEnv();
		await Promise.all([
			fileIncidents(env2, [{ id: "track", name: "Track" }], T0 + 11 * MINUTE, track.send),
			fileIncidents(env2, [{ id: "track", name: "Track" }], T0 + 11 * MINUTE, track.send),
		]);
		expect(track.issues).toHaveLength(2);
		expect(track.named("search_issues")).toHaveLength(0);
		expect(await rows("SELECT track_issue FROM incident ORDER BY id")).toEqual([
			{ track_issue: "WEB-100" },
			{ track_issue: "WEB-101" },
		]);
	});

	it("does not stop the alert, and tries again with a wait between tries", async () => {
		const box = mailbox();
		const track = fakeTrack();
		track.failing = "network";
		const report = await outage(track, box);

		expect(box.sent.map((m) => m.subject)).toEqual(["Track is down"]);
		expect(report.track).toMatchObject({ filed: 0, failed: 1 });
		expect(await rows("SELECT track_issue, track_attempts FROM incident")).toEqual([
			{ track_issue: null, track_attempts: 1 },
		]);

		// A minute's wait after the first try: a run half a minute later leaves it be.
		track.failing = 503;
		const early = await fileIncidents(
			monitorEnv(box),
			[{ id: "track", name: "Track" }],
			T0 + 2 * MINUTE + 30_000,
			track.send,
		);
		expect(early).toMatchObject({ filed: 0, failed: 0 });
		expect(track.calls).toHaveLength(1);

		// Then it tries again, and fails again. The wait doubles.
		const second = await run(T0 + 3 * MINUTE, track, box);
		expect(second.track.failed).toBe(1);
		expect(track.calls).toHaveLength(2);
		expect(await rows("SELECT track_attempts, track_retry_at FROM incident")).toEqual([
			{ track_attempts: 2, track_retry_at: T0 + 5 * MINUTE },
		]);
		expect((await run(T0 + 4 * MINUTE, track, box)).track.failed).toBe(0);

		// Track is back: the retry files it, once, and the alert isn't sent again.
		track.failing = undefined;
		const third = await run(T0 + 5 * MINUTE, track, box);
		expect(third.track).toMatchObject({ filed: 1, failed: 0 });
		expect(track.issues).toHaveLength(1);
		expect(box.sent).toHaveLength(1);
	});

	it("doesn't fail the run when Track fails", async () => {
		const box = mailbox();
		const track = fakeTrack();
		track.failing = "network";
		await expect(outage(track, box)).resolves.toBeDefined();
		expect(box.sent).toHaveLength(1);
	});

	it("looks for the issue before making another when a try may have made it", async () => {
		const track = fakeTrack();
		track.loseNextAnswer = true;
		const first = await outage(track);
		expect(first.track.failed).toBe(1);
		expect(track.issues).toHaveLength(1);
		expect(await rows("SELECT track_issue FROM incident")).toEqual([{ track_issue: null }]);

		const retry = await run(T0 + 3 * MINUTE, track);
		expect(retry.track).toMatchObject({ filed: 1, failed: 0 });
		expect(track.named("search_issues")).toHaveLength(1);
		expect(track.issues).toHaveLength(1);
		expect(await rows("SELECT track_issue FROM incident")).toEqual([{ track_issue: "WEB-100" }]);
	});

	it("files in the service's own team when it names one, and looks there on a retry", async () => {
		const track = fakeTrack();
		track.loseNextAnswer = true;
		// The same service, now saying its incidents belong to the Track team.
		const own = {
			...SETTINGS,
			SERVICES: [{ id: "track", name: "Track", url: TRACK, team: "TRK" }],
		};
		await run(T0, track, undefined, own);
		await control("/__set", { [TRACK]: { status: 503 } });
		await run(T0 + MINUTE, track, undefined, own);
		const first = await run(T0 + 2 * MINUTE, track, undefined, own);
		expect(first.track.failed).toBe(1);
		expect(track.named("create_issue")[0]?.args).toMatchObject({ team: "TRK" });

		const retry = await run(T0 + 3 * MINUTE, track, undefined, own);
		expect(retry.track).toMatchObject({ filed: 1, failed: 0 });
		expect(track.named("search_issues")[0]?.args).toMatchObject({ team: "TRK" });
		expect(track.issues).toHaveLength(1);
	});

	it("refuses a service's team that isn't a team's key", () => {
		const service = { id: "track", name: "Track", url: TRACK };
		expect(servicesOf([{ ...service, team: "TRK" }])[0]?.team).toBe("TRK");
		expect(servicesOf([service])[0]?.team).toBeUndefined();
		for (const team of ["trk", "", "TOO-LONG-A-KEY", 7]) {
			expect(() => servicesOf([{ ...service, team }])).toThrow("is a Track team's key");
		}
	});

	it("files a slow spell only once it has lasted 15 minutes", async () => {
		const track = fakeTrack();
		await addIncident("slow", T0);
		await run(T0 + SLOW_FILE_AFTER_MS - MINUTE, track);
		expect(track.calls).toEqual([]);

		await run(T0 + SLOW_FILE_AFTER_MS, track);
		await run(T0 + SLOW_FILE_AFTER_MS + MINUTE, track);
		expect(track.issues).toHaveLength(1);
		expect(track.issues[0]).toMatchObject({
			title: "Incident: Track slow since 2026-11-12 14:00 UTC",
			priority: "medium",
		});
		expect(track.issues[0]?.description).toContain("Kind: slow (it answered, but late)");
	});

	it("files nothing for a slow spell that ended before 15 minutes", async () => {
		const track = fakeTrack();
		await addIncident("slow", T0, T0 + 8 * MINUTE);
		await run(T0 + 9 * MINUTE, track);
		await run(T0 + 40 * MINUTE, track);
		expect(track.calls).toEqual([]);
	});

	it("comments once when the incident ends, and leaves the issue's status alone", async () => {
		const track = fakeTrack();
		await outage(track);
		await run(T0 + 3 * MINUTE, track);
		expect(track.comments).toEqual([]);

		await control("/__reset");
		const back = await run(T0 + 4 * MINUTE, track);
		expect(back.track).toMatchObject({ noted: 1, failed: 0 });
		await run(T0 + 5 * MINUTE, track);
		expect(track.comments).toEqual([
			{
				key: "WEB-100",
				body: "Track is over: it ended at 2026-11-12 14:04 UTC, after down for 3 min.",
			},
		]);
		expect(track.calls.map((c) => c.name)).toEqual(["create_issue", "add_comment"]);
		expect(await rows("SELECT track_closed_noted_at FROM incident")).toEqual([
			{ track_closed_noted_at: T0 + 4 * MINUTE },
		]);
	});

	it("retries a comment that failed, and files and comments in one run for an outage that ended unfiled", async () => {
		const track = fakeTrack();
		await outage(track);
		track.failing = 503;
		await control("/__reset");
		expect((await run(T0 + 4 * MINUTE, track)).track).toMatchObject({ noted: 0, failed: 1 });
		track.failing = undefined;
		expect((await run(T0 + 5 * MINUTE, track)).track).toMatchObject({ noted: 1, failed: 0 });
		expect(track.comments).toHaveLength(1);

		await addIncident("down", T0 + 10 * MINUTE, T0 + 13 * MINUTE);
		const late = await run(T0 + 14 * MINUTE, track);
		expect(late.track).toMatchObject({ filed: 1, noted: 1 });
		expect(track.comments.at(-1)?.key).toBe("WEB-101");
	});

	it("gives up after three days, once", async () => {
		const track = fakeTrack();
		track.failing = 503;
		await addIncident("down", T0);
		const at = T0 + TRACK_RETRY_MS + 5 * MINUTE;
		const first = await run(at, track);
		expect(first.track).toMatchObject({ gaveUp: 1, filed: 0, failed: 0 });
		const second = await run(at + MINUTE, track);
		expect(second.track).toMatchObject({ gaveUp: 0, failed: 0 });
		expect(track.calls).toEqual([]);
	});

	it("leaves incidents from before it existed alone", async () => {
		// The migration marks them, so turning it on doesn't file old outages.
		const row = await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE name = 'incident'").first();
		expect(row).not.toBeNull();
		const track = fakeTrack();
		await env.DB.prepare(
			"INSERT INTO incident (service, started_at, error, track_gave_up_at) VALUES ('track', ?1, 'x', 0)",
		)
			.bind(T0)
			.run();
		await run(T0 + MINUTE, track);
		expect(track.calls).toEqual([]);
	});

	it("calls nothing without its settings", async () => {
		const track = fakeTrack();
		await control("/__set", { [TRACK]: { status: 503 } });
		await run(T0, track, undefined, {});
		await run(T0 + MINUTE, track, undefined, {});
		const down = await run(T0 + 2 * MINUTE, track, undefined, {});
		expect(down.track).toEqual({ filed: 0, noted: 0, failed: 0, gaveUp: 0, misconfigured: false });
		expect(track.calls).toEqual([]);
		expect(await rows("SELECT track_issue, track_attempts FROM incident")).toEqual([
			{ track_issue: null, track_attempts: 0 },
		]);
	});

	it("refuses settings that are half there or wrong, and calls nothing", async () => {
		const track = fakeTrack();
		await addIncident("down", T0);
		for (const [i, settings] of [
			{ TRACK_KEY: KEY },
			{ ...SETTINGS, TRACK_URL: "http://track-issues.test" },
			{ ...SETTINGS, TRACK_KEY: "not-a-key" },
		].entries()) {
			const report = await run(T0 + (i + 1) * MINUTE, track, undefined, settings);
			expect(report.track.misconfigured).toBe(true);
		}
		expect(track.calls).toEqual([]);
		expect(trackOf({ DB: env.DB, ...SETTINGS })?.endpoint).toBe("https://track-issues.test/mcp");
	});

	it("never puts the key in a log line or a row", async () => {
		// Real fetches here: the stand-in for the checked services answers Track's address with
		// something that isn't an MCP answer, so every filing fails.
		await addIncident("down", T0);
		const logs: string[] = [];
		for (const method of ["log", "error", "warn", "info"] as const) {
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				logs.push(args.map(String).join(" "));
			});
		}
		await worker.scheduled?.(
			{ scheduledTime: T0 + 5 * MINUTE, cron: "* * * * *", noRetry() {} } as ScheduledController,
			{ ...env, ...SETTINGS },
		);
		const last = (await (
			await control(`/__last?url=${encodeURIComponent(TRACK_ENDPOINT)}`)
		).json()) as { authorization: string } | null;
		expect(last?.authorization).toBe(`Bearer ${KEY}`);

		const lines = logs.join("\n");
		expect(lines).toContain('"trackFailed":1');
		expect(lines).not.toContain(KEY);
		expect(lines).not.toContain("gwt_");
		for (const table of ["incident", "check_result", "service_state", "error_alert", "daily"]) {
			expect(JSON.stringify(await rows(`SELECT * FROM ${table}`))).not.toContain(KEY);
		}
	});
});
