import type { Service } from "./config";
import { ConfigError } from "./config";
import { clock, duration, when } from "./time";

/** The settings alerts need. Without ALERT_TO, incidents are only shown on the page. */
export interface AlertEnv {
	DB: D1Database;
	ALERT_FROM?: string;
	ALERT_TO?: string;
	EMAIL?: SendEmail;
	PAGE_URL?: string;
}

/** An incident as the database keeps it. */
export interface Incident {
	id: number;
	service: string;
	started_at: number;
	ended_at: number | null;
	error: string | null;
	alerted_at: number | null;
	resolved_alerted_at: number | null;
}

/** Alerts that couldn't go are tried again on later checks for this long. */
export const ALERT_RETRY_MS = 3 * 24 * 60 * 60 * 1000;

const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

interface Mail {
	from: string | EmailAddress;
	to: string[];
}

/** Where alerts go, or undefined when nowhere is set up. A setting that is wrong is refused. */
export function mailOf(env: AlertEnv): Mail | undefined {
	const to = (env.ALERT_TO ?? "")
		.split(",")
		.map((address) => address.trim())
		.filter((address) => address !== "");
	if (to.length === 0) return undefined;
	for (const address of to) {
		if (!ADDRESS.test(address))
			throw new ConfigError("ALERT_TO holds something that isn't an address.");
	}
	if (!env.EMAIL) throw new ConfigError("Alerts by email need the EMAIL binding.");
	const value = env.ALERT_FROM?.trim() ?? "";
	const named = /^(.*?)\s*<([^<>]+)>$/.exec(value);
	const email = (named?.[2] ?? value).trim();
	if (!ADDRESS.test(email)) throw new ConfigError("ALERT_FROM isn't an email address.");
	const name = named?.[1]?.trim().replace(/^"(.*)"$/, "$1");
	return { from: name ? { name, email } : email, to };
}

export interface AlertMessage {
	subject: string;
	text: string;
}

/** What to say about an incident: that it started, that it ended, or both at once. */
export function messageFor(
	incident: Incident,
	service: Pick<Service, "name" | "url">,
	pageUrl: string,
): AlertMessage {
	const { name } = service;
	const started = `${clock(incident.started_at)} UTC on ${when(incident.started_at)}`;
	const footer = ["", `Status: ${pageUrl}`, "", "--", "Gateweave Status checks every minute."];
	if (incident.ended_at === null) {
		return {
			subject: `${name} is down`,
			text: [
				`${name} has failed every check since ${started}.`,
				`The last one: ${incident.error ?? "it failed"}`,
				`Checked: ${service.url}`,
				...footer,
			].join("\n"),
		};
	}
	const lasted = duration(incident.ended_at - incident.started_at);
	if (incident.alerted_at === null) {
		return {
			subject: `${name} was down for ${lasted}`,
			text: [
				`${name} failed every check from ${started} until ${clock(incident.ended_at)} UTC.`,
				`What it answered: ${incident.error ?? "it failed"}`,
				...footer,
			].join("\n"),
		};
	}
	return {
		subject: `${name} is back up`,
		text: [
			`${name} works again since ${clock(incident.ended_at)} UTC, after ${lasted} down (from ${started}).`,
			...footer,
		].join("\n"),
	};
}

/**
 * Sends what is due about recent incidents and notes it, so each goes once. One that can't go is
 * tried again on the next check, for up to three days.
 */
export async function sendAlerts(
	env: AlertEnv,
	services: Service[],
	at: number,
): Promise<{ sent: number; failed: number }> {
	const mail = mailOf(env);
	if (!mail || !env.EMAIL) return { sent: 0, failed: 0 };
	const due = await env.DB.prepare(
		`SELECT * FROM incident
			WHERE COALESCE(ended_at, started_at) >= ?1
			AND (alerted_at IS NULL OR (ended_at IS NOT NULL AND resolved_alerted_at IS NULL))
			ORDER BY started_at, id`,
	)
		.bind(at - ALERT_RETRY_MS)
		.all<Incident>();
	const pageUrl = env.PAGE_URL ?? "https://status.gateweave.com";
	let sent = 0;
	let failed = 0;
	for (const incident of due.results) {
		const service = services.find((s) => s.id === incident.service) ?? {
			name: incident.service,
			url: "",
		};
		const { subject, text } = messageFor(incident, service, pageUrl);
		try {
			await env.EMAIL.send({ from: mail.from, to: mail.to, subject, text });
		} catch {
			failed++;
			continue;
		}
		sent++;
		// An incident that ended is told once, whether it was told before or not.
		const ended = incident.ended_at !== null;
		await env.DB.prepare(
			"UPDATE incident SET alerted_at = COALESCE(alerted_at, ?2), resolved_alerted_at = ?3 WHERE id = ?1",
		)
			.bind(incident.id, at, ended ? at : null)
			.run();
	}
	return { sent, failed };
}
