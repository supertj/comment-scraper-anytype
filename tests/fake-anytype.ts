import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for the API the Anytype desktop app serves, answering in the shapes of the
// official OpenAPI file (version 2025-11-08) and recording every request it gets.

export interface RecordedRequest {
	method: string;
	url: string;
	headers: IncomingHttpHeaders;
	body: unknown;
}

export interface FakeAnytypeOptions {
	spaces?: { id: string; name: string }[];
	properties?: { key: string; format: string }[];
	/** How many create-object calls get a 429 before one goes through. */
	rateLimited?: number;
	/** Status to answer every create-object call with instead of 201. */
	createStatus?: number;
	/** Most items per list page, whatever limit the client asks for. */
	pageSize?: number;
	/** Answer every list call with the first page and has_more, like a server that ignores offset. */
	ignoreOffset?: boolean;
}

export interface FakeAnytype {
	url: string;
	requests: RecordedRequest[];
	close(): Promise<void>;
}

export async function startFakeAnytype(options: FakeAnytypeOptions = {}): Promise<FakeAnytype> {
	const spaces = options.spaces ?? [{ id: 'space-1', name: 'Research' }];
	const properties = options.properties ?? [
		{ key: 'description', format: 'text' },
		{ key: 'source', format: 'url' },
	];
	let rateLimited = options.rateLimited ?? 0;
	let nextId = 1;
	const requests: RecordedRequest[] = [];

	const server: Server = createServer((request, response) => {
		let raw = '';
		request.on('data', (chunk) => (raw += chunk));
		request.on('end', () => {
			const body = raw ? JSON.parse(raw) : undefined;
			requests.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });
			const send = (status: number, payload: unknown) => {
				response.writeHead(status, { 'Content-Type': 'application/json' });
				response.end(JSON.stringify(payload));
			};
			if (request.headers.authorization !== 'Bearer test-key') {
				return send(401, { code: 'unauthorized', message: 'Unauthorized', object: 'error', status: 401 });
			}
			const address = new URL(request.url ?? '', 'http://x');
			const path = address.pathname;
			const page = (all: unknown[]) => {
				const limit = Math.min(Number(address.searchParams.get('limit') ?? 100), options.pageSize ?? 1000);
				const offset = options.ignoreOffset ? 0 : Number(address.searchParams.get('offset') ?? 0);
				const data = all.slice(offset, offset + limit);
				const hasMore = options.ignoreOffset || offset + data.length < all.length;
				send(200, { data, pagination: { total: all.length, offset, limit, has_more: hasMore } });
			};
			if (request.method === 'GET' && path === '/v1/spaces') return page(spaces.map((space) => ({ ...space, object: 'anytype.space' })));
			const match = /^\/v1\/spaces\/([^/]+)\/(properties|objects)$/.exec(path);
			if (match && request.method === 'GET' && match[2] === 'properties') {
				return page(properties.map((property, index) => ({ ...property, id: `prop-${index}`, name: property.key, object: 'property' })));
			}
			if (match && request.method === 'POST' && match[2] === 'objects') {
				if (rateLimited > 0) {
					rateLimited--;
					return send(429, { code: 'rate_limit_exceeded', message: 'Rate limit exceeded', object: 'error', status: 429 });
				}
				if (options.createStatus) return send(options.createStatus, { code: 'bad_request', message: 'unknown type key', object: 'error', status: options.createStatus });
				return send(201, { object: { id: `object-${nextId++}`, name: (body as { name: string }).name, object: 'object' } });
			}
			send(404, { code: 'not_found', message: 'Not found', object: 'error', status: 404 });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
