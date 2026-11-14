import { type AlertEnv, sendAlerts } from "./alerts";
import { type CheckResult, check, SLOW_MS } from "./check";
import { servicesOf } from "./config";
import { DAY, dayOf, HOUR, MINUTE } from "./time";
import { fileIncidents, type TrackEnv, type TrackReport } from "./track";

/** Failed checks in a row that take a service down: two, so about two minutes. */
export const DOWN_AFTER = 2;
/** Slow answers in a row that make a service slow: five, so five minutes, past any one slow start. */
export const SLOW_AFTER = 5;
/** Answers in time in a row that end a slow spell. */
export const QUICK_AFTER = 3;
/** Each check is kept this long; the days' counts are kept for good. */
export const KEEP_CHECKS_MS = 7 * DAY;

export interface MonitorEnv extends AlertEnv, TrackEnv {
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
	/** Down and up, or slow and quick again while it stays up. */
	to: "up" | "down" | "slow" | "quick";
	/**
	 * When the change happened: the first failed or slow check of the run, or the first check that
	 * worked again or answered in time.
	 */
	at: number;
}

/** A check as the slow spells are worked out from: newest first. */
export interface RecentCheck {
	at: number;
	ok: boolean;
	ms: number;
}

/**
 * Whether a service turns slow, or quick again, after this check. `recent` holds its last checks,
 * newest first, this one included. A spell that is open ends when the service goes down instead,
 * which `tick` sees to, as the outage says more.
 */
export function nextSlowness(
	recent: RecentCheck[],
	open: boolean,
	slowMs = SLOW_MS,
): { to: "slow" | "quick"; at: number } | undefined {
	if (open) {
		const last = recent.slice(0, QUICK_AFTER);
		const first = last.at(-1);
		if (first && last.length === QUICK_AFTER && last.every((c) => c.ok && c.ms < slowMs)) {
			return { to: "quick", at: first.at };
		}
		return undefined;
	}
	const last = recent.slice(0, SLOW_AFTER);
	const first = last.at(-1);
	if (first && last.length === SLOW_AFTER && last.every((c) => c.ok && c.ms >= slowMs)) {
		return { to: "slow", at: first.at };
	}
	return undefined;
}

/** `Answered in 4.8 s.`: what a slow spell's alert and the page say. */
export function slowAnswer(ms: number): string {
	return `Answered in ${(ms / 1000).toFixed(1)} s.`;
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

const NO_TRACK: TrackReport = { filed: 0, noted: 0, failed: 0, gaveUp: 0, misconfigured: false };

export interface TickReport {
	at: number;
	/** True when another run had checked this minute already. */
	skipped: boolean;
	results: CheckResult[];
	changes: Change[];
	alerts: { sent: number; failed: number };
	track: TrackReport;
}

/**
 * One minute's work: checks every service, keeps the results, takes services down or brings them
 * back, opens and closes incidents, sends the alerts that are due and files the incidents in Track.
 */
export async function tick(
	env: MonitorEnv,
	scheduledTime: number,
	{
		send = fetch,
		retryAfter,
		slowMs = SLOW_MS,
	}: { send?: typeof fetch; retryAfter?: number; slowMs?: number } = {},
): Promise<TickReport> {
	const services = servicesOf(env.SERVICES);
	const at = Math.floor(scheduledTime / MINUTE) * MINUTE;
	const done = await env.DB.prepare("SELECT 1 FROM check_result WHERE at = ?1 LIMIT 1")
		.bind(at)
		.first();
	if (done) {
		return {
			at,
			skipped: true,
			results: [],
			changes: [],
			alerts: { sent: 0, failed: 0 },
			track: NO_TRACK,
		};
	}

	const results = await Promise.all(
		services.map((service) => check(service, send, retryAfter === undefined ? {} : { retryAfter })),
	);
	const db = env.DB;
	const [stateRows, recentRows, slowRows] = await db.batch<unknown>([
		db.prepare("SELECT * FROM service_state"),
		// The checks before this one that a slow spell is worked out from.
		db
			.prepare(
				"SELECT service, at, ok, ms FROM check_result WHERE at >= ?1 AND at < ?2 ORDER BY at DESC",
			)
			.bind(at - SLOW_AFTER * MINUTE, at),
		db.prepare("SELECT service FROM incident WHERE kind = 'slow' AND ended_at IS NULL"),
	]);
	const states = new Map(
		((stateRows?.results ?? []) as ServiceState[]).map((row) => [row.service, row]),
	);
	const recentOf = new Map<string, RecentCheck[]>();
	type Row = { service: string; at: number; ok: number; ms: number };
	for (const row of (recentRows?.results ?? []) as Row[]) {
		const list = recentOf.get(row.service) ?? [];
		list.push({ at: row.at, ok: row.ok === 1, ms: row.ms });
		recentOf.set(row.service, list);
	}
	const slowNow = new Set(
		((slowRows?.results ?? []) as { service: string }[]).map((r) => r.service),
	);
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
					.prepare(
						"UPDATE incident SET ended_at = ?2 WHERE service = ?1 AND kind = 'down' AND ended_at IS NULL",
					)
					.bind(result.service, at),
			);
		}
		if (change) changes.push(change);

		const slow = slowNow.has(result.service);
		if (slow && state.status === "down") {
			// The outage takes over: the slow spell ends where it began, and its alerts are done, as
			// the outage's say what matters now.
			const end = change?.to === "down" ? change.at : at;
			statements.push(
				db
					.prepare(
						`UPDATE incident SET ended_at = ?2, alerted_at = COALESCE(alerted_at, ?3), resolved_alerted_at = ?3
							WHERE service = ?1 AND kind = 'slow' AND ended_at IS NULL`,
					)
					.bind(result.service, end, at),
			);
			continue;
		}
		const recent = [{ at, ok: result.ok, ms: result.ms }, ...(recentOf.get(result.service) ?? [])];
		const turn = nextSlowness(recent, slow, slowMs);
		if (turn?.to === "slow") {
			statements.push(
				db
					.prepare(
						"INSERT INTO incident (service, started_at, error, kind) VALUES (?1, ?2, ?3, 'slow')",
					)
					.bind(result.service, turn.at, slowAnswer(result.ms)),
			);
		} else if (turn?.to === "quick") {
			statements.push(
				db
					.prepare(
						"UPDATE incident SET ended_at = ?2 WHERE service = ?1 AND kind = 'slow' AND ended_at IS NULL",
					)
					.bind(result.service, turn.at),
			);
		}
		if (turn) changes.push({ service: result.service, ...turn });
	}
	if (at % HOUR === 0) {
		statements.push(db.prepare("DELETE FROM check_result WHERE at < ?1").bind(at - KEEP_CHECKS_MS));
	}
	await db.batch(statements);
	const alerts = await sendAlerts(env, services, at);
	// After the alerts, so Track being slow or down never holds an email back.
	const track = await fileIncidents(env, services, at, send);
	return { at, skipped: false, results, changes, alerts, track };
}
