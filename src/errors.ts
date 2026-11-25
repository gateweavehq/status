import { brandOf } from "./brand";
import { ConfigError } from "./config";
import { clock, HOUR, MINUTE } from "./time";

/**
 * The error watch: every 15 minutes it asks Cloudflare's analytics how often each watched host
 * answered 5xx and each watched Worker and its Durable Objects failed, and emails when that crosses
 * a line. A health check only proves one URL works; this catches the page or API that broke while
 * it still answers.
 */
export interface ErrorWatch {
	/** The account whose Workers are watched, and the zone whose hosts are. */
	account: string;
	zone: string;
	hosts: string[];
	scripts: string[];
	/** Errors in a window below this never alert, so a handful on a quiet host doesn't. */
	minErrors: number;
	/** Nor does a share of requests below this, so a busy host's background noise doesn't. */
	minShare: number;
}

export const WINDOW_MS = 15 * MINUTE;
/** Analytics take a minute or two to arrive, so a window ends this long before the check. */
export const LAG_MS = 2 * MINUTE;
/** The same type of finding for a service alerts again after this long at the earliest. */
export const QUIET_MS = 6 * HOUR;
/** Kept for a look back at what alerted. */
const KEEP_MS = 90 * 24 * HOUR;

const ID = /^[0-9a-f]{32}$/;
const HOST = /^[a-z0-9.-]{1,253}$/;
const SCRIPT = /^[a-z0-9-]{1,63}$/;

/**
 * Reads `ERROR_WATCH`, or undefined when it isn't set. It may come as JSON text. The account's and
 * the zone's ids may be left out of it and come from `ids` instead (the secrets `ERROR_WATCH_ACCOUNT`
 * and `ERROR_WATCH_ZONE`), so that a public `wrangler.jsonc` need not name either.
 */
export function errorWatchOf(
	setting: unknown,
	ids: { account?: string; zone?: string } = {},
): ErrorWatch | undefined {
	if (setting === undefined || setting === null || setting === "") return undefined;
	let value = setting;
	if (typeof setting === "string") {
		try {
			value = JSON.parse(setting);
		} catch {
			throw new ConfigError("ERROR_WATCH is an object, as JSON.");
		}
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ConfigError("ERROR_WATCH is an object.");
	}
	const {
		account = ids.account,
		zone = ids.zone,
		hosts = [],
		scripts = [],
		minErrors = 10,
		minShare = 0.05,
	} = value as Record<string, unknown>;
	if (typeof account !== "string" || !ID.test(account)) {
		throw new ConfigError("ERROR_WATCH.account is the account's id.");
	}
	if (typeof zone !== "string" || !ID.test(zone)) {
		throw new ConfigError("ERROR_WATCH.zone is the zone's id.");
	}
	const list = (items: unknown, pattern: RegExp, what: string) => {
		if (
			!Array.isArray(items) ||
			!items.every((item) => typeof item === "string" && pattern.test(item))
		) {
			throw new ConfigError(`ERROR_WATCH.${what} is a list of names.`);
		}
		return items as string[];
	};
	const watch = {
		account,
		zone,
		hosts: list(hosts, HOST, "hosts"),
		scripts: list(scripts, SCRIPT, "scripts"),
		minErrors,
		minShare,
	};
	if (watch.hosts.length + watch.scripts.length === 0) {
		throw new ConfigError("ERROR_WATCH names no host and no script.");
	}
	if (typeof minErrors !== "number" || !Number.isInteger(minErrors) || minErrors < 1) {
		throw new ConfigError("ERROR_WATCH.minErrors is a whole number, 1 or more.");
	}
	if (typeof minShare !== "number" || !(minShare >= 0 && minShare <= 1)) {
		throw new ConfigError("ERROR_WATCH.minShare is a share, from 0 to 1.");
	}
	return { ...watch, minErrors, minShare };
}

/** Something that crossed the line in a window. */
export interface Finding {
	/**
	 * `http:<host>`, a Worker or Durable Object key with an alert type, or `watch` when the
	 * analytics couldn't be read.
	 */
	key: string;
	subject?: string;
	text: string;
	errors: number;
	total: number;
}

const QUERY = `query ErrorWatch($account: String!, $zone: String!, $start: Time!, $end: Time!) {
	viewer {
		accounts(filter: { accountTag: $account }) {
			workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $start, datetime_lt: $end }) {
				dimensions { scriptName status }
				sum { requests errors }
			}
			durableObjectsInvocationsAdaptiveGroups(
				limit: 1000
				filter: { datetime_geq: $start, datetime_lt: $end }
			) {
				dimensions { scriptName status }
				sum { requests errors }
			}
		}
		zones(filter: { zoneTag: $zone }) {
			all: httpRequestsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $start, datetime_lt: $end }) {
				count
				dimensions { clientRequestHTTPHost }
			}
			failed: httpRequestsAdaptiveGroups(
				limit: 1000
				filter: { datetime_geq: $start, datetime_lt: $end, edgeResponseStatus_geq: 500 }
			) {
				count
				dimensions { clientRequestHTTPHost edgeResponseStatus }
			}
		}
	}
}`;

interface Invocations {
	dimensions: { scriptName: string; status: string };
	sum: { requests: number; errors: number };
}

/**
 * Statuses that aren't a failure of ours. Cloudflare counts a client that went away as an error of
 * a Durable Object (a browser closing a sync socket does it), but nothing failed on our side.
 */
const NOT_A_FAILURE = new Set(["success", "clientDisconnected"]);
const STREAM_DISCONNECTED = "responseStreamDisconnected";

/**
 * A Durable Object's caller is always one of our Workers, and Cloudflare counts that Worker
 * closing the stream it read the answer from as a disconnect of the object. The Agents SDK's MCP
 * servers, such as Growth's, do it once for every request they answer. A Worker that fails while
 * reading counts among its own invocations.
 */
const NOT_A_FAILURE_OF_AN_OBJECT = new Set([...NOT_A_FAILURE, STREAM_DISCONNECTED]);

interface Answer {
	data?: {
		viewer?: {
			accounts?: {
				workersInvocationsAdaptive?: Invocations[];
				durableObjectsInvocationsAdaptiveGroups?: Invocations[];
			}[];
			zones?: {
				all?: { count: number; dimensions: { clientRequestHTTPHost: string } }[];
				failed?: {
					count: number;
					dimensions: { clientRequestHTTPHost: string; edgeResponseStatus: number };
				}[];
			}[];
		};
	};
	errors?: { message?: string }[] | null;
}

/** Thrown when the analytics can't be read. Its message names the answer, never the token. */
export class WatchError extends Error {
	override name = "WatchError";
}

/** A host as the request named it, without the port a client may have added. */
function hostOf(value: string): string {
	return value.toLowerCase().replace(/:(?:80|443)$/, "");
}

/** `500 ×12, 503 ×3`, most first. */
function tally(counts: Map<string, number>): string {
	return [...counts]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([what, n]) => `${what} ×${n}`)
		.join(", ");
}

const share = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

/** Asks the analytics about one window and says what crossed the line. */
export async function findErrors(
	watch: ErrorWatch,
	token: string,
	start: number,
	end: number,
	send: typeof fetch = fetch,
): Promise<Finding[]> {
	let answer: Answer;
	try {
		const response = await send("https://api.cloudflare.com/client/v4/graphql", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({
				query: QUERY,
				variables: {
					account: watch.account,
					zone: watch.zone,
					start: new Date(start).toISOString(),
					end: new Date(end).toISOString(),
				},
			}),
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new WatchError(`The analytics API answered ${response.status}.`);
		}
		answer = await response.json();
	} catch (error) {
		if (error instanceof WatchError) throw error;
		throw new WatchError("The analytics API couldn't be reached.");
	}
	if (answer.errors && answer.errors.length > 0) {
		// GraphQL's messages say what was wrong with the query or the token's rights, not data.
		const message = String(answer.errors[0]?.message ?? "").slice(0, 200);
		throw new WatchError(`The analytics API refused the query: ${message}`);
	}
	const viewer = answer.data?.viewer;
	const findings: Finding[] = [];
	const between = `between ${clock(start)} and ${clock(end)} UTC`;
	const over = (errors: number, total: number) =>
		errors >= watch.minErrors && total > 0 && errors / total >= watch.minShare;

	const zone = viewer?.zones?.[0];
	for (const host of watch.hosts) {
		let total = 0;
		const statuses = new Map<string, number>();
		for (const row of zone?.all ?? []) {
			if (hostOf(row.dimensions.clientRequestHTTPHost) === host) total += row.count;
		}
		for (const row of zone?.failed ?? []) {
			if (hostOf(row.dimensions.clientRequestHTTPHost) !== host) continue;
			const status = String(row.dimensions.edgeResponseStatus);
			statuses.set(status, (statuses.get(status) ?? 0) + row.count);
		}
		const errors = [...statuses.values()].reduce((sum, n) => sum + n, 0);
		if (!over(errors, total)) continue;
		findings.push({
			key: `http:${host}`,
			errors,
			total,
			text: `${host} answered ${errors} of ${total} requests with a 5xx (${share(errors, total)}) ${between}: ${tally(statuses)}.`,
		});
	}

	const account = viewer?.accounts?.[0];
	const kinds = [
		{
			key: "worker",
			what: "The Worker",
			rows: account?.workersInvocationsAdaptive ?? [],
			ignored: NOT_A_FAILURE,
		},
		{
			key: "objects",
			what: "The Durable Objects of",
			rows: account?.durableObjectsInvocationsAdaptiveGroups ?? [],
			ignored: NOT_A_FAILURE_OF_AN_OBJECT,
		},
	];
	for (const kind of kinds) {
		for (const script of watch.scripts) {
			let total = 0;
			const statuses = new Map<string, number>();
			for (const row of kind.rows) {
				if (row.dimensions.scriptName !== script) continue;
				total += row.sum.requests;
				const status = row.dimensions.status;
				if (row.sum.errors > 0 && !kind.ignored.has(status)) {
					statuses.set(status, (statuses.get(status) ?? 0) + row.sum.errors);
				}
			}
			const disconnects = statuses.get(STREAM_DISCONNECTED) ?? 0;
			statuses.delete(STREAM_DISCONNECTED);
			const errors = [...statuses.values()].reduce((sum, n) => sum + n, 0);
			const errorSpike = over(errors, total);
			const streamSpike = over(disconnects, total);
			const service = `${kind.what} ${script}`;
			if (errorSpike) {
				findings.push({
					key: `${kind.key}-errors:${script}`,
					errors,
					total,
					text: `${service} failed ${errors} of ${total} invocations (${share(errors, total)}) ${between}: ${tally(statuses)}.`,
				});
			}
			if (streamSpike) {
				const other =
					!errorSpike && errors > 0 ? ` Other errors in this window: ${tally(statuses)}.` : "";
				findings.push({
					key: `${kind.key}-streams:${script}`,
					subject: `Response stream disconnects on ${script}`,
					errors: disconnects,
					total,
					text: `${service} had ${disconnects} response stream disconnects in ${total} invocations (${share(disconnects, total)}) ${between}.${other}`,
				});
			}
			// Keep detecting spikes that cross the old combined threshold. A mixed alert must not
			// start either category's quiet time.
			if (!errorSpike && !streamSpike && over(errors + disconnects, total)) {
				findings.push({
					key: `${kind.key}-mixed:${script}`,
					subject: `Errors and response stream disconnects on ${script}`,
					errors: errors + disconnects,
					total,
					text: `${service} had ${errors} errors and ${disconnects} response stream disconnects in ${total} invocations (${share(errors + disconnects, total)}) ${between}: ${tally(statuses)}.`,
				});
			}
		}
	}
	return findings;
}

export interface WatchEnv {
	DB: D1Database;
	ERROR_WATCH?: unknown;
	ERROR_WATCH_ACCOUNT?: string;
	ERROR_WATCH_ZONE?: string;
	ANALYTICS_TOKEN?: string;
	PAGE_NAME?: string;
}

export interface WatchReport {
	/** Whether this minute was one the watch runs on, with a watch set up. */
	ran: boolean;
	findings: Finding[];
	/** The findings an alert went out for; the rest alerted within the quiet time. */
	alerted: string[];
}

/**
 * Runs the watch on the quarter hours, and alerts about what crossed the line and hasn't alerted
 * in the last six hours. `alert` sends one message, and throws when it couldn't.
 */
export async function watchErrors(
	env: WatchEnv,
	at: number,
	alert: (subject: string, text: string) => Promise<void>,
	send: typeof fetch = fetch,
): Promise<WatchReport> {
	const watch = errorWatchOf(env.ERROR_WATCH, {
		account: env.ERROR_WATCH_ACCOUNT,
		zone: env.ERROR_WATCH_ZONE,
	});
	if (!watch || !env.ANALYTICS_TOKEN || at % WINDOW_MS !== 0) {
		return { ran: false, findings: [], alerted: [] };
	}
	const brand = brandOf(env);
	const end = at - LAG_MS;
	const start = end - WINDOW_MS;
	let findings: Finding[];
	try {
		findings = await findErrors(watch, env.ANALYTICS_TOKEN, start, end, send);
	} catch (error) {
		if (!(error instanceof WatchError)) throw error;
		findings = [
			{ key: "watch", errors: 0, total: 0, text: `The error watch couldn't run: ${error.message}` },
		];
	}
	const db = env.DB;
	const recent = new Set(
		(
			await db
				.prepare("SELECT DISTINCT key FROM error_alert WHERE sent_at > ?1")
				.bind(at - QUIET_MS)
				.all<{ key: string }>()
		).results.map((row) => row.key),
	);
	const due = findings.filter((finding) => !recent.has(finding.key));
	let sentAt: number | null = null;
	const first = due[0];
	if (first) {
		const subject =
			due.length === 1
				? (first.subject ??
					(first.key === "watch"
						? "The error watch couldn't run"
						: `Errors on ${first.key.slice(first.key.indexOf(":") + 1)}`))
				: due.some((finding) => finding.subject)
					? `${brand.name} alerts`
					: `Errors on ${due.length} services`;
		const text = [
			...due.map((finding) => finding.text),
			"",
			"Workers Logs in the Cloudflare dashboard has the details. The same type of alert for a service can repeat after six hours.",
			"",
			"--",
			`${brand.name} watches errors every 15 minutes.`,
		].join("\n");
		try {
			await alert(subject, text);
			sentAt = at;
		} catch {
			// Kept unsent, so the next quarter hour alerts again if it still crosses the line.
		}
	}
	const statements = findings.map((finding) =>
		db
			.prepare(
				`INSERT INTO error_alert (key, window_end, errors, total, text, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
					ON CONFLICT DO NOTHING`,
			)
			.bind(
				finding.key,
				end,
				finding.errors,
				finding.total,
				finding.text,
				due.includes(finding) ? sentAt : null,
			),
	);
	if (at % (24 * HOUR) === 0) {
		statements.push(db.prepare("DELETE FROM error_alert WHERE window_end < ?1").bind(at - KEEP_MS));
	}
	if (statements.length > 0) await db.batch(statements);
	return { ran: true, findings, alerted: sentAt === null ? [] : due.map((finding) => finding.key) };
}
