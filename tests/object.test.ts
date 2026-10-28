import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseExport } from '../src/import/parse';
import type { ExportRecord, Thread } from '../src/import/types';
import {
	commentNumbers,
	commentsInReplyOrder,
	fencedText,
	formatUtc,
	markdownLink,
	objectDescription,
	objectName,
	threadToBody,
	webAddress,
} from '../src/object';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const post: ExportRecord = {
	source: 'reddit',
	record_type: 'post',
	thread_id: 'p1',
	thread_title: 'Is it worth it?',
	subreddit: 'test',
	comment_id: null,
	parent_id: null,
	parent_missing: false,
	score: 120,
	score_hidden: false,
	created_utc: '2026-10-01T08:30:00.000Z',
	edited_utc: null,
	is_op: true,
	body: 'Thinking about it.',
	permalink: 'https://www.reddit.com/r/test/comments/p1/is_it_worth_it/',
	comment_state: 'normal',
};

const comment = (id: string, parent: string, extra: Partial<ExportRecord> = {}): ExportRecord => ({
	...post,
	record_type: 'comment',
	comment_id: id,
	parent_id: parent,
	score: 1,
	is_op: false,
	body: `Text of ${id}`,
	permalink: `https://www.reddit.com/r/test/comments/p1/_/${id}/`,
	...extra,
});

const thread = (comments: ExportRecord[], extra: Partial<Thread> = {}): Thread => ({
	source: 'reddit',
	threadId: 'p1',
	title: post.thread_title,
	url: post.permalink,
	subreddit: 'test',
	exportedAt: '2026-10-02T00:00:00.000Z',
	post,
	comments,
	...extra,
});

/** The lines of each fenced block in the body, so tests can check that text stays inside one. */
function fencedBlocks(body: string): string[][] {
	const blocks: string[][] = [];
	let fence: string | null = null;
	let current: string[] = [];
	for (const line of body.split('\n')) {
		if (fence === null) {
			const opener = /^(`{3,})$/.exec(line);
			if (opener) {
				fence = opener[1]!;
				current = [];
			}
		} else if (line.startsWith(fence) && /^`+$/.test(line)) {
			blocks.push(current);
			fence = null;
		} else current.push(line);
	}
	expect(fence).toBeNull();
	return blocks;
}

describe('threadToBody', () => {
	it('writes the source, the post and every comment in reply order', () => {
		const body = threadToBody(
			thread([
				comment('a', 'p1', { score: 57, created_utc: '2026-10-01T09:02:00.000Z' }),
				comment('b', 'a', { score: 12, is_op: true }),
				comment('c', 'p1', { score: null, score_hidden: true }),
			]),
		);
		expect(body).toBe(
			[
				'Reddit · r/test · [original thread](https://www.reddit.com/r/test/comments/p1/is_it_worth_it/)',
				'',
				'Exported 2026-10-02 00:00 UTC · 3 comments in this export',
				'',
				'**Post** · 120 points · 2026-10-01 08:30 UTC · [link](https://www.reddit.com/r/test/comments/p1/is_it_worth_it/)',
				'',
				'```',
				'Thinking about it.',
				'```',
				'',
				'## Comments',
				'',
				'**[c1]** · 57 points · 2026-10-01 09:02 UTC · [link](https://www.reddit.com/r/test/comments/p1/_/a/)',
				'',
				'```',
				'Text of a',
				'```',
				'',
				'**[c2]** · reply to [c1] · 12 points · 2026-10-01 08:30 UTC · OP · [link](https://www.reddit.com/r/test/comments/p1/_/b/)',
				'',
				'```',
				'Text of b',
				'```',
				'',
				'**[c3]** · score hidden · 2026-10-01 08:30 UTC · [link](https://www.reddit.com/r/test/comments/p1/_/c/)',
				'',
				'```',
				'Text of c',
				'```',
				'',
			].join('\n'),
		);
	});

	it('numbers comments in file order and lists them in reply order', () => {
		const t = thread([comment('a', 'p1'), comment('b', 'p1'), comment('c', 'a')]);
		expect(commentsInReplyOrder(t).map((record) => record.comment_id)).toEqual(['a', 'c', 'b']);
		const body = threadToBody(t);
		expect(body.indexOf('**[c3]** · reply to [c1]')).toBeLessThan(body.indexOf('**[c2]**'));
	});

	it('uses the same numbers for flat JSON, nested JSON and CSV', () => {
		const bodies = ['batch-flat.json', 'batch-nested.json', 'batch.csv'].map((name) => parseExport(fixture(name)).threads.map(threadToBody));
		expect(bodies[1]).toEqual(bodies[0]);
		expect(bodies[2]).toEqual(bodies[0]);
	});

	it('keeps every post and comment body inside a code block', () => {
		const nasty = [
			'![tracker](https://example.com/pixel.png)',
			'[click](javascript:alert(1))',
			'[[My private note]]',
			'<details><summary>open me</summary>hidden</details>',
			'````',
			'```',
			'# heading',
		].join('\n');
		const body = threadToBody(thread([comment('a', 'p1', { body: nasty })], { post: { ...post, body: '```\n<img src=x>' } }));
		const blocks = fencedBlocks(body);
		expect(blocks).toEqual([['```', '<img src=x>'], nasty.split('\n')]);
		const outside = body.split('\n').filter((line) => !nasty.includes(line) && line !== '<img src=x>');
		expect(outside.join('\n')).not.toMatch(/javascript|pixel|\[\[|<details|<img/);
	});

	it('keeps fences longer than any backtick run, even ones Anytype would turn into separate lines', () => {
		// Anytype turns vertical tabs and form feeds into line breaks before reading the Markdown.
		const body = threadToBody(thread([comment('a', 'p1', { body: 'x\f`````\f![](https://example.com/a.png)' })]));
		expect(body).toContain('``````\nx\f`````\f![](https://example.com/a.png)\n``````');
	});

	it('marks deleted and removed comments and keeps their numbers', () => {
		const body = threadToBody(thread([comment('a', 'p1', { comment_state: 'deleted', body: '' }), comment('b', 'p1', { comment_state: 'removed', body: '' })]));
		expect(body).toContain('**[c1]** · 1 point · 2026-10-01 08:30 UTC · [link](https://www.reddit.com/r/test/comments/p1/_/a/)\n\n*(deleted)*');
		expect(body).toContain('**[c2]**');
		expect(body).toContain('*(removed)*');
	});

	it('says when a reply answers a comment that is not in the export', () => {
		const body = threadToBody(thread([comment('a', 'gone', { parent_missing: true })]));
		expect(body).toContain('**[c1]** · reply to a comment not in the export · 1 point');
	});

	it('leaves out links that are not web addresses and an empty comment body', () => {
		const body = threadToBody(thread([comment('a', 'p1', { permalink: 'javascript:alert(1)', body: '  \n' })], { url: 'file:///etc/passwd' }));
		expect(body).not.toContain('javascript');
		expect(body).not.toContain('file:');
		expect(body.startsWith('Reddit · r/test\n')).toBe(true);
		expect(body.endsWith('**[c1]** · 1 point · 2026-10-01 08:30 UTC\n')).toBe(true);
	});

	it('only shows subreddit names made of letters, digits and underscores', () => {
		expect(threadToBody(thread([], { subreddit: 'a](https://evil.example)' })).split('\n')[0]).toBe(
			'Reddit · [original thread](https://www.reddit.com/r/test/comments/p1/is_it_worth_it/)',
		);
	});

	it('writes no Comments heading for a thread without comments', () => {
		expect(threadToBody(thread([]))).not.toContain('## Comments');
	});

	it('lists comments caught in a parent loop instead of dropping them', () => {
		const t = thread([comment('a', 'b'), comment('b', 'a')]);
		expect(commentsInReplyOrder(t).map((record) => record.comment_id)).toEqual(['a', 'b']);
	});
});

describe('names and descriptions', () => {
	it('uses the title on one line, or the platform and thread ID', () => {
		expect(objectName(thread([], { title: ' Line one\nline\ttwo\u0007 ' }))).toBe('Line one line two');
		expect(objectName(thread([], { title: '', source: 'hn', threadId: '42' }))).toBe('Hacker News thread 42');
	});

	it('describes the platform, subreddit and comment count', () => {
		expect(objectDescription(thread([comment('a', 'p1')]))).toBe('Reddit · r/test · 1 comment');
		expect(objectDescription(thread([], { source: 'hn', subreddit: null }))).toBe('Hacker News · 0 comments');
	});

	it('numbers only comments with an ID', () => {
		expect([...commentNumbers(thread([comment('a', 'p1'), { ...comment('x', 'p1'), comment_id: null }, comment('b', 'p1')]))]).toEqual([
			['a', 1],
			['b', 2],
		]);
	});
});

describe('helpers', () => {
	it('fences text with more backticks than it contains', () => {
		expect(fencedText('a ``` b')).toEqual(['````', 'a ``` b', '````']);
		expect(fencedText('plain')).toEqual(['```', 'plain', '```']);
	});

	it('starts text that Anytype would turn into a checkbox on a new line', () => {
		expect(fencedText('[x] done')).toEqual(['```', '', '[x] done', '```']);
		expect(fencedText('[ ] todo')).toEqual(['```', '', '[ ] todo', '```']);
		expect(fencedText('\u200B[]')).toEqual(['```', '', '\u200B[]', '```']);
		expect(fencedText('[\t] tab')).toEqual(['```', '', '[\t] tab', '```']);
		expect(fencedText(' [x] indented')).toEqual(['```', ' [x] indented', '```']);
		expect(fencedText('a\n[x] later')).toEqual(['```', 'a', '[x] later', '```']);
	});

	it('formats only ISO 8601 times', () => {
		expect(formatUtc('2026-09-21T14:13:59.123Z')).toBe('2026-09-21 14:13 UTC');
		expect(formatUtc('2026-09-21T16:13:00+02:00')).toBe('2026-09-21 14:13 UTC');
		expect(formatUtc('yesterday')).toBeNull();
		expect(formatUtc('2026-13-45T99:00:00Z')).toBeNull();
	});

	it('encodes characters that could break out of a link', () => {
		expect(webAddress('https://example.com/a b)(<x>\n[y]')).toBe('https://example.com/a%20b%29%28%3Cx%3E%0A%5By%5D');
		expect(webAddress('HTTPS://example.com/é')).toBe('HTTPS://example.com/%C3%A9');
		expect(webAddress('ftp://example.com')).toBeNull();
		expect(markdownLink('link', 'javascript:alert(1)')).toBeNull();
	});
});
