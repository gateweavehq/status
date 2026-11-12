// What wrangler.jsonc can't declare: secrets, and settings a deployment may leave out.
interface StatusSettings {
	/** Where alerts go: one address or a comma-separated list. Without it, no alerts are sent. */
	ALERT_TO?: string;
	/** The page alerts link to, https://status.gateweave.com when it isn't set. */
	PAGE_URL?: string;
}

interface Env extends StatusSettings {}

declare namespace Cloudflare {
	interface Env extends StatusSettings {}
}
