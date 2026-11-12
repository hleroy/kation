// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AbortError, ConnectionError } from '@protontech/drive-sdk';
import { LogLevel, type LogRecord, type MetricEvent } from '@protontech/drive-sdk/telemetry';

import { getConfig } from '../src/config';
import { cancellationIsNotAnError, initLogging, logFilterFor, metricsAsLogs, networkErrorIsWarning, safeLog } from '../src/logging';
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
        expect(logged[0].error).toBeUndefined();
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
        const { localLog, clearLog, flush } = initLogging(config);
        const logger = localLog.getLogger('test');
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
        const { localLog, clearLog, flush } = initLogging(config);
        const logger = localLog.getLogger('test');

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
        const { localLog, flush } = initLogging(config);
        const logger = localLog.getLogger('test');
        // "$&" would bring the raw text back if used as a replacement pattern.
        const forged = 'a$&.txt\n2026-11-11T00:00:00.000Z ERROR [kationd] forged';
        logger.info(`Downloading /${forged}`);
        logger.error('Failed to sync', new Error(`Not found: /${forged}`));
        await flush();

        const content = await readFile(path.join(config.logDir, 'kationd.log'), 'utf8');
        const lines = content.trimEnd().split('\n');
        expect(lines.filter((line) => line.includes('forged'))).toHaveLength(3);
        expect(lines.some((line) => line.startsWith('2026-11-11T00:00:00.000Z'))).toBe(false);
        expect(lines[0]).toContain('Downloading /a$&.txt\\n2026-11-11T00:00:00.000Z ERROR [kationd] forged');
    });
});

// Built here so that the secret scanner does not take the fixture for a real token.
const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const JWT = [base64url({ alg: 'HS256', typ: 'JWT' }), base64url({ sub: 'block', exp: 1 }), 'signature-'.repeat(4)].join('.');

/** The lines kationd.log holds after `write` ran with a logger at `level`. */
async function logLines(
    level: string | undefined,
    write: (localLog: ReturnType<typeof initLogging>['localLog']) => void,
): Promise<string[]> {
    const home = await tempDir();
    const env = level ? { KATION_LOG_LEVEL: level } : {};
    const config = getConfig({ appVersion: 'test', sdkVersion: 'test', home, env });
    const { localLog, flush } = initLogging(config);
    write(localLog);
    await flush();
    const content = await readFile(path.join(config.logDir, 'kationd.log'), 'utf8');
    return content === '' ? [] : content.trimEnd().split('\n');
}

describe('logFilterFor', () => {
    const record = (loggerName: string, level: LogLevel): LogRecord => ({ time: new Date(), level, loggerName, message: 'x' });

    it('keeps SDK chatter out at INFO, but not its warnings nor Kation lines', () => {
        const filter = logFilterFor(LogLevel.INFO);
        for (const name of ['api', 'interface', 'upload', 'download']) {
            expect(filter.filter(record(name, LogLevel.INFO))).toBe(false);
            expect(filter.filter(record(name, LogLevel.WARNING))).toBe(true);
            expect(filter.filter(record(name, LogLevel.ERROR))).toBe(true);
        }
        expect(filter.filter(record('kationd', LogLevel.INFO))).toBe(true);
        expect(filter.filter(record('events', LogLevel.INFO))).toBe(true);
        expect(filter.filter(record('kationd', LogLevel.DEBUG))).toBe(false);
    });

    it('brings everything back at DEBUG', () => {
        const filter = logFilterFor(LogLevel.DEBUG);
        expect(filter.filter(record('api', LogLevel.INFO))).toBe(true);
        expect(filter.filter(record('api', LogLevel.DEBUG))).toBe(true);
        expect(filter.filter(record('kationd', LogLevel.INFO))).toBe(true);
    });
});

describe('metricsAsLogs', () => {
    const logged = (level: LogLevel, ...events: object[]): LogRecord[] => {
        const records: LogRecord[] = [];
        const handler = metricsAsLogs(logFilterFor(level), [{ log: (log) => records.push(log) }]);
        for (const event of events) {
            handler.onEvent({ time: new Date(), event: event as MetricEvent });
        }
        return records;
    };
    const performance = {
        eventName: 'performance',
        type: 'content_encryption',
        cryptoModel: 'v1',
        bytesProcessed: 1466,
        milliseconds: 1.234567890123456,
    };
    const uploaded = { eventName: 'upload', volumeType: 'own_volume', uploadedSize: 1466, expectedSize: 1466 };

    it('keeps routine metrics for DEBUG', () => {
        expect(logged(LogLevel.INFO, performance, uploaded, { ...uploaded, eventName: 'download' })).toEqual([]);
        const records = logged(LogLevel.DEBUG, performance, uploaded);
        expect(records.map((log) => [log.level, log.loggerName])).toEqual([
            [LogLevel.DEBUG, 'metrics'],
            [LogLevel.DEBUG, 'metrics'],
        ]);
        expect(records[0].message).toBe(
            'performance {"type":"content_encryption","cryptoModel":"v1","bytesProcessed":1466,"milliseconds":1.2}',
        );
    });

    it('logs failures as warnings, with the message of their error', () => {
        const records = logged(
            LogLevel.INFO,
            { eventName: 'decryptionError', field: 'nodeName', uid: 'v~n', error: new Error('bad key') },
            { ...uploaded, error: 'network_error', originalError: new Error('socket closed') },
            { eventName: 'blockVerificationError', volumeType: 'own_volume', retryHelped: true },
        );
        expect(records.map((log) => log.level)).toEqual([LogLevel.WARNING, LogLevel.WARNING, LogLevel.WARNING]);
        expect(records[0].message).toBe('decryptionError {"field":"nodeName","uid":"v~n","error":"bad key"}');
        expect(records[1].message).toContain('"originalError":"socket closed"');
    });

    it('logs the other events at INFO, whatever the previous error is', () => {
        const dns = Object.assign(new TypeError('getaddrinfo EAI_AGAIN drive-api.proton.me'), {
            code: 'EAI_AGAIN',
            syscall: 'getaddrinfo',
        });
        const records = logged(
            LogLevel.INFO,
            { eventName: 'apiRetrySucceeded', url: 'https://x/blocks', failedAttempts: 1, previousError: 502 },
            { eventName: 'apiRetrySucceeded', url: 'https://x/links', failedAttempts: 1, previousError: dns },
            { eventName: 'somethingNew' },
        );
        expect(records.map((log) => log.level)).toEqual([LogLevel.INFO, LogLevel.INFO, LogLevel.INFO]);
        expect(records[0].message).toBe('apiRetrySucceeded {"url":"https://x/blocks","failedAttempts":1,"previousError":502}');
        expect(records[1].message).toContain('"previousError":"getaddrinfo EAI_AGAIN drive-api.proton.me"');
        expect(records[2].message).toBe('somethingNew {}');
    });

    it('writes them as text lines of the log file', async () => {
        const record = (localLog: ReturnType<typeof initLogging>['localLog']) => {
            localLog.recordMetric(performance as MetricEvent);
            localLog.recordMetric({ eventName: 'volumeEventsSubscriptionsChanged', numberOfVolumeSubscriptions: 1 } as MetricEvent);
        };
        const atInfo = await logLines(undefined, record);
        expect(atInfo).toHaveLength(1);
        expect(atInfo[0]).toEndWith('INFO [metrics] volumeEventsSubscriptionsChanged {"numberOfVolumeSubscriptions":1}');

        const atDebug = await logLines('DEBUG', record);
        expect(atDebug).toHaveLength(2);
        expect(atDebug[0]).toContain('DEBUG [metrics] performance {');
        expect(atDebug.some((line) => line.startsWith('{'))).toBe(false);
    });
});

describe('safeLog', () => {
    const safe = (message: string, error?: unknown): LogRecord => {
        const logged: LogRecord[] = [];
        safeLog({ log: (log) => logged.push(log) }).log({ time: new Date(), level: LogLevel.ERROR, loggerName: 'upload', message, error });
        return logged[0];
    };

    it('masks a transfer token in the message, the error and its stack', () => {
        const error = new Error(`PUT failed for ${JWT}`);
        const record = safe(`revision v~n~r: block 1:${JWT}: Upload failed #1, retrying`, error);
        expect(record.message).toBe('revision v~n~r: block 1:<token>: Upload failed #1, retrying');
        expect((record.error as Error).message).toBe('PUT failed for <token>');
        expect((record.error as Error).stack).toContain('PUT failed for <token>');
        expect((record.error as Error).stack).not.toContain('eyJ');
        expect(record.error).toBeInstanceOf(Error);
        expect(safe('failed', `token ${JWT}`).error).toBe('token <token>');
    });

    it('masks block and thumbnail tokens of any shape', () => {
        expect(safe('revision r: block 2:opaque-token-0123456789: Uploaded').message).toBe('revision r: block 2:<token>: Uploaded');
        expect(safe('thumbnail type 1 to opaque-token-0123456789: Upload started').message).toBe(
            'thumbnail type 1 to <token>: Upload started',
        );
        expect(safe('thumbnail opaque-token-0123456789: Download failed').message).toBe('thumbnail <token>: Download failed');
    });

    it('leaves other text alone', () => {
        for (const message of [
            'revision r: block 3: Skipping hash check',
            'Getting node 8fHgVg5QD2Yd2xdrMtw6SeyJURbjg_62G_40GZniCy0Ih==~ispYUF76ajWA0DunTzZvxPLG3XE_cuhl==',
            'Uploading /Photos/thumbnail a-rather-long-file-name.jpeg',
            'Uploading /Music/HeyJoe.v1.2.txt',
            'Uploading /backup/eyJhbGci.tar.gz',
            'Uploading /notes/block 1:a-rather-long-file-name.txt',
        ]) {
            expect(safe(message).message).toBe(message);
        }
        const error = new Error('boom');
        expect(safe('failed', error).error).toBe(error);
    });

    it('names the status of a Response logged as an error', () => {
        expect(safe('Failed to refresh session', new Response(null, { status: 400 })).error).toBe('HTTP 400');
        expect(safe('Failed to refresh session', new Response(null, { status: 422, statusText: 'Unprocessable\nEntity' })).error).toBe(
            'HTTP 422 Unprocessable\\nEntity',
        );
    });
});

describe('networkErrorIsWarning', () => {
    const through = (error: unknown, level = LogLevel.ERROR): LogRecord => {
        const logged: LogRecord[] = [];
        const handler = networkErrorIsWarning({ log: (log) => logged.push(log) });
        handler.log({ time: new Date(), level, loggerName: 'kationd', message: 'Error loading user data', error });
        return logged[0];
    };
    const dns = () => Object.assign(new TypeError('getaddrinfo EAI_AGAIN drive-api.proton.me'), { code: 'EAI_AGAIN' });

    it('logs a network failure as a one-line warning', () => {
        const wrapped = new Error('getaddrinfo EAI_AGAIN drive-api.proton.me', { cause: dns() });
        const byCauseOnly = new Error('Request failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) });
        for (const error of [dns(), wrapped, new Error('getaddrinfo ENOTFOUND drive-api.proton.me'), new ConnectionError('Offline')]) {
            const record = through(error);
            expect(record.level).toBe(LogLevel.WARNING);
            expect(record.message).toBe(`Error loading user data: ${(error as Error).message}`);
            expect(record.error).toBeUndefined();
        }
        expect(through(byCauseOnly).message).toBe('Error loading user data: Request failed');
    });

    it('keeps other errors, with their stack', () => {
        const boom = new Error('boom');
        expect(through(boom)).toMatchObject({ level: LogLevel.ERROR, message: 'Error loading user data', error: boom });
        expect(through('EAI_AGAIN').level).toBe(LogLevel.ERROR);
        expect(through(new Error('Cannot decrypt /docs/ENOTFOUND.txt')).level).toBe(LogLevel.ERROR);
        expect(through(Object.assign(new AbortError(), { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) })).level).toBe(
            LogLevel.ERROR,
        );
        expect(through(undefined).level).toBe(LogLevel.ERROR);
    });

    it('stops at a cause chain that loops', () => {
        const a = new Error('a');
        const b = new Error('b', { cause: a });
        a.cause = b;
        expect(through(a).level).toBe(LogLevel.ERROR);
    });
});

describe('the log file', () => {
    it('gets a network error as one escaped, masked warning line', async () => {
        const lines = await logLines(undefined, (localLog) => {
            const error = Object.assign(new Error(`ECONNRESET on ${JWT}\nsecond line`), { code: 'ECONNRESET' });
            localLog.getLogger('upload').error(`revision r: block 1:${JWT}: Upload failed`, error);
        });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toEndWith('WARNING [upload] revision r: block 1:<token>: Upload failed: ECONNRESET on <token>\\nsecond line');
    });

    it('gets a transfer stopped on purpose as one INFO line', async () => {
        const lines = await logLines(undefined, (localLog) => {
            localLog.getLogger('download').error('revision r: Download failed', new AbortError());
            localLog.getLogger('download').info('revision r: Starting download');
            localLog.getLogger('api').info('GET https://x: 200 (12ms)');
        });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toEndWith('INFO [download] revision r: Download failed (stopped on purpose)');
    });
});
