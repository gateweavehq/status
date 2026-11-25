/** What names the page and the messages it sends. Every one may be left out. */
export interface BrandEnv {
	/** The page's name: its title, its heading and what alerts sign with. */
	PAGE_NAME?: string;
	/** The page's description for search results and link previews. */
	PAGE_DESCRIPTION?: string;
	/** The page's own address, for links in alerts and issues and in the user agent. */
	PAGE_URL?: string;
	/** Where the heading and the footer link to, such as your own site. */
	HOME_URL?: string;
}

export interface Brand {
	name: string;
	description: string;
	pageUrl: string | undefined;
	homeUrl: string | undefined;
}

export const DEFAULT_NAME = "Status";
export const DEFAULT_DESCRIPTION =
	"Whether our services are working, checked every minute, and their last 90 days.";

function text(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/** An address the page may link to: an http(s) URL, or nothing. */
function link(value: string | undefined): string | undefined {
	const trimmed = text(value);
	if (!trimmed) return undefined;
	try {
		const url = new URL(trimmed);
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

export function brandOf(env: BrandEnv): Brand {
	return {
		name: text(env.PAGE_NAME) ?? DEFAULT_NAME,
		description: text(env.PAGE_DESCRIPTION) ?? DEFAULT_DESCRIPTION,
		pageUrl: link(env.PAGE_URL),
		homeUrl: link(env.HOME_URL),
	};
}

/** What the checks call themselves to the services they fetch. */
export function userAgentOf(env: BrandEnv): string {
	const pageUrl = link(env.PAGE_URL);
	return pageUrl ? `StatusMonitor/1 (+${pageUrl})` : "StatusMonitor/1";
}
