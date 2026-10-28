import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { AnytypeClient, AnytypeError, DEFAULT_API_URL, type PropertyValue, type Space } from './anytype';
import { parseExport } from './import/parse';
import type { Thread } from './import/types';
import { objectDescription, objectName, threadToBody } from './object';

const USAGE = `Usage: comment-scraper-anytype [options] <export files...>

Imports Reddit and Hacker News threads exported by Comment Scraper (JSON or CSV)
into Anytype, one object per thread.

Options:
  --space <name or id>  Space to import into. Can be left out if you have one space.
  --type <type key>     Type of the new objects (default: page).
  --dry-run             Read the files and list the threads, without contacting Anytype.
  -h, --help            Show this help.

Environment:
  ANYTYPE_API_KEY       An API key from Anytype: Settings → API Keys → Create new.
  ANYTYPE_API_URL       Where the Anytype API listens (default ${DEFAULT_API_URL}).`;

export interface Output {
	out(line: string): void;
	err(line: string): void;
}

const consoleOutput: Output = {
	out: (line) => process.stdout.write(`${line}\n`),
	err: (line) => process.stderr.write(`${line}\n`),
};

/** Runs the command and returns the exit code: 0 when everything went in, 1 when something didn't, 2 for a usage mistake. */
export async function main(argv: string[], env: Record<string, string | undefined>, output: Output = consoleOutput): Promise<number> {
	let args;
	try {
		args = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				space: { type: 'string' },
				type: { type: 'string', default: 'page' },
				'dry-run': { type: 'boolean', default: false },
				help: { type: 'boolean', short: 'h', default: false },
			},
		});
	} catch (error) {
		output.err(printable(errorText(error)));
		output.err(USAGE);
		return 2;
	}
	const { values, positionals: paths } = args;
	if (values.help) {
		output.out(USAGE);
		return 0;
	}
	if (paths.length === 0) {
		output.err(USAGE);
		return 2;
	}

	const problems: string[] = [];
	const threads: Thread[] = [];
	for (const path of paths) {
		try {
			const parsed = parseExport(await readFile(path, 'utf8'));
			threads.push(...parsed.threads);
			if (parsed.skipped > 0) problems.push(`${basename(path)}: skipped ${parsed.skipped} damaged ${parsed.skipped === 1 ? 'thread' : 'threads'}.`);
		} catch (error) {
			problems.push(`${basename(path)}: ${errorText(error)}.`);
		}
	}

	if (values['dry-run']) {
		for (const thread of threads) output.out(printable(`${objectName(thread)} (${objectDescription(thread)})`));
		output.out(`${countOf(threads.length, 'thread')} would be imported.`);
		return report(output, problems, 'Some files or threads would be left out:');
	}
	if (threads.length === 0) {
		output.err('No threads to import.');
		return report(output, problems);
	}

	const apiKey = env.ANYTYPE_API_KEY?.trim();
	if (!apiKey) {
		output.err('Set ANYTYPE_API_KEY first. In Anytype, open Settings → API Keys, click Create new and copy the key.');
		return 2;
	}

	let created = 0;
	let space: Space;
	try {
		const client = new AnytypeClient(env.ANYTYPE_API_URL?.trim() || DEFAULT_API_URL, apiKey);
		space = pickSpace(await client.listSpaces(), values.space);
		const known = new Map((await client.listProperties(space.id)).map((property) => [property.key, property.format]));
		for (const thread of threads) {
			const name = objectName(thread);
			// "description" shows under the name and "source" is the web address property that
			// Anytype's own bookmarks use. Both come with Anytype, but a space can lack them.
			const properties: PropertyValue[] = [];
			if (known.get('description') === 'text') properties.push({ key: 'description', text: objectDescription(thread) });
			if (known.get('source') === 'url' && /^https?:\/\//i.test(thread.url)) properties.push({ key: 'source', url: thread.url });
			try {
				await client.createObject(space.id, {
					name,
					type_key: values.type,
					body: threadToBody(thread),
					properties,
				});
				created++;
				output.out(`Imported: ${printable(name)}`);
			} catch (error) {
				// A refused key or a closed app fails every thread the same way; stop there.
				if (!(error instanceof AnytypeError) || error.status === null || error.status === 401) throw error;
				problems.push(`${name}: ${errorText(error)}`);
			}
		}
	} catch (error) {
		problems.push(errorText(error));
		output.out(`Imported ${countOf(created, 'thread')}.`);
		return report(output, problems);
	}
	output.out(printable(`Imported ${countOf(created, 'thread')} into the space "${space.name}".`));
	return report(output, problems);
}

/** The space named on the command line (by ID or name), or the only one there is. */
export function pickSpace(spaces: Space[], wanted: string | undefined): Space {
	const list = () => spaces.map((space) => `  ${space.name} (${space.id})`).join('\n');
	if (wanted === undefined) {
		if (spaces.length === 1) return spaces[0]!;
		throw new AnytypeError(spaces.length === 0 ? 'Anytype has no spaces to import into.' : `Pick a space with --space. You have:\n${list()}`);
	}
	const byId = spaces.find((space) => space.id === wanted);
	if (byId) return byId;
	const byName = spaces.filter((space) => space.name.toLowerCase() === wanted.trim().toLowerCase());
	if (byName.length === 1) return byName[0]!;
	if (byName.length > 1) throw new AnytypeError(`More than one space is called "${wanted}". Use its ID instead:\n${list()}`);
	throw new AnytypeError(`There's no space called "${wanted}". You have:\n${list()}`);
}

function report(output: Output, problems: string[], heading = 'Not everything was imported:'): number {
	if (problems.length === 0) return 0;
	output.err(heading);
	for (const problem of problems) output.err(printable(problem));
	return 1;
}

function countOf(count: number, noun: string): string {
	return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Thread titles come from strangers and space names can come from other members of a shared
 * space. Control characters are dropped before anything is printed so text can't move the
 * cursor or recolour the terminal. Line breaks between whole lines stay.
 */
export function printable(text: string): string {
	return text.replace(/[^\P{Cc}\n]/gu, '');
}
