/**
 * The one error type the settings domain throws. The message always names
 * the settings file, so a user can find and repair the bad line. A caller
 * must not catch and hide this error: a broken settings file is a loud stop.
 */
export class SettingsError extends Error {
	readonly file: string;

	constructor(file: string, problem: string) {
		super(`${file}: ${problem}`);
		this.name = "SettingsError";
		this.file = file;
	}
}
