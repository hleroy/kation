// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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

    it('leaves no old line behind when a line logged meanwhile rotates the log', async () => {
        const home = await tempDir();
        const config = getConfig({ appVersion: 'test', sdkVersion: 'test', home, env: {} });
        await mkdir(config.logDir, { recursive: true });
        const line = 'old line about /Secret/file.txt\n';
        await writeFile(path.join(config.logDir, 'kationd.log'), line.repeat(Math.floor((5 * 1024 * 1024 - 600) / line.length)));
        const { telemetry, clearLog, flush } = initTelemetry(config);
        const logger = telemetry.getLogger('test');

        const clearing = clearLog();
        logger.info('x'.repeat(1000));
        await clearing;
        await flush();

        for (const name of await readdir(config.logDir)) {
            expect(await readFile(path.join(config.logDir, name), 'utf8')).not.toContain('Secret');
        }
    });
});

describe('log lines', () => {
    it('cannot be forged by text from a remote name', async () => {
        const home = await tempDir();
        const config = getConfig({ appVersion: 'test', sdkVersion: 'test', home, env: {} });
        const { telemetry, flush } = initTelemetry(config);
        const logger = telemetry.getLogger('test');
        const forged = 'a.txt\n2026-11-11T00:00:00.000Z ERROR [kationd] forged';
        logger.info(`Downloading /${forged}`);
        logger.error('Failed to sync', new Error(`Not found: /${forged}`));
        await flush();

        const content = await readFile(path.join(config.logDir, 'kationd.log'), 'utf8');
        const lines = content.trimEnd().split('\n');
        expect(lines.filter((line) => line.includes('forged'))).toHaveLength(3);
        expect(lines.some((line) => line.startsWith('2026-11-11T00:00:00.000Z'))).toBe(false);
        expect(lines[0]).toContain('Downloading /a.txt\\n2026-11-11T00:00:00.000Z ERROR [kationd] forged');
    });
});
