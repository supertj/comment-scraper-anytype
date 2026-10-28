// The few calls the import makes to the Anytype API that the desktop app serves on this
// computer. Request and response shapes follow the official OpenAPI file for API version
// 2025-11-08: https://developers.anytype.io/docs/reference

export const API_VERSION = '2025-11-08';
export const DEFAULT_API_URL = 'http://127.0.0.1:31009';

export interface Space {
	id: string;
	name: string;
}

export interface Property {
	id: string;
	key: string;
	format: string;
}

export type PropertyValue = { key: string; text: string } | { key: string; url: string };

export interface CreateObjectRequest {
	name: string;
	type_key: string;
	body: string;
	properties?: PropertyValue[];
}

export class AnytypeError extends Error {
	constructor(
		message: string,
		readonly status: number | null = null,
	) {
		super(message);
	}
}

interface Page<T> {
	data?: T[];
	pagination?: { has_more?: boolean };
}

/** Largest page size the API accepts. */
const PAGE_SIZE = 1000;

/**
 * The API allows bursts of 60 requests, then one a second. A 429 is waited out and retried a
 * few times; anything else is reported straight away.
 */
const RATE_LIMIT_RETRIES = 5;
const RATE_LIMIT_WAIT_MS = 1500;

/**
 * Only loopback addresses. The API key opens the whole vault and the API speaks plain HTTP,
 * so it shouldn't be sent anywhere else by accident.
 */
export function checkApiUrl(url: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new AnytypeError(`"${url}" isn't a web address.`);
	}
	if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
		throw new AnytypeError(`The Anytype API runs on this computer, so its address has to start with http://127.0.0.1 or http://localhost (got ${parsed.origin}).`);
	}
	return parsed;
}

export class AnytypeClient {
	private readonly baseUrl: string;

	constructor(
		apiUrl: string,
		private readonly apiKey: string,
		private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	) {
		this.baseUrl = checkApiUrl(apiUrl).origin;
	}

	async listSpaces(): Promise<Space[]> {
		return this.listAll<Space>('/v1/spaces');
	}

	async listProperties(spaceId: string): Promise<Property[]> {
		return this.listAll<Property>(`/v1/spaces/${encodeURIComponent(spaceId)}/properties`);
	}

	async createObject(spaceId: string, object: CreateObjectRequest): Promise<{ id: string }> {
		const response = await this.request<{ object?: { id?: string } }>('POST', `/v1/spaces/${encodeURIComponent(spaceId)}/objects`, object);
		return { id: response.object?.id ?? '' };
	}

	private async listAll<T extends { id: string }>(path: string): Promise<T[]> {
		const items = new Map<string, T>();
		for (let offset = 0; ; ) {
			const page = await this.request<Page<T>>('GET', `${path}?offset=${offset}&limit=${PAGE_SIZE}`);
			const data = page.data ?? [];
			let added = 0;
			for (const item of data) {
				if (items.has(item.id)) continue;
				items.set(item.id, item);
				added++;
			}
			// A page with nothing new also ends the list, so a server that ignores the offset
			// can't keep the import asking forever.
			if (!page.pagination?.has_more || added === 0) return [...items.values()];
			offset += data.length;
		}
	}

	private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			let response: Response;
			try {
				response = await fetch(this.baseUrl + path, {
					method,
					headers: {
						Authorization: `Bearer ${this.apiKey}`,
						'Anytype-Version': API_VERSION,
						...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				});
			} catch {
				throw new AnytypeError(`Couldn't reach Anytype at ${this.baseUrl}. Is the desktop app open and signed in?`);
			}
			if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
				await response.body?.cancel();
				await this.wait(RATE_LIMIT_WAIT_MS * (attempt + 1));
				continue;
			}
			const text = await response.text();
			if (!response.ok) throw new AnytypeError(errorMessage(response.status, text), response.status);
			try {
				return JSON.parse(text) as T;
			} catch {
				throw new AnytypeError(`Anytype sent a response that isn't JSON (HTTP ${response.status}).`, response.status);
			}
		}
	}
}

function errorMessage(status: number, text: string): string {
	if (status === 401) return 'Anytype turned down the API key. Create a new one in Anytype under Settings → API Keys.';
	let detail = '';
	try {
		const parsed = JSON.parse(text) as { message?: unknown };
		if (typeof parsed.message === 'string') detail = parsed.message;
	} catch {
		// Not the API's JSON error shape; the status alone will do.
	}
	return `Anytype answered HTTP ${status}${detail ? `: ${detail}` : ''}.`;
}
