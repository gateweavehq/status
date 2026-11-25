import { type Brand, brandOf } from "./brand";
import { SLOW_MS } from "./check";
import type { DayCount, Health, IncidentView, ServiceStatus, StatusData } from "./status";
import { clock, duration, when } from "./time";

/** The page's icon: a neutral mark, with no brand. */
export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>Status</title><rect width="32" height="32" rx="8" fill="#18181b"/><circle cx="16" cy="16" r="7" fill="none" stroke="#fafafa" stroke-width="3"/><circle cx="16" cy="16" r="2.6" fill="#4ade80"/></svg>`;

function esc(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

const count = (n: number) => n.toLocaleString("en-US");

/** `99.98%`, rounded down so a day with a failure never reads 100%. */
export function percent(share: number): string {
	if (share >= 1) return "100%";
	return `${(Math.floor(share * 10_000) / 100).toFixed(2)}%`;
}

const HEADLINE: Record<Health, string> = {
	up: "All services are working",
	slow: "Something is slow",
	down: "Something is down",
	unknown: "The checks have stopped",
};

const LABEL: Record<Health, string> = {
	up: "Working",
	slow: "Slow",
	down: "Down",
	unknown: "Not checked",
};

function headline(data: StatusData): string {
	for (const status of ["down", "slow"] as const) {
		if (data.status !== status) continue;
		const named = data.services.filter((s) => s.status === status);
		if (named.length === 1 && named[0]) return `${named[0].name} is ${status}`;
		if (named.length > 1) return `${named.map((s) => s.name).join(", ")} are ${status}`;
	}
	return HEADLINE[data.status];
}

function dayClass(day: DayCount | null): string {
	if (!day || day.checks === 0) return "none";
	if (day.failures === 0) return "ok";
	return day.failures <= 5 ? "minor" : "major";
}

function dayTitle(day: DayCount | null, date: string): string {
	if (!day || day.checks === 0) return `${date}: no checks`;
	if (day.failures === 0) return `${date}: all ${count(day.checks)} checks passed`;
	return `${date}: ${count(day.failures)} of ${count(day.checks)} checks failed`;
}

function serviceCard(service: ServiceStatus, now: number): string {
	const bars = service.days
		.map((day, i) => {
			const date = when(now - (service.days.length - 1 - i) * 86_400_000);
			return `<span class="bar ${dayClass(day)}" title="${esc(dayTitle(day, date))}"></span>`;
		})
		.join("");
	const uptime =
		service.uptime === null ? "No checks yet" : `${percent(service.uptime)} of checks passed`;
	const since =
		service.status === "down" && service.since !== null
			? ` since ${clock(service.since)} UTC`
			: (service.status === "up" || service.status === "slow") && service.ms !== null
				? ` · ${count(service.ms)} ms`
				: "";
	return `<article class="service">
	<div class="row"><h2>${esc(service.name)}</h2><span class="state ${service.status}"><span class="dot"></span>${LABEL[service.status]}${esc(since)}</span></div>
	<div class="bars" role="img" aria-label="${esc(`${service.name}, the last ${service.days.length} days: ${uptime}`)}">${bars}</div>
	<div class="legend"><span>${service.days.length} days ago</span><span>${esc(uptime)}</span><span>Today</span></div>
</article>`;
}

function incidentItem(incident: IncidentView, now: number): string {
	const started = `${when(incident.startedAt)}, ${clock(incident.startedAt)}`;
	const what =
		incident.endedAt === null
			? `${incident.kind} since ${started} UTC (${duration(now - incident.startedAt)} so far)`
			: `${incident.kind} for ${duration(incident.endedAt - incident.startedAt)} · ${started}–${clock(incident.endedAt)} UTC`;
	const error = incident.error ? `<p class="error">${esc(incident.error)}</p>` : "";
	return `<li class="${incident.endedAt === null ? "open" : "closed"}"><p><strong>${esc(incident.name)}</strong> ${esc(what)}</p>${error}</li>`;
}

/** The status page. It loads nothing else, and reloads itself every minute. */
export function renderPage(data: StatusData, brand: Brand = brandOf({})): string {
	const checked = data.services
		.map((s) => s.checkedAt)
		.filter((at): at is number => at !== null)
		.sort((a, b) => b - a)[0];
	const incidents =
		data.incidents.length === 0
			? `<p class="quiet">No incidents in the last 30 days.</p>`
			: `<ul class="incidents">${data.incidents.map((i) => incidentItem(i, data.now)).join("")}</ul>`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>${esc(brand.name)}</title>
<meta name="description" content="${esc(brand.description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${STYLE}</style>
</head>
<body>
<main>
<header>${brand.homeUrl ? `<a class="brand" href="${esc(brand.homeUrl)}">${FAVICON}<span>${esc(brand.name)}</span></a>` : `<span class="brand">${FAVICON}<span>${esc(brand.name)}</span></span>`}</header>
<section class="banner ${data.status}" role="status"><span class="dot"></span><div><h1>${esc(headline(data))}</h1><p>${checked === undefined ? "Not checked yet" : `Checked at ${clock(checked)} UTC, ${when(checked)}`}</p></div></section>
<section class="services">${data.services.map((s) => serviceCard(s, data.now)).join("\n")}</section>
<section><h2 class="heading">Incidents</h2>${incidents}</section>
<footer><p>Each service is checked every minute from Cloudflare's network. A failed check is tried again after two seconds, and two failed checks in a row make an incident. A service that takes more than ${SLOW_MS / 1000} seconds to answer five checks in a row is slow. Times are in UTC.</p><p><a href="/api/status">JSON</a>${brand.homeUrl ? ` · <a href="${esc(brand.homeUrl)}">${esc(new URL(brand.homeUrl).host)}</a>` : ""}</p></footer>
</main>
</body>
</html>
`;
}

const STYLE = `
:root {
	--background: oklch(1 0 0);
	--foreground: oklch(0.141 0.005 285.823);
	--muted: oklch(0.967 0.001 286.375);
	--muted-foreground: oklch(0.552 0.016 285.938);
	--card: oklch(0.985 0.002 286);
	--border: oklch(0.92 0.004 286.32);
	--accent: oklch(0.546 0.215 268);
	--ok: oklch(0.627 0.17 149);
	--minor: oklch(0.75 0.16 75);
	--major: oklch(0.577 0.215 27);
	--none: oklch(0.92 0.004 286.32);
	color-scheme: light;
}
@media (prefers-color-scheme: dark) {
	:root {
		--background: oklch(0.141 0.005 285.823);
		--foreground: oklch(0.985 0 0);
		--muted: oklch(0.21 0.006 285.885);
		--muted-foreground: oklch(0.705 0.015 286.067);
		--card: oklch(0.175 0.005 285.8);
		--border: oklch(1 0 0 / 10%);
		--accent: oklch(0.73 0.15 272);
		--ok: oklch(0.7 0.16 149);
		--minor: oklch(0.8 0.15 80);
		--major: oklch(0.66 0.2 25);
		--none: oklch(1 0 0 / 12%);
		color-scheme: dark;
	}
}
* { box-sizing: border-box; }
body {
	margin: 0;
	background: var(--background);
	color: var(--foreground);
	font: 15px/1.5 "Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	-webkit-font-smoothing: antialiased;
}
main { max-width: 760px; margin: 0 auto; padding: 32px 16px 48px; }
a { color: inherit; }
header { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; }
.brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; text-decoration: none; }
.brand svg { width: 26px; height: 26px; }
.title { color: var(--muted-foreground); }
.title::before { content: "/"; margin-right: 10px; opacity: 0.5; }
h1, h2 { margin: 0; }
.banner {
	display: flex; align-items: center; gap: 14px;
	padding: 18px 20px; border: 1px solid var(--border); border-radius: 12px; background: var(--card);
	margin-bottom: 24px;
}
.banner h1 { font-size: 18px; font-weight: 600; }
.banner p { margin: 2px 0 0; color: var(--muted-foreground); font-size: 13px; }
.banner .dot { width: 12px; height: 12px; flex: none; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--none); }
.up .dot { background: var(--ok); box-shadow: 0 0 0 4px color-mix(in oklch, var(--ok) 20%, transparent); }
.down .dot { background: var(--major); box-shadow: 0 0 0 4px color-mix(in oklch, var(--major) 20%, transparent); }
.slow .dot { background: var(--minor); box-shadow: 0 0 0 4px color-mix(in oklch, var(--minor) 20%, transparent); }
.unknown .dot { background: var(--minor); }
.services { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; margin-bottom: 32px; }
.service { padding: 16px 20px; }
.service + .service { border-top: 1px solid var(--border); }
.row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.service h2 { font-size: 15px; font-weight: 600; }
.state { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted-foreground); white-space: nowrap; }
.state.down { color: var(--major); }
.state.slow { color: var(--minor); }
.bars { display: grid; grid-template-columns: repeat(90, 1fr); gap: 2px; height: 30px; }
.bar { border-radius: 2px; background: var(--none); }
.bar.ok { background: var(--ok); }
.bar.minor { background: var(--minor); }
.bar.major { background: var(--major); }
.legend { display: flex; justify-content: space-between; gap: 8px; margin-top: 6px; font-size: 12px; color: var(--muted-foreground); }
.heading { font-size: 15px; font-weight: 600; margin-bottom: 12px; }
.incidents { list-style: none; margin: 0; padding: 0; }
.incidents li { padding: 12px 0; border-top: 1px solid var(--border); }
.incidents li:first-child { border-top: 0; padding-top: 0; }
.incidents p { margin: 0; }
.incidents .open strong { color: var(--major); }
.error { color: var(--muted-foreground); font-size: 13px; }
.quiet { color: var(--muted-foreground); margin: 0; }
footer { margin-top: 40px; color: var(--muted-foreground); font-size: 13px; }
footer p { margin: 0 0 6px; }
@media (max-width: 480px) {
	.bars { gap: 1px; height: 26px; }
	.row { flex-wrap: wrap; }
	.legend span:nth-child(2) { text-align: center; }
}
`;
