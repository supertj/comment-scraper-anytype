/**
 * One row of a Comment Scraper export (schema version 1). Field names match the export files,
 * so JSON rows can be checked and used as they are. Exports never include usernames, so there
 * is no author field here either.
 */
export type Source = 'reddit' | 'hn';
export type CommentState = 'normal' | 'deleted' | 'removed';

export interface ExportRecord {
	source: Source;
	record_type: 'post' | 'comment';
	thread_id: string;
	thread_title: string;
	/** Reddit only. */
	subreddit: string | null;
	/** null for the post. */
	comment_id: string | null;
	/** Top-level comments point at the thread ID. */
	parent_id: string | null;
	/** The parent comment wasn't fetched, so this reply has nothing to hang under. */
	parent_missing: boolean;
	/** null when the site hides the score, and always for Hacker News comments. */
	score: number | null;
	score_hidden: boolean;
	/** ISO 8601, UTC. */
	created_utc: string;
	edited_utc: string | null;
	is_op: boolean;
	/** Empty for deleted and removed comments. */
	body: string;
	permalink: string;
	comment_state: CommentState;
}

export interface Thread {
	source: Source;
	threadId: string;
	title: string;
	url: string;
	subreddit: string | null;
	/** When the extension fetched the thread. */
	exportedAt: string;
	post: ExportRecord;
	comments: ExportRecord[];
}

export interface ParsedExport {
	threads: Thread[];
	/** Threads left out because their rows were damaged or had no post row. */
	skipped: number;
}
