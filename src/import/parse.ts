import { parseCsvRows, removeFormulaGuard } from './csv';
import type { CommentState, ExportRecord, ParsedExport, Source, Thread } from './types';

// Reads the JSON and CSV files the Comment Scraper extension writes. Both JSON shapes carry
// an envelope ({ generator: "Comment Scraper", threads: [...] }): the flat one lists every
// row under thread.records, the nested one has thread.post plus thread.comments with replies
// inside their parent. The CSV has one row per post or comment and a fixed header.

export class NotAnExportError extends Error {}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const CSV_REQUIRED_COLUMNS = [
	'source',
	'record_type',
	'thread_id',
	'thread_title',
	'comment_id',
	'parent_id',
	'score',
	'created_utc',
	'body',
	'permalink',
	'fetched_at',
];

export function parseExport(text: string): ParsedExport {
	const content = text.replace(/^\uFEFF/, '');
	if (content.trimStart().startsWith('{')) return parseJsonExport(content);
	if (/^[^\r\n]*\brecord_type\b/.test(content)) return parseCsvExport(content);
	throw new NotAnExportError('not a Comment Scraper JSON or CSV export');
}

function parseJsonExport(text: string): ParsedExport {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new NotAnExportError('the JSON is incomplete or damaged');
	}
	if (!isObject(data) || data.generator !== 'Comment Scraper' || !Array.isArray(data.threads)) {
		throw new NotAnExportError('not a Comment Scraper JSON export');
	}
	const fileExportedAt = typeof data.exported_at === 'string' ? data.exported_at : '';
	const threads: Thread[] = [];
	let skipped = 0;
	for (const entry of data.threads) {
		const thread = isObject(entry) ? jsonThread(entry, fileExportedAt) : null;
		if (thread) threads.push(thread);
		else skipped++;
	}
	return { threads, skipped };
}

function jsonThread(entry: JsonObject, fileExportedAt: string): Thread | null {
	let rows: unknown[] | null = null;
	if (Array.isArray(entry.records)) rows = entry.records;
	else if (entry.post !== undefined && Array.isArray(entry.comments)) {
		const comments = flattenNested(entry.comments);
		rows = comments && [entry.post, ...comments];
	}
	if (!rows) return null;
	const records: ExportRecord[] = [];
	for (const row of rows) {
		const record = jsonRecord(row);
		if (!record) return null;
		records.push(record);
	}
	const meta = isObject(entry.meta) ? entry.meta : {};
	const fetchedAt = typeof meta.fetched_at === 'string' ? meta.fetched_at : fileExportedAt;
	return buildThread(records, fetchedAt);
}

/** Walks nested replies back into a flat list. A loop rather than recursion: reply chains can be thousands deep. */
function flattenNested(roots: unknown[]): unknown[] | null {
	const rows: unknown[] = [];
	const stack = [...roots].reverse();
	while (stack.length > 0) {
		const node = stack.pop();
		if (!isObject(node)) return null;
		const { replies, ...row } = node;
		rows.push(row);
		if (replies === undefined) continue;
		if (!Array.isArray(replies)) return null;
		for (let index = replies.length - 1; index >= 0; index--) stack.push(replies[index]);
	}
	return rows;
}

const stringOr = <T>(value: unknown, fallback: T): string | T => (typeof value === 'string' ? value : fallback);

const isSource = (value: unknown): value is Source => value === 'reddit' || value === 'hn';

/** Anything other than the three states the extension writes is read as a normal comment. */
const commentState = (value: unknown): CommentState =>
	value === 'deleted' || value === 'removed' ? value : 'normal';

/** Checks the fields the note needs. A row missing one of them means the file was cut off or edited. */
function jsonRecord(row: unknown): ExportRecord | null {
	if (!isObject(row)) return null;
	const recordType = row.record_type;
	if (recordType !== 'post' && recordType !== 'comment') return null;
	if (recordType === 'comment' && typeof row.comment_id !== 'string') return null;
	if (!isSource(row.source)) return null;
	for (const field of ['thread_id', 'body', 'permalink', 'created_utc']) {
		if (typeof row[field] !== 'string') return null;
	}
	return {
		source: row.source,
		record_type: recordType,
		thread_id: row.thread_id as string,
		thread_title: stringOr(row.thread_title, ''),
		subreddit: stringOr(row.subreddit, null),
		comment_id: stringOr(row.comment_id, null),
		parent_id: stringOr(row.parent_id, null),
		parent_missing: row.parent_missing === true,
		score: typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : null,
		score_hidden: row.score_hidden === true,
		created_utc: row.created_utc as string,
		edited_utc: stringOr(row.edited_utc, null),
		is_op: row.is_op === true,
		body: row.body as string,
		permalink: row.permalink as string,
		comment_state: commentState(row.comment_state),
	};
}

interface CsvGroup {
	records: ExportRecord[];
	fetchedAt: string;
	damaged: boolean;
	hasPost: boolean;
}

function parseCsvExport(text: string): ParsedExport {
	const { rows: [header = [], ...rows], unterminated } = parseCsvRows(text);
	const columns = new Map(header.map((name, index) => [name.trim(), index]));
	if (CSV_REQUIRED_COLUMNS.some((name) => !columns.has(name))) {
		throw new NotAnExportError('not a Comment Scraper CSV export');
	}
	// A batch export puts several threads in one file, one after another.
	const groups: CsvGroup[] = [];
	const latestGroup = new Map<string, CsvGroup>();
	for (const [index, row] of rows.entries()) {
		if (row.length === 1 && row[0] === '') continue;
		const cell = (name: string): string => {
			const index = columns.get(name);
			return index === undefined ? '' : removeFormulaGuard(row[index] ?? '');
		};
		const source = cell('source');
		const recordType = cell('record_type');
		const key = `${source}:${cell('thread_id')}`;
		let group = latestGroup.get(key);
		// The same thread can be in a batch twice (open in two tabs). Its second post row starts
		// a second thread instead of piling both copies into one.
		if (!group || (recordType === 'post' && group.hasPost)) {
			group = { records: [], fetchedAt: cell('fetched_at'), damaged: false, hasPost: false };
			groups.push(group);
			latestGroup.set(key, group);
		}
		if (recordType === 'post') group.hasPost = true;
		// Every row the extension writes has a cell for every column. A short or long row means
		// the file was cut off or edited, and its comment can't be trusted to be whole.
		const cutOff = unterminated && index === rows.length - 1;
		if (cutOff || row.length !== header.length || !isSource(source) || (recordType !== 'post' && recordType !== 'comment')) {
			group.damaged = true;
			continue;
		}
		const record: ExportRecord = {
			source,
			record_type: recordType,
			thread_id: cell('thread_id'),
			thread_title: cell('thread_title'),
			subreddit: cell('subreddit') || null,
			comment_id: cell('comment_id') || null,
			parent_id: cell('parent_id') || null,
			parent_missing: cell('parent_missing') === 'true',
			score: csvNumber(cell('score')),
			score_hidden: cell('score_hidden') === 'true',
			created_utc: cell('created_utc'),
			edited_utc: cell('edited_utc') || null,
			is_op: cell('is_op') === 'true',
			body: cell('body'),
			permalink: cell('permalink'),
			comment_state: commentState(cell('comment_state')),
		};
		group.records.push(record);
	}
	const threads: Thread[] = [];
	let skipped = 0;
	for (const { records, fetchedAt, damaged } of groups) {
		const thread = damaged ? null : buildThread(records, fetchedAt);
		if (thread) threads.push(thread);
		else skipped++;
	}
	return { threads, skipped };
}

function csvNumber(cell: string): number | null {
	if (cell.trim() === '') return null;
	const value = Number(cell);
	return Number.isFinite(value) ? value : null;
}

function buildThread(records: ExportRecord[], exportedAt: string): Thread | null {
	const post = records.find((record) => record.record_type === 'post');
	if (!post) return null;
	return {
		source: post.source,
		threadId: post.thread_id,
		title: post.thread_title,
		url: post.permalink,
		subreddit: post.subreddit,
		exportedAt,
		post,
		comments: records.filter((record) => record.record_type === 'comment'),
	};
}
