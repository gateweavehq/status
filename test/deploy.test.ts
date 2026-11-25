import { describe, expect, it } from "vitest";
import { CLOUD_SECRETS, missingSecrets } from "../scripts/secrets.mjs";
import { type BrandEnv, brandOf, userAgentOf } from "../src/brand";
import { servicesOf } from "../src/config";
import { errorWatchOf } from "../src/errors";
import wranglerText from "../wrangler.jsonc?raw";

/** Reads JSONC: drops comments and trailing commas outside strings. */
function jsonc(text: string): unknown {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j;
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else {
			out += c;
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

describe("wrangler.jsonc env.cloud", () => {
	const config = jsonc(wranglerText) as {
		name: string;
		routes: { pattern: string }[];
		env: { cloud: { name: string; routes: { pattern: string }[]; vars: Record<string, unknown> } };
	};
	const cloud = config.env.cloud;

	it("keeps its own Worker name and route, which Wrangler would otherwise derive or inherit", () => {
		expect(cloud.name).toBe("gateweave-status");
		expect(cloud.name).not.toBe(config.name);
		expect(cloud.routes[0]?.pattern).toBe("status.gateweave.com");
		expect(cloud.routes[0]?.pattern).not.toBe(config.routes[0]?.pattern);
	});

	it("has services the Worker accepts", () => {
		const services = servicesOf(cloud.vars.SERVICES);
		expect(services.length).toBeGreaterThan(0);
	});

	it("has an error watch the Worker accepts once the two secrets give it its ids", () => {
		const ids = { account: "a".repeat(32), zone: "b".repeat(32) };
		const watch = errorWatchOf(cloud.vars.ERROR_WATCH, ids);
		expect(watch?.hosts.length).toBeGreaterThan(0);
		expect(watch?.scripts.length).toBeGreaterThan(0);
		expect(watch?.account).toBe(ids.account);
		expect(watch?.zone).toBe(ids.zone);
		// The file itself names neither id.
		expect(() => errorWatchOf(cloud.vars.ERROR_WATCH)).toThrow("account");
	});

	it("has the page's name and addresses, which the brand and the user agent take", () => {
		const vars = cloud.vars as BrandEnv;
		expect(brandOf(vars).name).toBe("Gateweave Status");
		expect(userAgentOf(vars)).toBe("StatusMonitor/1 (+https://status.gateweave.com/)");
	});
});

describe("the cloud deploy's secrets preflight", () => {
	const list = (...names: string[]) =>
		JSON.stringify(names.map((name) => ({ name, type: "secret_text" })));

	it("needs the two secrets the error watch reads its ids from", () => {
		expect(CLOUD_SECRETS).toEqual(["ERROR_WATCH_ACCOUNT", "ERROR_WATCH_ZONE"]);
	});

	it("passes when both are listed, among others", () => {
		expect(
			missingSecrets(list("ALERT_TO", "ERROR_WATCH_ACCOUNT", "ERROR_WATCH_ZONE", "TRACK_KEY")),
		).toEqual([]);
	});

	it("names each one that is not listed", () => {
		expect(missingSecrets(list("ALERT_TO", "ANALYTICS_TOKEN", "TRACK_KEY"))).toEqual([
			"ERROR_WATCH_ACCOUNT",
			"ERROR_WATCH_ZONE",
		]);
		expect(missingSecrets(list("ERROR_WATCH_ACCOUNT"))).toEqual(["ERROR_WATCH_ZONE"]);
		expect(missingSecrets("[]")).toEqual(CLOUD_SECRETS);
	});

	it("reads a list that has log lines around it", () => {
		const output = ` ⛅️ wrangler 4.158.0\n${list("ERROR_WATCH_ACCOUNT", "ERROR_WATCH_ZONE")}\n`;
		expect(missingSecrets(output)).toEqual([]);
	});

	it("never takes an answer it cannot read for 'present'", () => {
		for (const output of ["", "no list", "[not json]", '{"name":"ERROR_WATCH_ZONE"}']) {
			expect(() => missingSecrets(output), output).toThrow("no list of secrets");
		}
	});
});
