import type { Service } from "./config";

/** How one check of a service went. Errors describe the answer, never its body. */
export interface CheckResult {
	service: string;
	ok: boolean;
	/** The status it answered, or null when it didn't. */
	status: number | null;
	/** How long the answer took, in milliseconds. */
	ms: number;
	error: string | null;
}

export const TIMEOUT_MS = 10_000;
/** A failed check is tried once more after this, so one dropped request isn't an outage. */
export const RETRY_AFTER_MS = 2_000;
/** Bodies are read this far for `contains`; health answers are short. */
const BODY_LIMIT = 64 * 1024;

const USER_AGENT = "GateweaveStatus/1 (+https://status.gateweave.com)";

/** Checks a service once. */
export async function checkOnce(
	service: Service,
	send: typeof fetch = fetch,
	timeout = TIMEOUT_MS,
): Promise<CheckResult> {
	const started = Date.now();
	const result = (ok: boolean, status: number | null, error: string | null): CheckResult => ({
		service: service.id,
		ok,
		status,
		ms: Date.now() - started,
		error,
	});
	let response: Response;
	try {
		response = await send(service.url, {
			// A redirect is an answer of its own: following it would check another page.
			redirect: "manual",
			headers: { "user-agent": USER_AGENT },
			signal: AbortSignal.timeout(timeout),
		});
	} catch (error) {
		const timedOut = error instanceof Error && error.name === "TimeoutError";
		return result(false, null, timedOut ? `No answer in ${timeout / 1000} s.` : "No connection.");
	}
	if (response.status !== service.expect) {
		await response.body?.cancel();
		return result(false, response.status, `Answered ${response.status}, not ${service.expect}.`);
	}
	if (service.contains !== undefined) {
		let body: string;
		try {
			body = await readUpTo(response, BODY_LIMIT);
		} catch {
			return result(false, response.status, "The answer broke off.");
		}
		if (!body.includes(service.contains)) {
			return result(false, response.status, "The answer isn't the one expected.");
		}
	} else {
		await response.body?.cancel();
	}
	return result(true, response.status, null);
}

/** Checks a service, and once more after a short wait if that failed. */
export async function check(
	service: Service,
	send: typeof fetch = fetch,
	{ timeout = TIMEOUT_MS, retryAfter = RETRY_AFTER_MS } = {},
): Promise<CheckResult> {
	const first = await checkOnce(service, send, timeout);
	if (first.ok) return first;
	await new Promise((done) => setTimeout(done, retryAfter));
	return checkOnce(service, send, timeout);
}

async function readUpTo(response: Response, limit: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let read = 0;
	while (read < limit) {
		const { done, value } = await reader.read();
		if (done) return text + decoder.decode();
		read += value.length;
		text += decoder.decode(value, { stream: true });
	}
	await reader.cancel();
	return text;
}
