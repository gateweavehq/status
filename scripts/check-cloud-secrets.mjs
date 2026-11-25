// Preflight of `pnpm run deploy:cloud`: refuses to go on unless the live Worker has the secrets the
// error watch needs. It reads the secrets' names only (`wrangler secret list`), never a value, and
// prints only the names that are missing. Nothing is changed in Cloudflare.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CLOUD_SECRETS, missingSecrets } from "./secrets.mjs";

const wrangler = join(import.meta.dirname, "..", "node_modules", "wrangler", "bin", "wrangler.js");
const run = spawnSync(
	process.execPath,
	[wrangler, "secret", "list", "--env", "cloud", "--format", "json"],
	{ encoding: "utf8", cwd: join(import.meta.dirname, "..") },
);
if (run.status !== 0) {
	// Wrangler's error text can name the account, so it is not printed here.
	console.error("Could not list the Worker's secrets, so nothing was deployed.");
	console.error("Set CLOUDFLARE_ACCOUNT_ID to Gateweave's account and log in to it (or set");
	console.error(
		"CLOUDFLARE_API_TOKEN), then run again. `npx wrangler secret list --env cloud` shows why.",
	);
	process.exit(1);
}
let missing;
try {
	missing = missingSecrets(run.stdout);
} catch (error) {
	console.error(`${error.message} Nothing was deployed.`);
	process.exit(1);
}
if (missing.length > 0) {
	console.error(`The Worker lacks the secret(s) ${missing.join(", ")}, so nothing was deployed.`);
	console.error(
		"Without them every scheduled run fails (the checks and alerts still run). Set them:",
	);
	for (const name of CLOUD_SECRETS) console.error(`  npx wrangler secret put ${name} --env cloud`);
	process.exit(1);
}
console.log("The Worker has the secrets the error watch needs.");
