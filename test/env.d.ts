// The bindings only the tests have (vitest.config.ts).
declare namespace Cloudflare {
	interface Env {
		TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
	}
}

declare module "*.jsonc?raw" {
	const text: string;
	export default text;
}
