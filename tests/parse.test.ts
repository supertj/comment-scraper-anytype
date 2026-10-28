import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCsvRows, removeFormulaGuard } from '../src/import/csv';
import { NotAnExportError, parseExport } from '../src/import/parse';
import type { ExportRecord } from '../src/import/types';

// The fixtures were written by the extension's own export code from its synthetic test thread
// (a Reddit thread with 11 comments and a Hacker News thread with 3), in one batch file per format.
// The two .md files are its Markdown export of batch-flat.json, one file per thread.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const summary = (records: ExportRecord[]) =>
	records.map(({ comment_id, parent_id, score, score_hidden, created_utc, edited_utc, is_op, body, permalink, comment_state }) => ({
		comment_id, parent_id, score, score_hidden, created_utc, edited_utc, is_op, body, permalink, comment_state,
	}));

describe('parseExport', () => {
	it('reads a flat JSON export', () => {
		const { threads, skipped } = parseExport(fixture('batch-flat.json'));
		expect(skipped).toBe(0);
		expect(threads).toHaveLength(2);
		const [reddit, hn] = threads;
		expect(reddit).toMatchObject({
			source: 'reddit',
			threadId: '1abcxyz',
			title: 'Which CRM do small teams actually like?',
			url: 'https://www.reddit.com/r/testsub/comments/1abcxyz/title/',
			subreddit: 'testsub',
			exportedAt: '2026-10-20T15:33:04.869Z',
		});
		expect(reddit!.comments).toHaveLength(11);
		expect(reddit!.post.body).toBe('Looking for honest takes.\n# not a heading');
		expect(hn).toMatchObject({ source: 'hn', subreddit: null, url: 'https://news.ycombinator.com/item?id=1' });
		expect(hn!.comments).toHaveLength(3);
	});

	it('reads the nested JSON export into the same comments as the flat one', () => {
		const flat = parseExport(fixture('batch-flat.json')).threads;
		const nested = parseExport(fixture('batch-nested.json')).threads;
		expect(nested.map((thread) => thread.title)).toEqual(flat.map((thread) => thread.title));
		for (const [index, thread] of nested.entries()) {
			expect(summary(thread.comments)).toEqual(summary(flat[index]!.comments));
			expect(thread.exportedAt).toBe(flat[index]!.exportedAt);
		}
	});

	it('reads the CSV export into the same comments as the JSON one', () => {
		const flat = parseExport(fixture('batch-flat.json')).threads;
		const csv = parseExport(fixture('batch.csv')).threads;
		expect(csv).toHaveLength(2);
		for (const [index, thread] of csv.entries()) {
			expect(thread.title).toBe(flat[index]!.title);
			expect(thread.url).toBe(flat[index]!.url);
			expect(thread.exportedAt).toBe(flat[index]!.exportedAt);
			expect(summary(thread.comments)).toEqual(summary(flat[index]!.comments));
		}
		// Hidden score, deleted comment, OP reply and an edited comment survive the round trip.
		const reddit = csv[0]!.comments;
		expect(reddit.find((c) => c.comment_id === 'abcdefghijklm')).toMatchObject({ score: null, score_hidden: true });
		expect(reddit.find((c) => c.comment_id === 'c3')).toMatchObject({ comment_state: 'deleted', body: '' });
		expect(reddit.find((c) => c.comment_id === 'c2')).toMatchObject({ is_op: true, edited_utc: '2026-09-21T14:13:10.000Z' });
		expect(csv[1]!.title).toBe('Show HN: A tiny thing: with "quotes" / slashes?');
	});

	it('keeps a thread that appears twice in a batch as two threads', () => {
		// A batch is built from open tabs, so the same thread can be exported twice in one file.
		const rows = fixture('batch.csv').trimEnd().split('\r\n');
		const csv = [...rows, ...rows.filter((row) => row.startsWith('1,reddit,'))].join('\r\n') + '\r\n';
		const flat = JSON.parse(fixture('batch-flat.json'));
		flat.threads.push(flat.threads[0]);
		for (const text of [csv, JSON.stringify(flat)]) {
			const { threads, skipped } = parseExport(text);
			expect(skipped).toBe(0);
			expect(threads.map((thread) => `${thread.source}:${thread.comments.length}`)).toEqual(['reddit:11', 'hn:3', 'reddit:11']);
			expect(threads[2]).toEqual(threads[0]);
		}
	});

	it('takes the formula guard off CSV text cells and keeps negative scores', () => {
		const header = 'schema_version,source,record_type,thread_id,thread_title,subreddit,comment_id,parent_id,parent_missing,depth,score,score_hidden,created_utc,edited_utc,is_op,comment_state,body,permalink,task_state,fetch_path,fetched_at';
		const csv = [
			header,
			"1,reddit,post,p1,'=Title,sub,,,false,,5,false,2026-01-01T00:00:00.000Z,,true,normal,,https://www.reddit.com/r/sub/comments/p1/,partial,dom,2026-01-02T00:00:00.000Z",
			"1,reddit,comment,p1,'=Title,sub,a,p1,false,0,-5,false,2026-01-01T01:00:00.000Z,,false,normal,\"'- first\n- second\",https://www.reddit.com/r/sub/comments/p1/_/a/,partial,dom,2026-01-02T00:00:00.000Z",
			"1,reddit,comment,p1,'=Title,sub,b,gone,true,1,3,false,2026-01-01T02:00:00.000Z,,false,normal,'quoted on purpose,https://www.reddit.com/r/sub/comments/p1/_/b/,partial,dom,2026-01-02T00:00:00.000Z",
		].join('\n');
		const [thread] = parseExport(csv).threads;
		expect(thread!.title).toBe('=Title');
		expect(thread!.comments[0]).toMatchObject({ score: -5, body: '- first\n- second' });
		expect(thread!.comments[1]).toMatchObject({ body: "'quoted on purpose", parent_missing: true });
	});

	it("can't tell a guard from a comment that really began with '- (CSV only; JSON is exact)", () => {
		// The extension writes "'- x" both for "- x" (guarded) and for "'- x" (left alone), so the
		// far more common first case wins. The README points people who need exact text to JSON.
		expect(removeFormulaGuard("'- literal apostrophe")).toBe('- literal apostrophe');
	});

	it('rejects files that are not Comment Scraper exports', () => {
		expect(() => parseExport('{"threads": []}')).toThrow(NotAnExportError);
		expect(() => parseExport('{"generator": "Comment Scraper", "threads": [')).toThrow(NotAnExportError);
		expect(() => parseExport('name,email\nAda,ada@example.com\n')).toThrow(NotAnExportError);
		expect(() => parseExport('record_type,body\npost,hi\n')).toThrow(NotAnExportError);
		expect(() => parseExport('# A Markdown export\n')).toThrow(NotAnExportError);
		expect(() => parseExport(fixture('batch-flat.reddit.md'))).toThrow(NotAnExportError);
	});

	it('skips damaged threads and keeps the rest', () => {
		const data = JSON.parse(fixture('batch-flat.json'));
		delete data.threads[0].records[3].body;
		const { threads, skipped } = parseExport(JSON.stringify(data));
		expect(skipped).toBe(1);
		expect(threads.map((thread) => thread.source)).toEqual(['hn']);

		const nested = JSON.parse(fixture('batch-nested.json'));
		nested.threads[1].comments[0].replies = 'oops';
		expect(parseExport(JSON.stringify(nested)).skipped).toBe(1);
	});

	it('flattens a nested reply chain thousands deep without running out of stack', () => {
		// Written as text: JSON.stringify itself recurses and overflows on deep nesting under Node 22.
		const depth = 5_000;
		const data = JSON.parse(fixture('batch-nested.json'));
		const { replies: _replies, ...template } = data.threads[1].comments[0];
		const open = (index: number) => `${JSON.stringify({ ...template, comment_id: `d${index}` }).slice(0, -1)},"replies":[`;
		let comments = '';
		for (let index = 0; index < depth; index++) comments += open(index);
		comments += ']}'.repeat(depth);
		const text = `{"generator":"Comment Scraper","threads":[{"meta":${JSON.stringify(data.threads[1].meta)},"post":${JSON.stringify(data.threads[1].post)},"comments":[${comments}]}]}`;
		expect(parseExport(text).threads[0]!.comments).toHaveLength(depth);
	});

	it('skips a CSV thread whose rows were cut off', () => {
		const csv = fixture('batch.csv');
		const cutInComment = csv.slice(0, csv.indexOf('Body of c1') + 4);
		expect(parseExport(cutInComment)).toEqual({ threads: [], skipped: 1 });
		const cutInPost = csv.slice(0, csv.indexOf('# not a heading'));
		expect(parseExport(cutInPost)).toEqual({ threads: [], skipped: 1 });
		// The Hacker News thread after a damaged Reddit thread still comes through.
		const lines = csv.split('\r\n');
		lines[3] = lines[3]!.split(',').slice(0, 10).join(',');
		const { threads, skipped } = parseExport(lines.join('\r\n'));
		expect(skipped).toBe(1);
		expect(threads.map((thread) => thread.source)).toEqual(['hn']);
	});

	it('skips the thread whose last cell opens a quote that never closes', () => {
		// Same number of cells as a good row, but the quote has swallowed the end of the file.
		const csv = fixture('batch.csv').trimEnd().replace(/,(2026-10-20T15:33:04\.870Z)$/, ',"$1');
		const { threads, skipped } = parseExport(csv);
		expect(skipped).toBe(1);
		expect(threads.map((thread) => thread.source)).toEqual(['reddit']);
	});

	it('only accepts Reddit and Hacker News rows and the three comment states', () => {
		const data = JSON.parse(fixture('batch-flat.json'));
		for (const record of data.threads[1].records) record.source = 'Archive/x';
		data.threads[0].records[1].comment_state = 'gone\n```dataviewjs';
		const { threads, skipped } = parseExport(JSON.stringify(data));
		expect(skipped).toBe(1);
		expect(threads[0]!.comments[0]!.comment_state).toBe('normal');
	});
});

describe('CSV helpers', () => {
	it('splits quoted cells with commas, quotes and line breaks', () => {
		expect(parseCsvRows('a,"b, ""c""\r\nd",e\r\nf,,\r\n')).toEqual({
			rows: [
				['a', 'b, "c"\r\nd', 'e'],
				['f', '', ''],
			],
			unterminated: false,
		});
		expect(parseCsvRows('x,y')).toEqual({ rows: [['x', 'y']], unterminated: false });
		expect(parseCsvRows('x,"y\r\nz,w')).toEqual({ rows: [['x', 'y\r\nz,w']], unterminated: true });
	});

	it('only removes a guard the extension could have added', () => {
		expect(removeFormulaGuard("'=SUM(A1)")).toBe('=SUM(A1)');
		expect(removeFormulaGuard("'@here")).toBe('@here');
		expect(removeFormulaGuard("'+1")).toBe('+1');
		expect(removeFormulaGuard("'\tTabbed")).toBe('\tTabbed');
		expect(removeFormulaGuard("'\nStarts on a new line")).toBe('\nStarts on a new line');
		expect(removeFormulaGuard("'＝SUM(A1)")).toBe('＝SUM(A1)');
		expect(removeFormulaGuard("'＠here")).toBe('＠here');
		expect(removeFormulaGuard("'tis the season")).toBe("'tis the season");
		expect(removeFormulaGuard('-5')).toBe('-5');
	});
});
