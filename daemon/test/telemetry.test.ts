// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';

import { AbortError } from '@protontech/drive-sdk';
import { LogLevel, type LogRecord } from '@protontech/drive-sdk/telemetry';

import { cancellationIsNotAnError } from '../src/telemetry';

describe('cancellationIsNotAnError', () => {
    const record = (error: unknown): LogRecord => ({
        time: new Date(),
        level: LogLevel.ERROR,
        loggerName: 'download',
        message: 'Download failed',
        error,
    });

    it('logs transfers stopped on purpose as INFO', () => {
        const logged: LogRecord[] = [];
        const handler = cancellationIsNotAnError({ log: (log) => logged.push(log) });
        handler.log(record(new AbortError()));
        handler.log(record(new DOMException('The operation was aborted.', 'AbortError')));
        expect(logged.map((log) => log.level)).toEqual([LogLevel.INFO, LogLevel.INFO]);
        expect(logged[0].message).toBe('Download failed (stopped on purpose)');
    });

    it('keeps other failures as errors', () => {
        const logged: LogRecord[] = [];
        const handler = cancellationIsNotAnError({ log: (log) => logged.push(log) });
        handler.log(record(new Error('Connection reset')));
        expect(logged[0].level).toBe(LogLevel.ERROR);
        expect(logged[0].message).toBe('Download failed');
    });
});
