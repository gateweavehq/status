import { servicesOf } from "./config";

/** Settings the signed manual-entry endpoint needs. Without MANUAL_KEY it is off. */
export interface ManualEnv {
	DB: D1Database;
	SERVICES: unknown;
	MANUAL_KEY?: string;
}

const TEXT_LIMIT = 500;
const MIN_KEY_LENGTH = 32;
const MIN_AT = Date.UTC(2000, 0, 1);
const MAX_AT = Date.UTC(2100, 0, 1);

function bytesOf(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

async function sameSecret(given: string, secret: string): Promise<boolean> {
	// Hash first so the comparison's length does not depend on the secret, then compare every byte.
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", bytesOf(given)),
		crypto.subtle.digest("SHA-256", bytesOf(secret)),
	]);
	const left = new Uint8Array(a);
	const right = new Uint8Array(b);
	let diff = 0;
	for (let i = 0; i < left.length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
	return diff === 0;
}

function json(text: string, status: number, extra: Record<string, unknown> = {}): Response {
	const body = status < 400 ? { ok: true, ...extra } : { ok: false, error: text };
	return Response.json(body, { status });
}

function timestamp(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
	if (value < MIN_AT || value > MAX_AT) return undefined;
	return value;
}

function cleanText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (text === "" || text.length > TEXT_LIMIT) return undefined;
	// The page escapes HTML; control characters would only make the public notice harder to read.
	for (const char of text) {
		const code = char.charCodeAt(0);
		if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return undefined;
	}
	return text;
}

async function authorized(request: Request, secret: string): Promise<boolean> {
	const header = request.headers.get("authorization") ?? "";
	const match = /^Bearer\s+(.+)$/i.exec(header);
	return match?.[1] !== undefined && (await sameSecret(match[1], secret));
}

/**
 * Writes a manual incident or maintenance window. The endpoint is off unless MANUAL_KEY is a random
 * secret of at least 32 characters, and then admits only `Authorization: Bearer <key>`.
 */
export async function postManual(request: Request, env: ManualEnv): Promise<Response> {
	const secret = env.MANUAL_KEY?.trim() ?? "";
	if (secret.length < MIN_KEY_LENGTH) return json("Manual posting is not configured.", 404);
	if (!(await authorized(request, secret))) return json("Unauthorized.", 401);
	if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
		return json("Send JSON.", 415);
	}
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json("The body is not JSON.", 400);
	}
	if (typeof body !== "object" || body === null) return json("The body is not an object.", 400);
	const input = body as Record<string, unknown>;
	const now = Date.now();
	if (input.action === "end") {
		const id = typeof input.id === "number" && Number.isInteger(input.id) ? input.id : 0;
		const endedAt = input.endedAt === undefined ? now : timestamp(input.endedAt);
		if (id <= 0 || endedAt === undefined)
			return json("Give the incident id and a valid end time.", 400);
		if (endedAt > now) return json("An incident does not end in the future.", 400);
		const ended = await env.DB.prepare(
			`UPDATE incident SET ended_at = ?2 WHERE id = ?1 AND kind = 'manual'
				AND ended_at IS NULL AND started_at < ?2 RETURNING ended_at`,
		)
			.bind(id, endedAt)
			.first<{ ended_at: number }>();
		if (ended) return json("Ended.", 200, { id, endedAt: ended.ended_at });
		const entry = await env.DB.prepare(
			"SELECT ended_at FROM incident WHERE id = ?1 AND kind = 'manual'",
		)
			.bind(id)
			.first<{ ended_at: number | null }>();
		if (!entry) return json("No manual incident has that id.", 404);
		if (entry.ended_at !== null) return json("That manual incident has already ended.", 409);
		return json("endedAt is after the entry's start.", 400);
	}
	if (input.action !== undefined && input.action !== "post") {
		return json("action is post or end.", 400);
	}
	const kind =
		input.kind === "incident" ? "manual" : input.kind === "maintenance" ? "maintenance" : "";
	if (!kind) return json("kind is incident or maintenance.", 400);
	const service = typeof input.service === "string" ? input.service : "";
	if (!servicesOf(env.SERVICES).some((known) => known.id === service)) {
		return json("service is not one of SERVICES.", 400);
	}
	const text = cleanText(input.text);
	if (!text) return json(`text is 1 to ${TEXT_LIMIT} printable characters.`, 400);
	const startedAt = input.startedAt === undefined ? now : timestamp(input.startedAt);
	if (startedAt === undefined) return json("startedAt is a valid millisecond time.", 400);
	if (kind === "manual" && startedAt > now + 60_000) {
		return json("An incident does not start in the future.", 400);
	}
	let endedAt: number | null = null;
	if (input.endedAt !== undefined && input.endedAt !== null) {
		const parsedEnd = timestamp(input.endedAt);
		if (parsedEnd === undefined) return json("endedAt is a valid millisecond time.", 400);
		endedAt = parsedEnd;
	}
	if (endedAt !== null && endedAt <= startedAt) return json("endedAt is after startedAt.", 400);
	if (kind === "manual" && endedAt !== null && endedAt > now)
		return json("An incident does not end in the future.", 400);
	if (kind === "maintenance" && endedAt === null) return json("Maintenance needs endedAt.", 400);
	const result = await env.DB.prepare(
		"INSERT INTO incident (service, started_at, ended_at, error, kind) VALUES (?1, ?2, ?3, ?4, ?5)",
	)
		.bind(service, startedAt, endedAt, text, kind)
		.run();
	return json("Posted.", 201, { id: result.meta.last_row_id, kind, service, startedAt, endedAt });
}
