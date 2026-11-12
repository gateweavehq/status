const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** `14:02`, in UTC. */
export function clock(at: number): string {
	return new Date(at).toISOString().slice(11, 16);
}

/** `12 Nov 2026`, in UTC. */
export function when(at: number): string {
	const date = new Date(at);
	return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** The UTC day, `2026-11-12`. */
export function dayOf(at: number): string {
	return new Date(at).toISOString().slice(0, 10);
}

/** `7 min`, `2 h 5 min`, `3 d 4 h`. Under a minute counts as one. */
export function duration(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / MINUTE));
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
	const days = Math.floor(hours / 24);
	return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}
