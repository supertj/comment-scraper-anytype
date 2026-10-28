# Comment Scraper to Anytype

A small command-line tool that imports Reddit and Hacker News threads you exported with Comment Scraper into Anytype. Each thread becomes one object: the post at the top, then every comment with its number, score, time and a link back to it.

[Comment Scraper](https://comment-scraper.com/) is a Chrome and Edge extension that saves a whole thread as CSV, JSON, Markdown or Org. This tool reads the CSV and JSON files and creates the objects through the API that the Anytype desktop app runs on your computer.

## What you need

- Anytype for desktop, open and signed in.
- Node.js 20 or newer.
- An Anytype API key. In Anytype, open **Settings → API Keys**, click **Create new**, give it a name you'll recognise (for example "Comment Scraper") and copy the key.

Put the key in an environment variable rather than on the command line, so it doesn't end up in your shell history. One way is a file only you can read:

```sh
printf 'export ANYTYPE_API_KEY=%s\n' 'paste-the-key-here' > ~/.anytype-api-key
chmod 600 ~/.anytype-api-key
. ~/.anytype-api-key
```

## Usage

1. In the extension, export a thread as **CSV**, **JSON, one row per comment** or **JSON, replies nested**. Batch exports with several threads in one file work too.
2. Run the tool on one or more export files:

```sh
npx comment-scraper-anytype --space "Research" ~/Downloads/reddit-1abcxyz.json
```

If you only have one space, you can leave out `--space`. If you have several and leave it out, the tool lists them with their IDs and stops.

| Option | What it does |
|---|---|
| `--space <name or id>` | The space to import into. Names are matched without regard to case. |
| `--type <type key>` | The type of the new objects. The default is `page`. |
| `--dry-run` | Reads the files and lists the threads it found, without contacting Anytype. |

`ANYTYPE_API_URL` changes where the tool looks for the API. The default is `http://127.0.0.1:31009`, the address the desktop app uses. The tool only accepts addresses on your own computer, because the key gives access to your whole vault and the API runs over plain HTTP.

## What an object looks like

The object's name is the thread title. Its description says where the thread came from and how many comments the file has, and its Source property points at the thread. The body looks like this:

````markdown
Reddit · r/smallbusiness · [original thread](https://www.reddit.com/r/smallbusiness/comments/1abcxyz/which_crm/)

Exported 2026-10-20 15:33 UTC · 48 comments in this export

**Post** · 321 points · 2026-09-20 14:13 UTC · [link](https://www.reddit.com/r/...)

```
Five of us, mostly email and a shared spreadsheet. What did you switch to?
```

## Comments

**[c1]** · 57 points · 2026-09-20 15:02 UTC · [link](https://www.reddit.com/r/...)

```
We tried three. The one that stuck was the one people opened without being asked.
```

**[c2]** · reply to [c1] · 12 points · 2026-09-20 15:40 UTC · OP · [link](https://www.reddit.com/r/...)

```
Which one was it?
```
````

A few details:

- Comments are listed in reading order, each one followed by its replies. Every reply says which comment it answers.
- The numbers are the ones the extension uses in its Markdown export and its AI briefs. Comments are counted in the order they appear in the file, so [c12] in a brief is [c12] in Anytype.
- Times are in UTC. "Exported" is when the extension fetched the thread. If the export stopped early, for example at a rate limit, the thread itself may have more comments than the file.
- Hacker News doesn't publish comment scores, so HN comments show none. A Reddit comment whose score was still hidden shows "score hidden".
- Deleted and removed comments keep their place and their number, marked *(deleted)* or *(removed)*.
- Author names aren't included, because the extension doesn't export them ([why](https://comment-scraper.com/docs#why-no-usernames)). A username someone typed into their comment stays in the text.
- In CSV, the extension puts a ' in front of text that starts with =, +, - or @ so spreadsheets don't treat it as a formula, and the tool takes it off again. A comment that really did start with something like '- loses that apostrophe. JSON doesn't have this problem, so use JSON if that matters.
- Importing the same thread twice creates a second object. The tool never changes objects that are already there.
- If your space has no description or Source property, the object is created without it.

The Markdown export isn't supported: it has no links to individual comments, and its times are relative ("3d ago"). The fields in each export format are described in the [Comment Scraper docs](https://comment-scraper.com/docs#formats-and-fields).

## Why comment text is in code blocks

Anytype turns the body into blocks with its Markdown importer. In plain Markdown, a comment could add an image block that points at someone else's server or at a file on your computer, a link whose address isn't a web page, a link to one of your own objects, or a collapsible block. Anything can be in a comment, so the tool puts every post and comment in a code block, where all of that stays text. The downside is that Reddit formatting such as bold, lists and links shows up exactly as it was typed.

## Network and file access

The tool reads only the files you name. It talks only to the Anytype API on your computer: it lists your spaces, reads the property list of the space you import into, and creates one object per thread. It doesn't update or delete anything.

Anytype allows bursts of 60 API requests, then one a second. Each thread is one request, so a large batch slows down after the first 60 threads. When Anytype says to wait, the tool waits and tries again.

## Building from source

```sh
npm install
npm test
npm run build   # writes dist/cli.js
node dist/cli.js --help
```

The tests run the tool against a stand-in for the Anytype API that answers the way the [API reference](https://developers.anytype.io/docs/reference) describes.

## License

[MIT](LICENSE)
