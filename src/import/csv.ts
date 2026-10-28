/**
 * Splits RFC 4180 CSV into rows of cells. Quoted cells may contain commas, quotes and line breaks.
 * `unterminated` is set when the text ends inside a quoted cell: that cell has swallowed everything
 * after it, so the last row can't be trusted.
 */
export function parseCsvRows(text: string): { rows: string[][]; unterminated: boolean } {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const char = text.charAt(index);
		if (quoted) {
			if (char !== '"') cell += char;
			else if (text.charAt(index + 1) === '"') {
				cell += '"';
				index++;
			} else quoted = false;
		} else if (char === '"') quoted = true;
		else if (char === ',') {
			row.push(cell);
			cell = '';
		} else if (char === '\n' || char === '\r') {
			if (char === '\r' && text.charAt(index + 1) === '\n') index++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
		} else cell += char;
	}
	if (cell !== '' || row.length > 0 || quoted) {
		row.push(cell);
		rows.push(row);
	}
	return { rows, unterminated: quoted };
}

/**
 * The extension puts a ' in front of text cells that start with = + - @, a tab, a line break or
 * the full-width ＝ ＋ － ＠, so a spreadsheet doesn't run them as formulas. Taking it off gives
 * back the original text, for example a comment that starts with a "- " list.
 */
export function removeFormulaGuard(cell: string): string {
	return /^'[=+\-@\t\r\n＝＋－＠]/.test(cell) ? cell.slice(1) : cell;
}
