import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AnytypeClient, AnytypeError, API_VERSION, checkApiUrl } from '../src/anytype';
import { main, pickSpace, printable } from '../src/cli';
import { startFakeAnytype, type FakeAnytype } from './fake-anytype';

const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

let fake: FakeAnytype | null = null;
afterEach(async () => {
	await fake?.close();
	fake = null;
});

async function run(argv: string[], env: Record<string, string | undefined>) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await main(argv, env, { out: (line) => out.push(line), err: (line) => err.push(line) });
	return { code, out, err };
}

describe('import', () => {
	it('creates one object per thread with the API version, key, name, body and properties', async () => {
		fake = await startFakeAnytype();
		const { code, out, err } = await run([fixturePath('batch-flat.json')], { ANYTYPE_API_KEY: 'test-key', ANYTYPE_API_URL: fake.url });
		expect(err).toEqual([]);
		expect(code).toBe(0);
		expect(out).toEqual([
			'Imported: Which CRM do small teams actually like?',
			'Imported: Show HN: A tiny thing: with "quotes" / slashes?',
			'Imported 2 threads into the space "Research".',
		]);
		for (const request of fake.requests) {
			expect(request.headers['anytype-version']).toBe(API_VERSION);
			expect(request.headers.authorization).toBe('Bearer test-key');
		}
		expect(fake.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
			'GET /v1/spaces?offset=0&limit=1000',
			'GET /v1/spaces/space-1/properties?offset=0&limit=1000',
			'POST /v1/spaces/space-1/objects',
			'POST /v1/spaces/space-1/objects',
		]);
		const created = fake.requests[2]!.body as Record<string, unknown>;
		expect(created).toMatchObject({
			name: 'Which CRM do small teams actually like?',
			type_key: 'page',
			properties: [
				{ key: 'description', text: 'Reddit · r/testsub · 11 comments' },
				{ key: 'source', url: 'https://www.reddit.com/r/testsub/comments/1abcxyz/title/' },
			],
		});
		expect(created.body).toContain('## Comments');
		expect(Object.keys(created).sort()).toEqual(['body', 'name', 'properties', 'type_key']);
		expect(fake.requests[2]!.headers['content-type']).toBe('application/json');
	});

	it('leaves out properties the space does not have', async () => {
		fake = await startFakeAnytype({ properties: [{ key: 'source', format: 'text' }] });
		const { code } = await run([fixturePath('batch.csv'), '--type', 'note'], { ANYTYPE_API_KEY: 'test-key', ANYTYPE_API_URL: fake.url });
		expect(code).toBe(0);
		const created = fake.requests.filter((request) => request.method === 'POST').map((request) => request.body as Record<string, unknown>);
		expect(created).toHaveLength(2);
		expect(created.every((body) => body.type_key === 'note' && Array.isArray(body.properties) && body.properties.length === 0)).toBe(true);
	});

	it('picks the space by name or ID and lists the spaces when it is ambiguous', async () => {
		const spaces = [
			{ id: 'space-1', name: 'Research' },
			{ id: 'space-2', name: 'Work' },
		];
		fake = await startFakeAnytype({ spaces });
		const env = { ANYTYPE_API_KEY: 'test-key', ANYTYPE_API_URL: fake.url };
		expect((await run([fixturePath('batch.csv'), '--space', 'work'], env)).code).toBe(0);
		expect(fake.requests.at(-1)!.url).toBe('/v1/spaces/space-2/objects');
		const ambiguous = await run([fixturePath('batch.csv')], env);
		expect(ambiguous.code).toBe(1);
		expect(ambiguous.err.join('\n')).toContain('Pick a space with --space. You have:\n  Research (space-1)\n  Work (space-2)');
	});

	it('reports a thread Anytype refuses and carries on with the rest', async () => {
		fake = await startFakeAnytype({ createStatus: 400 });
		const { code, out, err } = await run([fixturePath('batch-flat.json')], { ANYTYPE_API_KEY: 'test-key', ANYTYPE_API_URL: fake.url });
		expect(code).toBe(1);
		expect(out.at(-1)).toBe('Imported 0 threads into the space "Research".');
		expect(err).toEqual([
			'Not everything was imported:',
			'Which CRM do small teams actually like?: Anytype answered HTTP 400: unknown type key.',
			'Show HN: A tiny thing: with "quotes" / slashes?: Anytype answered HTTP 400: unknown type key.',
		]);
	});

	it('stops at a refused API key', async () => {
		fake = await startFakeAnytype();
		const { code, err } = await run([fixturePath('batch-flat.json')], { ANYTYPE_API_KEY: 'wrong', ANYTYPE_API_URL: fake.url });
		expect(code).toBe(1);
		expect(err.join('\n')).toContain('Anytype turned down the API key.');
		expect(fake.requests).toHaveLength(1);
	});

	it('says when Anytype is not running', async () => {
		fake = await startFakeAnytype();
		const url = fake.url;
		await fake.close();
		fake = null;
		const { code, err } = await run([fixturePath('batch.csv')], { ANYTYPE_API_KEY: 'test-key', ANYTYPE_API_URL: url });
		expect(code).toBe(1);
		expect(err.join('\n')).toContain(`Couldn't reach Anytype at ${url}. Is the desktop app open and signed in?`);
	});

	it('asks for an API key before contacting Anytype', async () => {
		const { code, err } = await run([fixturePath('batch.csv')], {});
		expect(code).toBe(2);
		expect(err[0]).toContain('Set ANYTYPE_API_KEY first.');
	});

	it('lists the threads in a dry run without an API key', async () => {
		const { code, out, err } = await run(['--dry-run', fixturePath('batch-nested.json'), fixturePath('batch-flat.reddit.md')], {});
		expect(out).toEqual([
			'Which CRM do small teams actually like? (Reddit · r/testsub · 11 comments)',
			'Show HN: A tiny thing: with "quotes" / slashes? (Hacker News · 3 comments)',
			'2 threads would be imported.',
		]);
		expect(err).toEqual(['Some files or threads would be left out:', 'batch-flat.reddit.md: not a Comment Scraper JSON or CSV export.']);
		expect(code).toBe(1);
	});

	it('shows usage for no files or an unknown option', async () => {
		expect((await run([], {})).code).toBe(2);
		expect((await run(['--nope', 'a.json'], {})).code).toBe(2);
		const help = await run(['--help'], {});
		expect(help.code).toBe(0);
		expect(help.out[0]).toContain('Usage: comment-scraper-anytype');
	});
});

describe('AnytypeClient', () => {
	it('waits out a rate limit and tries again', async () => {
		fake = await startFakeAnytype({ rateLimited: 2 });
		const waits: number[] = [];
		const client = new AnytypeClient(fake.url, 'test-key', async (ms) => {
			waits.push(ms);
		});
		expect(await client.createObject('space-1', { name: 'x', type_key: 'page', body: '' })).toEqual({ id: 'object-1' });
		expect(waits).toEqual([1500, 3000]);
	});

	it('gives up after five rate-limited tries', async () => {
		fake = await startFakeAnytype({ rateLimited: 10 });
		const client = new AnytypeClient(fake.url, 'test-key', async () => {});
		await expect(client.createObject('space-1', { name: 'x', type_key: 'page', body: '' })).rejects.toThrow('Anytype answered HTTP 429: Rate limit exceeded.');
		expect(fake.requests).toHaveLength(6);
	});

	it('reads every page of a list', async () => {
		const spaces = Array.from({ length: 5 }, (_, index) => ({ id: `space-${index}`, name: `Space ${index}` }));
		fake = await startFakeAnytype({ spaces, pageSize: 2 });
		const client = new AnytypeClient(fake.url, 'test-key');
		expect((await client.listSpaces()).map((space) => space.id)).toEqual(spaces.map((space) => space.id));
		expect(fake.requests.map((request) => request.url)).toEqual([
			'/v1/spaces?offset=0&limit=1000',
			'/v1/spaces?offset=2&limit=1000',
			'/v1/spaces?offset=4&limit=1000',
		]);
	});

	it('stops when a page brings nothing new, even if the server says there is more', async () => {
		fake = await startFakeAnytype({ ignoreOffset: true });
		const client = new AnytypeClient(fake.url, 'test-key');
		expect(await client.listSpaces()).toHaveLength(1);
		expect(fake.requests).toHaveLength(2);
	});

	it('only talks to this computer', () => {
		expect(checkApiUrl('http://localhost:31009/').origin).toBe('http://localhost:31009');
		expect(checkApiUrl('http://[::1]:31009').hostname).toBe('[::1]');
		expect(() => checkApiUrl('http://192.168.1.5:31009')).toThrow(AnytypeError);
		expect(() => checkApiUrl('https://127.0.0.1:31009')).toThrow(AnytypeError);
		expect(() => checkApiUrl('http://127.0.0.1.example.com')).toThrow(AnytypeError);
		expect(() => checkApiUrl('not a url')).toThrow(AnytypeError);
	});
});

describe('pickSpace and printable', () => {
	it('prefers an exact ID and refuses a name two spaces share', () => {
		const spaces = [
			{ id: 'Work', name: 'Home' },
			{ id: 'a', name: 'Work' },
			{ id: 'b', name: 'work' },
		];
		expect(pickSpace(spaces, 'Work').id).toBe('Work');
		expect(() => pickSpace(spaces, 'home ')).not.toThrow();
		expect(() => pickSpace(spaces.slice(1), 'WORK')).toThrow('More than one space is called "WORK"');
		expect(() => pickSpace([], undefined)).toThrow('Anytype has no spaces to import into.');
		expect(() => pickSpace(spaces, 'nope')).toThrow('There\'s no space called "nope"');
	});

	it('drops control characters but keeps line breaks', () => {
		expect(printable('a\u001b[31mred\u0007\nb')).toBe('a[31mred\nb');
	});
});
