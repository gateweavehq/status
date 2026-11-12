import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./test/wrangler.jsonc" },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: await readD1Migrations(join(import.meta.dirname, "migrations")),
				},
				// Every fetch the Worker makes reaches the stand-in for the services it checks.
				outboundService: "targets",
				workers: [
					{
						name: "targets",
						modules: true,
						scriptPath: join(import.meta.dirname, "test", "target-worker.js"),
						compatibilityDate: "2026-11-01",
					},
				],
			},
		})),
	],
	test: {
		setupFiles: ["./test/apply-migrations.ts"],
		testTimeout: 30_000,
	},
});
