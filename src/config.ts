/** A service the Worker checks, as `SERVICES` in wrangler.jsonc names it. */
export interface Service {
	/** Short and stable: incidents and history are kept under it. */
	id: string;
	name: string;
	url: string;
	/** The status the URL answers when the service works. */
	expect: number;
	/** Text the body holds when the service works, if its status alone doesn't say. */
	contains?: string;
}

/** A setting the Worker can't run with. Its message says which and why. */
export class ConfigError extends Error {
	override name = "ConfigError";
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Reads `SERVICES`, refusing anything it can't check as written. */
export function servicesOf(value: unknown): Service[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new ConfigError("SERVICES is a list of services to check.");
	}
	const seen = new Set<string>();
	return value.map((item: unknown, index) => {
		const where = `SERVICES[${index}]`;
		if (typeof item !== "object" || item === null)
			throw new ConfigError(`${where} isn't an object.`);
		const { id, name, url, expect = 200, contains } = item as Record<string, unknown>;
		if (typeof id !== "string" || !ID.test(id)) {
			throw new ConfigError(`${where}.id is lower-case letters, digits and dashes, up to 32.`);
		}
		if (seen.has(id)) throw new ConfigError(`${where}.id "${id}" is there twice.`);
		seen.add(id);
		if (typeof name !== "string" || name.trim() === "" || name.length > 40) {
			throw new ConfigError(`${where}.name is a name of up to 40 characters.`);
		}
		let parsed: URL;
		try {
			parsed = new URL(typeof url === "string" ? url : "");
		} catch {
			throw new ConfigError(`${where}.url isn't a URL.`);
		}
		if (parsed.protocol !== "https:") throw new ConfigError(`${where}.url is an https URL.`);
		if (typeof expect !== "number" || !Number.isInteger(expect) || expect < 100 || expect > 599) {
			throw new ConfigError(`${where}.expect is an HTTP status, such as 200.`);
		}
		if (contains !== undefined && (typeof contains !== "string" || contains === "")) {
			throw new ConfigError(`${where}.contains is text the body holds.`);
		}
		return { id, name: name.trim(), url: parsed.href, expect, ...(contains ? { contains } : {}) };
	});
}
