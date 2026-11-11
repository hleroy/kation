// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AbortError } from '@protontech/drive-sdk';
import { LogLevel, type LogRecord } from '@protontech/drive-sdk/telemetry';

import { getConfig } from '../src/config';
import { cancellationIsNotAnError, initTelemetry } from '../src/telemetry';
import { tempDir } from './helpers';

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

describe('clearLog', () => {
    it('deletes rotated logs and empties the current one, which keeps working', async () => {
        const home = await tempDir();
        const config = getConfig({ appVersion: 'test', sdkVersion: 'test', home, env: {} });
        const { telemetry, clearLog, flush } = initTelemetry(config);
        const logger = telemetry.getLogger('test');
        for (let i = 1; i <= 5; i++) {
            await writeFile(path.join(config.logDir, `kationd.log.${i}`), 'old /Secret/file.txt\n');
        }
        logger.info('Downloading /Secret/file.txt');
        await flush();

        await clearLog();
        logger.info('Signed out; log cleared');
        await flush();

        expect(await readdir(config.logDir)).toEqual(['kationd.log']);
        const content = await readFile(path.join(config.logDir, 'kationd.log'), 'utf8');
        expect(content).not.toContain('Secret');
        expect(content).toStartWith(content.trimStart());
        expect(content.includes('\0')).toBe(false);
        expect(content.trim().split('\n')).toHaveLength(1);
        expect(content).toContain('Signed out; log cleared');
    });
});
