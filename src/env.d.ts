// What wrangler.jsonc can't declare: secrets, and settings a deployment may leave out.
interface StatusSettings {
	/** Where alerts go: one address or a comma-separated list. Without it, no alerts are sent. */
	ALERT_TO?: string;
	/** The page's name: its title, heading and what alerts sign with. "Status" when it isn't set. */
	PAGE_NAME?: string;
	/** The page's description for search results and link previews. */
	PAGE_DESCRIPTION?: string;
	/** The page's own address, for links in alerts and issues. Without it, they carry no link. */
	PAGE_URL?: string;
	/** Where the heading and the footer link to, such as your own site. Without it, no link. */
	HOME_URL?: string;
	/**
	 * An API token that may read the account's and the zone's analytics, for the error watch
	 * (ERROR_WATCH). Without it, the watch doesn't run.
	 */
	ANALYTICS_TOKEN?: string;
	/**
	 * The account's and the zone's ids for the error watch, when ERROR_WATCH leaves them out (secrets,
	 * so that a public wrangler.jsonc names neither). `account` and `zone` in ERROR_WATCH win.
	 */
	ERROR_WATCH_ACCOUNT?: string;
	ERROR_WATCH_ZONE?: string;
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
