import type { ExportRecord, Thread } from './import/types';

// Turns one exported thread into the body of a create-object request for the Anytype API.
//
// Anytype turns the body into blocks with its own Markdown importer, which follows CommonMark
// with tables, strikethrough and [[wiki links]] added. It doesn't undo backslash escapes, so
// escaping the text would leave stray backslashes in it. Everything in an export comes from
// strangers on Reddit or Hacker News, and in plain Markdown a comment could add image blocks
// pointing at other servers or at local file paths, links with any kind of address, wiki links
// to your own objects or collapsible <details> blocks. So every post and comment body goes into a code block it
// can't close, and the lines around them are written here from fixed words, numbers and
// checked web addresses.
//
// The comments are one flat list in reading order. Each reply says which comment it answers,
// using the [c12] numbers the extension writes in its Markdown export.

export function platformName(source: Thread['source']): string {
	return source === 'reddit' ? 'Reddit' : 'Hacker News';
}

/** The thread title on one line, or "Reddit thread 1abcxyz" when the title is empty. */
export function objectName(thread: Thread): string {
	return oneLine(thread.title) || `${platformName(thread.source)} thread ${oneLine(thread.threadId)}`.trim();
}

function oneLine(text: string): string {
	return text.replace(/[\p{Cc}\s]+/gu, ' ').trim();
}

/** Subreddit names are letters, digits and underscores; anything else isn't one. */
function subredditLabel(thread: Thread): string | null {
	return thread.subreddit && /^\w+$/.test(thread.subreddit) ? `r/${thread.subreddit}` : null;
}

/** "Reddit · r/smallbusiness · 48 comments", shown under the object's name. */
export function objectDescription(thread: Thread): string {
	const parts = [platformName(thread.source)];
	const subreddit = subredditLabel(thread);
	if (subreddit) parts.push(subreddit);
	const count = thread.comments.length;
	parts.push(`${count} ${count === 1 ? 'comment' : 'comments'}`);
	return parts.join(' · ');
}

/**
 * The [c12] numbers the extension writes in its Markdown export: every comment in file order,
 * starting at 1. The nested JSON flattens back into the same order, so a number points at the
 * same comment whichever format the thread was exported in.
 */
export function commentNumbers(thread: Thread): Map<string, number> {
	const numbers = new Map<string, number>();
	let next = 1;
	for (const comment of thread.comments) if (comment.comment_id) numbers.set(comment.comment_id, next++);
	return numbers;
}

export function threadToBody(thread: Thread): string {
	const numbers = commentNumbers(thread);
	const source = [platformName(thread.source)];
	const subreddit = subredditLabel(thread);
	if (subreddit) source.push(subreddit);
	const threadLink = markdownLink('original thread', thread.url);
	if (threadLink) source.push(threadLink);
	const lines = [source.join(' · '), ''];
	const exported = formatUtc(thread.exportedAt);
	const count = `${thread.comments.length} ${thread.comments.length === 1 ? 'comment' : 'comments'} in this export`;
	lines.push(exported ? `Exported ${exported} · ${count}` : count, '');

	lines.push(['**Post**', ...recordFacts(thread.post)].join(' · '), '', ...bodyLines(thread.post));
	if (thread.comments.length > 0) lines.push('', '## Comments');
	for (const comment of commentsInReplyOrder(thread)) {
		const facts = recordFacts(comment);
		const parentNumber = comment.parent_id && comment.parent_id !== comment.comment_id ? numbers.get(comment.parent_id) : undefined;
		if (parentNumber) facts.unshift(`reply to [c${parentNumber}]`);
		else if (comment.parent_missing) facts.unshift('reply to a comment not in the export');
		const number = comment.comment_id ? numbers.get(comment.comment_id) : undefined;
		if (number) facts.unshift(`**[c${number}]**`);
		lines.push('', facts.join(' · '));
		const body = bodyLines(comment);
		if (body.length > 0) lines.push('', ...body);
	}
	return lines.join('\n') + '\n';
}

/**
 * Comments in reading order: each one followed by its replies. Built from parent_id rather than
 * trusting the file's row order, and walked with a stack because chains can be thousands deep.
 * A comment whose parent isn't in the export starts at the top level.
 */
export function commentsInReplyOrder(thread: Thread): ExportRecord[] {
	const byId = new Map<string, ExportRecord>();
	for (const comment of thread.comments) if (comment.comment_id) byId.set(comment.comment_id, comment);
	const roots: ExportRecord[] = [];
	const replies = new Map<string, ExportRecord[]>();
	for (const comment of thread.comments) {
		const parentId = comment.parent_id;
		if (parentId && parentId !== comment.comment_id && byId.has(parentId)) {
			const siblings = replies.get(parentId) ?? [];
			siblings.push(comment);
			replies.set(parentId, siblings);
		} else roots.push(comment);
	}

	const ordered: ExportRecord[] = [];
	const visited = new Set<ExportRecord>();
	const stack = [...roots].reverse();
	while (stack.length > 0) {
		const record = stack.pop()!;
		if (visited.has(record)) continue;
		visited.add(record);
		ordered.push(record);
		const children = record.comment_id ? (replies.get(record.comment_id) ?? []) : [];
		for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!);
	}
	// Comments caught in a parent loop (only in a hand-edited file) are never reached from a
	// root; add them at the end rather than dropping them.
	for (const comment of thread.comments) if (!visited.has(comment)) ordered.push(comment);
	return ordered;
}

/** Points, time, OP and edited markers, and the link to the original. Only fixed words, numbers and checked links. */
function recordFacts(record: ExportRecord): string[] {
	const facts: string[] = [];
	if (record.score !== null) facts.push(`${record.score} ${Math.abs(record.score) === 1 ? 'point' : 'points'}`);
	else if (record.score_hidden) facts.push('score hidden');
	const time = formatUtc(record.created_utc);
	if (time) facts.push(time);
	if (record.record_type === 'comment' && record.is_op) facts.push('OP');
	if (record.edited_utc) facts.push('edited');
	const link = markdownLink('link', record.permalink);
	if (link) facts.push(link);
	return facts;
}

function bodyLines(record: ExportRecord): string[] {
	if (record.comment_state === 'deleted') return ['*(deleted)*'];
	if (record.comment_state === 'removed') return ['*(removed)*'];
	// Only blank lines are trimmed: leading spaces on the first line can matter, as in code.
	const body = record.body.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
	return body ? fencedText(body) : [];
}

/**
 * The text as a plain code block it can't break out of: the fence is longer than any run of
 * backticks inside, and it names no language, so Anytype keeps it as plain text. The cost is
 * that Reddit's own formatting (bold, lists, links) shows as it was typed.
 *
 * Anytype turns any block whose text starts with "[ ]", "[]" or "[x]" into a checkbox and drops
 * those characters, code blocks included. Text that could start that way gets an empty first
 * line, so the block starts with a line break instead. The check runs on the text as Anytype
 * sees it, after it has removed zero-width characters, and catches every "[" to also cover a
 * tab or no-break space Anytype would turn into the space in "[ ]". Anytype also turns the
 * private-use character U+E000 into "[" inside code blocks, so that counts as one too.
 */
export function fencedText(text: string): string[] {
	let longestRun = 0;
	for (const run of text.match(/`+/g) ?? []) longestRun = Math.max(longestRun, run.length);
	const fence = '`'.repeat(Math.max(3, longestRun + 1));
	const lines = text.split('\n');
	if (/^[\u200B\u200C\u2060\uFEFF\r]*[[\uE000]/.test(text)) lines.unshift('');
	return [fence, ...lines, fence];
}

/** "2026-09-21 14:13 UTC", or null when the value isn't a date. Kept in UTC so it reads the same in every time zone. */
export function formatUtc(iso: string): string | null {
	// Only the ISO 8601 form the extension writes; Date() alone would guess at almost anything.
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(iso)) return null;
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return null;
	return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The address with every character that could end a Markdown link, start a new line or open a
 * tag percent-encoded, or null for anything but http(s) (javascript: and the like).
 */
export function webAddress(url: string): string | null {
	if (!/^https?:\/\//i.test(url)) return null;
	return url.replace(/[^\w\-.~:/?#@!$&'*+,;=%]/gu, (char) => {
		// encodeURIComponent leaves ( and ) alone, so ASCII is encoded by hand.
		const code = char.codePointAt(0)!;
		if (code < 0x80) return `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
		try {
			return encodeURIComponent(char);
		} catch {
			// A lone surrogate half can't be encoded.
			return '%EF%BF%BD';
		}
	});
}

export function markdownLink(text: string, url: string): string | null {
	const address = webAddress(url);
	return address ? `[${text}](${address})` : null;
}
