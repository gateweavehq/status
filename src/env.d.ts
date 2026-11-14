// What wrangler.jsonc can't declare: secrets, and settings a deployment may leave out.
interface StatusSettings {
	/** Where alerts go: one address or a comma-separated list. Without it, no alerts are sent. */
	ALERT_TO?: string;
	/** The page alerts link to, https://status.gateweave.com when it isn't set. */
	PAGE_URL?: string;
	/**
	 * An API token that may read the account's and the zone's analytics, for the error watch
	 * (ERROR_WATCH). Without it, the watch doesn't run.
	 */
	ANALYTICS_TOKEN?: string;
	/**
	 * Filing each incident as an issue in Track, with the comment when it ends. Without all four
	 * of the first, nothing is filed. TRACK_KEY is an agent member's key, a secret.
	 */
	TRACK_URL?: string;
	TRACK_WORKSPACE?: string;
	TRACK_TEAM?: string;
	TRACK_LABELS?: string;
	TRACK_KEY?: string;
}

interface Env extends StatusSettings {}

declare namespace Cloudflare {
	interface Env extends StatusSettings {}
}
