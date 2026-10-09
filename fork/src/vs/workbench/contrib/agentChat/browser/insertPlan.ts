/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A span of the chat input, as 0-based offsets with an exclusive end. */
export interface TextSpan {
	readonly start: number;
	readonly end: number;
}

/**
 * Where a new inline reference is inserted.
 * A caret inside an existing pill moves to just after that pill and one trailing space,
 * so a second reference is never spliced into the first.
 */
export function referenceInsertionOffset(text: string, cursor: number, pills: readonly TextSpan[]): number {
	const max = text.length;
	let offset = Math.max(0, Math.min(cursor, max));
	for (const pill of pills) {
		if (offset > pill.start && offset < pill.end) {
			offset = Math.min(Math.max(pill.end, 0), max);
			if (text.charAt(offset) === ' ') {
				offset++;
			}
			break;
		}
	}
	return Math.min(offset, max);
}

/** A separating space, unless the insertion point is already next to whitespace. */
export function referencePrefix(text: string, offset: number): string {
	const before = offset > 0 ? text.charAt(offset - 1) : '';
	if (!before || /\s/.test(before)) {
		return '';
	}
	const at = offset < text.length ? text.charAt(offset) : '';
	if (at && /\s/.test(at)) {
		return '';
	}
	return ' ';
}
