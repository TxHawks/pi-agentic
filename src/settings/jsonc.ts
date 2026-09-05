import { SettingsError } from "./error.ts";

/**
 * Turn JSONC text into a plain value. JSONC is JSON plus comments and
 * trailing commas. The scanner blanks comments and trailing commas with
 * spaces and keeps every newline, so a JSON.parse error still points at
 * the true line in the file. A parse failure throws a SettingsError that
 * names the file.
 */
export function parseJsonc(text: string, file: string): unknown {
	const clean = blankJsoncExtras(text, file);
	try {
		return JSON.parse(clean);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new SettingsError(file, `the file is not valid JSONC (${detail})`);
	}
}

function blankJsoncExtras(text: string, file: string): string {
	const chars = text.split("");
	if (chars[0] === "\uFEFF") chars[0] = " ";
	let i = 0;
	while (i < chars.length) {
		const char = chars[i];
		if (char === '"') {
			i = skipString(chars, i);
		} else if (char === "/" && chars[i + 1] === "/") {
			while (i < chars.length && chars[i] !== "\n") {
				chars[i] = " ";
				i++;
			}
		} else if (char === "/" && chars[i + 1] === "*") {
			const end = findBlockCommentEnd(chars, i, file);
			for (; i < end; i++) {
				if (chars[i] !== "\n") chars[i] = " ";
			}
		} else {
			if (char === "," && isTrailingComma(chars, i, file)) chars[i] = " ";
			i++;
		}
	}
	return chars.join("");
}

/** Return the index just past the closing quote of the string that starts at `start`. */
function skipString(chars: string[], start: number): number {
	let i = start + 1;
	while (i < chars.length) {
		if (chars[i] === "\\") {
			i += 2;
		} else if (chars[i] === '"') {
			return i + 1;
		} else {
			i++;
		}
	}
	return i;
}

/** Return the index just past the `*` and `/` pair that closes the comment at `start`. */
function findBlockCommentEnd(chars: string[], start: number, file: string): number {
	for (let i = start + 2; i + 1 < chars.length; i++) {
		if (chars[i] === "*" && chars[i + 1] === "/") return i + 2;
	}
	throw new SettingsError(file, "a block comment is not closed (the */ is missing)");
}

/** A comma is trailing when the next character after spaces and comments is `}` or `]`. */
function isTrailingComma(chars: string[], commaIndex: number, file: string): boolean {
	let i = commaIndex + 1;
	while (i < chars.length) {
		const char = chars[i];
		if (char === " " || char === "\t" || char === "\n" || char === "\r") {
			i++;
		} else if (char === "/" && chars[i + 1] === "/") {
			while (i < chars.length && chars[i] !== "\n") i++;
		} else if (char === "/" && chars[i + 1] === "*") {
			i = findBlockCommentEnd(chars, i, file);
		} else {
			return char === "}" || char === "]";
		}
	}
	return false;
}
