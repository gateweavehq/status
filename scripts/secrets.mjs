/**
 * The secrets Gateweave Cloud's deployment needs before `pnpm run deploy:cloud` may go ahead: the
 * error watch reads its account and zone ids from them, because the public `wrangler.jsonc` names
 * neither. Without them every scheduled run fails (see docs/self-hosting.md).
 */
export const CLOUD_SECRETS = ["ERROR_WATCH_ACCOUNT", "ERROR_WATCH_ZONE"];

/**
 * The names in `required` that `wrangler secret list --format json` did not list. `output` is
 * that command's text: a JSON array of `{ name, type }`, possibly with log lines around it. Only
 * names are ever read; Wrangler does not return values. Throws when no list can be found, so that
 * an unreadable answer never counts as "present".
 *
 * @param {string} output
 * @param {readonly string[]} required
 * @returns {string[]}
 */
export function missingSecrets(output, required = CLOUD_SECRETS) {
	const from = output.indexOf("[");
	const to = output.lastIndexOf("]");
	if (from === -1 || to < from) throw new Error("Wrangler's answer holds no list of secrets.");
	let list;
	try {
		list = JSON.parse(output.slice(from, to + 1));
	} catch {
		throw new Error("Wrangler's answer holds no list of secrets.");
	}
	if (!Array.isArray(list)) throw new Error("Wrangler's answer holds no list of secrets.");
	const names = new Set(
		list.map((secret) => secret?.name).filter((name) => typeof name === "string"),
	);
	return required.filter((name) => !names.has(name));
}
