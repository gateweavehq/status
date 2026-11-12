import { type AlertEnv, sendAlerts } from "./alerts";
import { type CheckResult, check } from "./check";
import { servicesOf } from "./config";
import { DAY, dayOf, HOUR, MINUTE } from "./time";

/** Failed checks in a row that take a service down: two, so about two minutes. */
export const DOWN_AFTER = 2;
/** Each check is kept this long; the days' counts are kept for good. */
export const KEEP_CHECKS_MS = 7 * DAY;

export interface MonitorEnv extends AlertEnv {
	SERVICES: unknown;
}

/** A service's state as the database keeps it. */
export interface ServiceState {
	service: string;
	status: "up" | "down";
	since: number;
	failures: number;
	failing_since: number | null;
	checked_at: number;
	last_ms: number | null;
	last_error: string | null;
}

export interface Change {
	service: string;
	to: "up" | "down";
	/** When the change happened: the first failed check, or the check that worked again. */
	at: number;
}

/** What a check makes of a service's state, and whether it went down or came back. */
export function nextState(
	before: ServiceState | undefined,
	result: CheckResult,
	at: number,
): { state: ServiceState; change?: Change } {
	const prev = before ?? { status: "up" as const, since: at, failures: 0, failing_since: null };
	const common = { service: result.service, checked_at: at, last_ms: result.ms };
	if (result.ok) {
		const back = prev.status === "down";
		return {
			state: {
				...common,
				status: "up",
				since: back ? at : prev.since,
				failures: 0,
				failing_since: null,
				last_error: null,
			},
			...(back ? { change: { service: result.service, to: "up" as const, at } } : {}),
		};
	}
	const failures = prev.failures + 1;
	const failingSince = prev.failing_since ?? at;
	const down = prev.status === "up" && failures >= DOWN_AFTER;
	return {
		state: {
			...common,
			status: down ? "down" : prev.status,
			since: down ? failingSince : prev.since,
			failures,
			failing_since: failingSince,
			last_error: result.error,
		},
		...(down ? { change: { service: result.service, to: "down" as const, at: failingSince } } : {}),
	};
}

export interface TickReport {
	at: number;
	/** True when another run had checked this minute already. */
	skipped: boolean;
	results: CheckResult[];
	changes: Change[];
	alerts: { sent: number; failed: number };
}

/**
 * One minute's work: checks every service, keeps the results, takes services down or brings them
 * back, opens and closes incidents, and sends the alerts that are due.
 */
export async function tick(
	env: MonitorEnv,
	scheduledTime: number,
	{ send = fetch, retryAfter }: { send?: typeof fetch; retryAfter?: number } = {},
): Promise<TickReport> {
	const services = servicesOf(env.SERVICES);
	const at = Math.floor(scheduledTime / MINUTE) * MINUTE;
	const done = await env.DB.prepare("SELECT 1 FROM check_result WHERE at = ?1 LIMIT 1")
		.bind(at)
		.first();
	if (done) return { at, skipped: true, results: [], changes: [], alerts: { sent: 0, failed: 0 } };

	const results = await Promise.all(
		services.map((service) => check(service, send, retryAfter === undefined ? {} : { retryAfter })),
	);
	const states = new Map(
		(await env.DB.prepare("SELECT * FROM service_state").all<ServiceState>()).results.map((row) => [
			row.service,
			row,
		]),
	);
	const db = env.DB;
	const day = dayOf(at);
	const statements: D1PreparedStatement[] = [];
	const changes: Change[] = [];
	for (const result of results) {
		const { state, change } = nextState(states.get(result.service), result, at);
		statements.push(
			db
				.prepare(
					`INSERT INTO check_result (service, at, ok, status, ms, error) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
						ON CONFLICT DO NOTHING`,
				)
				.bind(result.service, at, result.ok ? 1 : 0, result.status, result.ms, result.error),
			db
				.prepare(
					`INSERT INTO daily (service, day, checks, failures, total_ms) VALUES (?1, ?2, 1, ?3, ?4)
						ON CONFLICT (service, day) DO UPDATE SET checks = checks + 1,
						failures = failures + excluded.failures, total_ms = total_ms + excluded.total_ms`,
				)
				.bind(result.service, day, result.ok ? 0 : 1, result.ms),
			db
				.prepare(
					`INSERT OR REPLACE INTO service_state
						(service, status, since, failures, failing_since, checked_at, last_ms, last_error)
						VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
				)
				.bind(
					state.service,
					state.status,
					state.since,
					state.failures,
					state.failing_since,
					state.checked_at,
					state.last_ms,
					state.last_error,
				),
		);
		if (change?.to === "down") {
			statements.push(
				db
					.prepare("INSERT INTO incident (service, started_at, error) VALUES (?1, ?2, ?3)")
					.bind(result.service, change.at, result.error),
			);
		} else if (change?.to === "up") {
			statements.push(
				db
					.prepare("UPDATE incident SET ended_at = ?2 WHERE service = ?1 AND ended_at IS NULL")
					.bind(result.service, at),
			);
		}
		if (change) changes.push(change);
	}
	if (at % HOUR === 0) {
		statements.push(db.prepare("DELETE FROM check_result WHERE at < ?1").bind(at - KEEP_CHECKS_MS));
	}
	await db.batch(statements);
	const alerts = await sendAlerts(env, services, at);
	return { at, skipped: false, results, changes, alerts };
}
