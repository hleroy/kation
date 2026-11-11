// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

const NAMED: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * Text from Proton (file names, messages) as it may be printed to a terminal
 * or a log line: control characters (C0, DEL, C1) become visible escapes, so a
 * name cannot move the cursor, change colours or start a new line.
 */
export function printable(text: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
    return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => NAMED[char] ?? `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
