import type { Incident } from "./alerts";
import { type Service, servicesOf } from "./config";
import type { ServiceState } from "./monitor";
import { DAY, dayOf, MINUTE } from "./time";

/** Days the page draws. */
export const DAYS = 90;
/** Incidents the page lists go back this far, and open ones however far. */
export const INCIDENT_DAYS = 30;
/** A service not checked for this long is shown as unknown: the checks themselves stopped. */
export const STALE_MS = 5 * MINUTE;

/** Slow: it answers, but has taken longer than SLOW_MS for a while (see monitor.ts). */
export type Health = "up" | "slow" | "down" | "unknown";

export interface DayCount {
	day: string;
	checks: number;
	failures: number;
}

export interface ServiceStatus {
	id: string;
	name: string;
	status: Health;
	/** Since when it has been up, slow or down. */
	since: number | null;
	checkedAt: number | null;
	ms: number | null;
	/** The share of checks that passed over the days drawn, or null with none. */
	uptime: number | null;
	/** One entry per day drawn, oldest first; a day without checks has none. */
	days: (DayCount | null)[];
}

export interface IncidentView {
	service: string;
	name: string;
	kind: Incident["kind"];
	startedAt: number;
	endedAt: number | null;
	error: string | null;
}

export interface StatusData {
	now: number;
	status: Health;
	services: ServiceStatus[];
	incidents: IncidentView[];
}

/**
 * When the last check ran, for any service: what a monitor outside Cloudflare asks to learn that
 * the checks themselves stopped, which the page alone tells it only in words. Null before any.
 */
export async function lastCheckAt(env: { DB: D1Database }): Promise<number | null> {
	const row = await env.DB.prepare("SELECT MAX(checked_at) AS at FROM service_state").first<{
		at: number | null;
	}>();
	return row?.at ?? null;
}

/** Where every service stands now, its last 90 days, and the recent incidents. */
export async function statusData(
	env: { DB: D1Database; SERVICES: unknown },
	now: number,
): Promise<StatusData> {
	const services = servicesOf(env.SERVICES);
	const first = dayOf(now - (DAYS - 1) * DAY);
	const [states, counts, incidents] = await env.DB.batch<unknown>([
		env.DB.prepare("SELECT * FROM service_state"),
		env.DB.prepare("SELECT service, day, checks, failures FROM daily WHERE day >= ?1").bind(first),
		env.DB.prepare(
			`SELECT * FROM incident WHERE started_at >= ?1 OR ended_at IS NULL
				ORDER BY (ended_at IS NULL) DESC, started_at DESC, id DESC LIMIT 20`,
		).bind(now - INCIDENT_DAYS * DAY),
	]);
	const stateOf = new Map(
		((states?.results ?? []) as ServiceState[]).map((row) => [row.service, row]),
	);
	const countsOf = new Map<string, Map<string, DayCount>>();
	for (const row of (counts?.results ?? []) as (DayCount & { service: string })[]) {
		const days = countsOf.get(row.service) ?? new Map<string, DayCount>();
		days.set(row.day, { day: row.day, checks: row.checks, failures: row.failures });
		countsOf.set(row.service, days);
	}
	const rows = (incidents?.results ?? []) as Incident[];
	const openSlow = new Map(
		rows
			.filter((incident) => incident.kind === "slow" && incident.ended_at === null)
			.map((incident) => [incident.service, incident.started_at]),
	);
	const openManual = new Map(
		rows
			.filter((incident) => incident.kind === "manual" && incident.ended_at === null)
			.map((incident) => [incident.service, incident.started_at]),
	);
	const viewOf = (service: Service): ServiceStatus => {
		const state = stateOf.get(service.id);
		const slowSince = openSlow.get(service.id);
		const manualSince = openManual.get(service.id);
		const stale = !state || now - state.checked_at > STALE_MS;
		const days = Array.from({ length: DAYS }, (_, i) => {
			const day = dayOf(now - (DAYS - 1 - i) * DAY);
			return countsOf.get(service.id)?.get(day) ?? null;
		});
		let checks = 0;
		let failures = 0;
		for (const day of days) {
			checks += day?.checks ?? 0;
			failures += day?.failures ?? 0;
		}
		const status: Health = stale
			? "unknown"
			: manualSince !== undefined
				? "down"
				: state.status === "up" && slowSince !== undefined
					? "slow"
					: state.status;
		return {
			id: service.id,
			name: service.name,
			status,
			since:
				status === "slow"
					? (slowSince ?? null)
					: manualSince !== undefined
						? manualSince
						: (state?.since ?? null),
			checkedAt: state?.checked_at ?? null,
			ms: state?.last_ms ?? null,
			uptime: checks === 0 ? null : (checks - failures) / checks,
			days,
		};
	};
	const views = services.map(viewOf);
	const names = new Map(services.map((s) => [s.id, s.name]));
	return {
		now,
		status: views.some((s) => s.status === "down")
			? "down"
			: views.some((s) => s.status === "unknown")
				? "unknown"
				: views.some((s) => s.status === "slow")
					? "slow"
					: "up",
		services: views,
		incidents: rows
			.filter((incident) => names.has(incident.service))
			.map((incident) => ({
				service: incident.service,
				name: names.get(incident.service) ?? incident.service,
				kind: incident.kind,
				startedAt: incident.started_at,
				endedAt: incident.ended_at,
				error: incident.error,
			})),
	};
}
