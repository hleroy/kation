// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';

import { formatRows } from '../src/client';
import { printable } from '../src/printable';

describe('printable', () => {
    it('escapes control characters', () => {
        expect(printable('a\x1b[2Jb')).toBe('a\\x1b[2Jb');
        expect(printable('line\r\nnext')).toBe('line\\r\\nnext');
        expect(printable('nul\0tab\t')).toBe('nul\\x00tab\\t');
        expect(printable('del\x7fcsi\u009b')).toBe('del\\x7fcsi\\x9b');
    });

    it('leaves everything else as it is', () => {
        for (const text of ['é', '日本', 'a b', '😀', 'back\\slash', '']) {
            expect(printable(text)).toBe(text);
        }
    });
});

describe('formatRows', () => {
    it('prints names with control characters escaped', () => {
        const lines = formatRows([
            { name: 'clear\x1b[2J.txt', type: 'file', size: 3, modified: '2026-11-11T10:00:00.000Z' },
            { name: 'two\nlines', type: 'folder', size: null, modified: '2026-11-11T10:00:00.000Z' },
        ]);
        expect(lines).toEqual([`2026-11-11 10:00             -  two\\nlines/`, `2026-11-11 10:00             3  clear\\x1b[2J.txt`]);
    });
});
