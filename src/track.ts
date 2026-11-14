import type { Incident } from "./alerts";
import { ConfigError, type Service } from "./config";
import { clock, dayOf, duration, MINUTE } from "./time";

/**
 * The settings for filing incidents as issues in Track. All of them are optional, and without
 * them nothing is filed.
 */
export interface TrackEnv {
	DB: D1Database;
	/** Track's address, such as https://track.gateweave.com. */
	TRACK_URL?: string;
	/** The workspace's slug. */
	TRACK_WORKSPACE?: string;
	/** The key of the team the issues go to, such as WEB. */
	TRACK_TEAM?: string;
	/** Label names for each issue, comma-separated. They must exist in the workspace. */
	TRACK_LABELS?: string;
	/** An agent member's key (a secret). */
	TRACK_KEY?: string;
	PAGE_URL?: string;
}

export interface TrackSettings {
	endpoint: string;
	workspace: string;
	team: string;
	labels: string[];
	key: string;
}

/** An incident with what is kept of its issue. */
export interface TrackedIncident extends Incident {
	track_issue: string | null;
	track_filed_at: number | null;
	track_closed_noted_at: number | null;
	track_attempts: number;
	track_retry_at: number | null;
	track_gave_up_at: number | null;
}

export interface TrackReport {
	filed: number;
	noted: number;
	failed: number;
	gaveUp: number;
	/** True when the settings are only part there, or wrong. Nothing is filed then. */
	misconfigured: boolean;
}

/** A slow spell is filed once it has lasted this long: five minutes of it is a bad start only. */
export const SLOW_FILE_AFTER_MS = 15 * MINUTE;
/** Filing and comments that can't go are tried again for this long, as alerts are. */
export const TRACK_RETRY_MS = 3 * 24 * 60 * 60 * 1000;
/** Each call to Track gives up after this long. */
export const CALL_TIMEOUT_MS = 10_000;
/** Incidents worked on in one run, so a Track that is slow doesn't hold a run for long. */
const PER_RUN = 5;
const MAX_BACKOFF_MS = 30 * MINUTE;

const AGENT_KEY = /^gwt_[A-Za-z0-9_-]{43}$/;
const ISSUE_KEY = /^[A-Za-z0-9]+-\d+$/;

/** Where issues go, or undefined when no setting is there. A setting that is half there is refused. */
export function trackOf(env: TrackEnv): TrackSettings | undefined {
	const url = env.TRACK_URL?.trim() ?? "";
	const workspace = env.TRACK_WORKSPACE?.trim() ?? "";
	const team = env.TRACK_TEAM?.trim() ?? "";
	const key = env.TRACK_KEY?.trim() ?? "";
	if (!url && !workspace && !team && !key) return undefined;
	if (!url || !workspace || !team || !key) {
		throw new ConfigError(
			"Filing in Track needs TRACK_URL, TRACK_WORKSPACE, TRACK_TEAM and TRACK_KEY.",
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new ConfigError("TRACK_URL isn't a URL.");
	}
	if (parsed.protocol !== "https:") throw new ConfigError("TRACK_URL is an https URL.");
	if (!AGENT_KEY.test(key)) throw new ConfigError("TRACK_KEY isn't an agent member's key.");
	const labels = (env.TRACK_LABELS ?? "")
		.split(",")
		.map((label) => label.trim())
		.filter((label) => label !== "");
	return { endpoint: `${parsed.origin}/mcp`, workspace, team, labels, key };
}

/** The issue's title. It names the incident, so it is also what a search finds it by. */
export function titleOf(incident: Incident, service: Pick<Service, "name">): string {
	const kind = incident.kind === "slow" ? "slow" : "down";
	return `Incident: ${service.name} ${kind} since ${dayOf(incident.started_at)} ${clock(incident.started_at)} UTC`;
}

/** The marker a description carries, which is how an issue is told to be an incident's. */
export function markerOf(incident: Pick<Incident, "id">): string {
	return `status-incident:${incident.id}`;
}

/** The issue's description: what the page already says, and no more. */
export function descriptionOf(
	incident: Incident,
	service: Pick<Service, "name">,
	pageUrl: string,
): string {
	return [
		`Service: ${service.name}`,
		`Kind: ${incident.kind === "slow" ? "slow (it answered, but late)" : "outage (down)"}`,
		`Started: ${dayOf(incident.started_at)} ${clock(incident.started_at)} UTC`,
		`What the check saw: ${incident.error ?? "it failed"}`,
		`Status page: ${pageUrl}`,
		"",
		"Filed by Gateweave Status. It comments here when the incident ends and leaves the issue open: close it with the cause.",
		"",
		markerOf(incident),
	].join("\n");
}

/** The comment for an incident's end. */
export function endNote(incident: Incident, service: Pick<Service, "name">): string {
	const ended = incident.ended_at ?? incident.started_at;
	const what = incident.kind === "slow" ? "slow for" : "down for";
	return `${service.name} is over: it ended at ${dayOf(ended)} ${clock(ended)} UTC, after ${what} ${duration(ended - incident.started_at)}.`;
}

/** The wait before a try that follows `attempts` tries: a minute, doubling, up to half an hour. */
export function backoff(attempts: number): number {
	return Math.min(MINUTE * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

/** A call to Track that didn't work. It says how, never what Track answered. */
class TrackError extends Error {
	override name = "TrackError";
}

/**
 * One MCP tool call, as plain JSON-RPC over POST. Track's endpoint serves each request on its own
 * (no session), so there is no `initialize` first. The key is only ever sent, never kept.
 */
async function callTool(
	settings: TrackSettings,
	send: typeof fetch,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const response = await send(settings.endpoint, {
		method: "POST",
		headers: {
			authorization: `Bearer ${settings.key}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}),
		redirect: "manual",
		signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
	});
	if (response.status !== 200) throw new TrackError(`Track answered ${response.status}.`);
	const text = await response.text();
	let message: unknown;
	try {
		message = response.headers.get("content-type")?.includes("text/event-stream")
			? lastData(text)
			: JSON.parse(text);
	} catch {
		throw new TrackError("Track's answer wasn't JSON.");
	}
	const { result, error } = (message ?? {}) as { result?: unknown; error?: unknown };
	if (error !== undefined || typeof result !== "object" || result === null) {
		throw new TrackError("Track refused the call.");
	}
	const call = result as { isError?: boolean; structuredContent?: unknown };
	if (call.isError) throw new TrackError("Track refused the call.");
	if (typeof call.structuredContent !== "object" || call.structuredContent === null) {
		throw new TrackError("Track's answer had no result.");
	}
	return call.structuredContent as Record<string, unknown>;
}

/** The last JSON message of a server-sent events body. */
function lastData(text: string): unknown {
	const data = text
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.filter((line) => line !== "");
	const last = data.at(-1);
	if (last === undefined) throw new Error("No data.");
	return JSON.parse(last);
}

function issueKeyOf(result: Record<string, unknown>): string {
	const key = result.key;
	if (typeof key !== "string" || !ISSUE_KEY.test(key)) {
		throw new TrackError("No issue key came back.");
	}
	return key;
}

/** The issue an earlier, unfinished try may have made: found by its title, which names the incident. */
async function findIssue(
	settings: TrackSettings,
	send: typeof fetch,
	team: string,
	title: string,
): Promise<string | undefined> {
	const found = await callTool(settings, send, "search_issues", {
		workspace: settings.workspace,
		team,
		text: title.slice(0, 200),
		limit: 50,
	});
	const issues = Array.isArray(found.issues) ? found.issues : [];
	for (const issue of issues as { key?: unknown; title?: unknown }[]) {
		if (issue.title === title && typeof issue.key === "string" && ISSUE_KEY.test(issue.key)) {
			return issue.key;
		}
	}
	return undefined;
}

/**
 * Takes the incident's next try, if it is due: moves its retry time forward first, and only the
 * run that moved it goes on. A run that dies after this leaves a try for later, never a second
 * one at the same time.
 */
async function claim(
	db: D1Database,
	incident: TrackedIncident,
	at: number,
	step: "file" | "note",
): Promise<boolean> {
	const phase =
		step === "file"
			? "track_issue IS NULL"
			: "track_issue IS NOT NULL AND track_closed_noted_at IS NULL";
	const result = await db
		.prepare(
			`UPDATE incident SET track_attempts = track_attempts + 1, track_retry_at = ?4
				WHERE id = ?1 AND track_attempts = ?2 AND ${phase}
				AND track_gave_up_at IS NULL AND (track_retry_at IS NULL OR track_retry_at <= ?3)`,
		)
		.bind(incident.id, incident.track_attempts, at, at + backoff(incident.track_attempts + 1))
		.run();
	return result.meta.changes === 1;
}

/**
 * Files what is due: an issue for each incident that is worth one, and a comment on the issue
 * of each that ended. Never throws: what can't be done is tried again by a later run, for three
 * days, and then given up on.
 */
export async function fileIncidents(
	env: TrackEnv,
	services: Pick<Service, "id" | "name" | "team">[],
	at: number,
	send: typeof fetch = fetch,
): Promise<TrackReport> {
	const report: TrackReport = { filed: 0, noted: 0, failed: 0, gaveUp: 0, misconfigured: false };
	try {
		const settings = trackOf(env);
		if (!settings) return report;
		const db = env.DB;
		const pageUrl = env.PAGE_URL ?? "https://status.gateweave.com";
		// What is owed: an issue for an incident worth one (an outage, or a slow spell that lasted
		// long enough), a comment for one that ended. ?1 is now and ?2 the slow spell's length.
		const owed = `(track_issue IS NULL AND (kind = 'down' OR COALESCE(ended_at, ?1) - started_at >= ?2)
				OR (track_issue IS NOT NULL AND ended_at IS NOT NULL AND track_closed_noted_at IS NULL))`;
		const old = await db
			.prepare(
				`UPDATE incident SET track_gave_up_at = ?1 WHERE track_gave_up_at IS NULL
					AND COALESCE(ended_at, started_at) < ?3 AND ${owed}`,
			)
			.bind(at, SLOW_FILE_AFTER_MS, at - TRACK_RETRY_MS)
			.run();
		report.gaveUp = old.meta.changes;
		const due = await db
			.prepare(
				`SELECT * FROM incident WHERE track_gave_up_at IS NULL AND ${owed}
					AND (track_retry_at IS NULL OR track_retry_at <= ?1)
					ORDER BY started_at, id LIMIT ${PER_RUN}`,
			)
			.bind(at, SLOW_FILE_AFTER_MS)
			.all<TrackedIncident>();
		await Promise.all(
			due.results.map(async (incident) => {
				const known = services.find((s) => s.id === incident.service);
				const service = known ?? {
					name: incident.service,
				};
				let current = incident;
				try {
					if (current.track_issue === null) {
						if (!(await claim(db, current, at, "file"))) return;
						const title = titleOf(current, service);
						// A service's own team, so a product's outage is on that product's board.
						const team = known?.team ?? settings.team;
						// An earlier try may have made the issue and died before noting it.
						const found =
							current.track_attempts > 0 ? await findIssue(settings, send, team, title) : undefined;
						const issue =
							found ??
							issueKeyOf(
								await callTool(settings, send, "create_issue", {
									workspace: settings.workspace,
									team,
									title,
									description: descriptionOf(current, service, pageUrl),
									priority: current.kind === "slow" ? "medium" : "high",
									...(settings.labels.length > 0 && { labels: settings.labels }),
								}),
							);
						await db
							.prepare(
								`UPDATE incident SET track_issue = ?2, track_filed_at = ?3, track_attempts = 0,
									track_retry_at = NULL WHERE id = ?1`,
							)
							.bind(current.id, issue, at)
							.run();
						report.filed++;
						// The comment has a try of its own.
						current = { ...current, track_issue: issue, track_attempts: 0, track_retry_at: null };
					}
					if (current.ended_at === null || current.track_closed_noted_at !== null) return;
					if (!(await claim(db, current, at, "note"))) return;
					await callTool(settings, send, "add_comment", {
						workspace: settings.workspace,
						key: current.track_issue,
						body: endNote(current, service),
					});
					await db
						.prepare(
							`UPDATE incident SET track_closed_noted_at = ?2, track_attempts = 0, track_retry_at = NULL
								WHERE id = ?1`,
						)
						.bind(current.id, at)
						.run();
					report.noted++;
				} catch {
					report.failed++;
				}
			}),
		);
	} catch (error) {
		if (error instanceof ConfigError) report.misconfigured = true;
		else report.failed++;
	}
	return report;
}
