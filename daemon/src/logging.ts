// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { closeSync, mkdirSync, openSync } from 'node:fs';
import { readdir, rm, truncate } from 'node:fs/promises';
import path from 'node:path';

import { ConnectionError } from '@protontech/drive-sdk';
import {
    ConsoleLogHandler,
    LogFilter,
    type LogHandler,
    LogLevel,
    type LogRecord,
    type MetricEvent,
    type MetricHandler,
    Telemetry,
} from '@protontech/drive-sdk/telemetry';

import type { Config } from './config';
import { printable } from './printable';
import { FileLogHandler } from './proton/telemetry/fileHandler';
import { ColoredLogFormatter } from './proton/telemetry/logFormatters';

/** The name FileLogHandler gives the current log; rotated ones add `.1` to `.5`. */
const LOG_FILE_NAME = 'kationd.log';

/** SDK loggers that write several INFO lines per request or transferred block. */
const QUIET_SDK_LOGGERS = ['api', 'interface', 'upload', 'download'];

/**
 * Logging to a local file: logs and SDK metrics go to a rotating log file (and
 * optionally the console). Nothing is sent to Proton or anywhere else. The SDK
 * calls the object it logs through its "telemetry", hence the imports and `localLog`.
 */
export function initLogging(config: Config) {
    mkdirSync(config.logDir, { recursive: true, mode: 0o700 });
    // The copied handler creates the log with the umask's mode; create it private first.
    closeSync(openSync(path.join(config.logDir, LOG_FILE_NAME), 'a', 0o600));
    const fileHandler = new FileLogHandler(config.logDir);
    // safeLog runs first: the wrappers inside build messages from text it has escaped and masked.
    const wrapped = (handler: LogHandler) => safeLog(networkErrorIsWarning(cancellationIsNotAnError(handler)));
    const logHandlers: LogHandler[] = [wrapped(fileHandler)];
    if (config.enableConsoleLog) {
        logHandlers.push(wrapped(new ConsoleLogHandler(new ColoredLogFormatter())));
    }

    const logFilter = logFilterFor(config.logLevel);
    const localLog = new Telemetry({
        logFilter,
        logHandlers,
        metricHandlers: [metricsAsLogs(logFilter, logHandlers)],
    });

    return {
        localLog,
        flush: () => fileHandler.flush(),
        /** Deletes the rotated logs and empties the current one, which stays open. */
        clearLog: async () => {
            await fileHandler.flush();
            // The handler appends: later lines start at the beginning again. Truncated before
            // deleting the rotated logs: a rotation meanwhile moves the old log to one of them.
            await truncate(path.join(config.logDir, LOG_FILE_NAME), 0).catch(() => {});
            for (const name of await readdir(config.logDir).catch(() => [] as string[])) {
                if (name.startsWith(`${LOG_FILE_NAME}.`) && /^\d+$/.test(name.slice(LOG_FILE_NAME.length + 1))) {
                    await rm(path.join(config.logDir, name), { force: true });
                }
            }
        },
    };
}

/**
 * At INFO, the chatty SDK loggers only pass warnings and errors. Any other level
 * applies to all loggers alike, so DEBUG brings their lines back.
 */
export function logFilterFor(level: LogLevel): LogFilter {
    const loggerLevels = level === LogLevel.INFO ? Object.fromEntries(QUIET_SDK_LOGGERS.map((name) => [name, LogLevel.WARNING])) : {};
    return new LogFilter({ globalLevel: level, loggerLevels });
}

const FAILURE_METRICS = ['decryptionError', 'verificationError', 'blockVerificationError'];

/** SDK metrics as lines of the same log, `[metrics] <event> {…}`: routine ones at DEBUG, failures at WARNING. */
export function metricsAsLogs(filter: LogFilter, handlers: LogHandler[]): MetricHandler<MetricEvent> {
    return {
        onEvent({ time, event }) {
            const { eventName, ...fields } = event as MetricEvent & Record<string, unknown>;
            const record: LogRecord = {
                time,
                level: metricLevel(eventName, fields),
                loggerName: 'metrics',
                message: `${eventName} ${JSON.stringify(fields, metricValue)}`,
            };
            if (filter.filter(record)) {
                for (const handler of handlers) {
                    handler.log(record);
                }
            }
        },
    };
}

function metricLevel(eventName: string, fields: Record<string, unknown>): LogLevel {
    if (eventName === 'performance') {
        return LogLevel.DEBUG;
    }
    if (eventName === 'upload' || eventName === 'download') {
        return fields.error === undefined ? LogLevel.DEBUG : LogLevel.WARNING;
    }
    return FAILURE_METRICS.includes(eventName) ? LogLevel.WARNING : LogLevel.INFO;
}

function metricValue(_key: string, value: unknown): unknown {
    // An Error serialises as {} or as its code and path only.
    if (value instanceof Error) {
        return value.message;
    }
    if (typeof value === 'number' && !Number.isInteger(value)) {
        return Math.round(value * 10) / 10;
    }
    return value;
}

/**
 * Messages and errors can hold remote names: their control characters are
 * escaped, so one cannot start a forged line. The formatter's own line breaks
 * (before the error and its stack) stay. Transfer tokens are masked.
 */
export function safeLog(handler: LogHandler): LogHandler {
    return {
        log(record: LogRecord) {
            handler.log({ ...record, message: safeText(record.message), error: safeError(record.error) });
        },
    };
}

function safeText(text: string): string {
    return maskTokens(printable(text));
}

/**
 * The SDK names a block or thumbnail transfer by its token ("block 1:<token>: Uploaded"),
 * which grants the transfer for hours. Block tokens are JWTs; thumbnail ones may not be.
 */
function maskTokens(text: string): string {
    return text
        .replace(/(?<![\w-])eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, '<token>')
        .replace(/\b(block \d+:|thumbnail (?:type \S+ to )?)[\w.~+/=-]{16,}(?=: )/g, '$1<token>');
}

function safeError(error: unknown): unknown {
    if (error === undefined) {
        return undefined;
    }
    // The account SDK logs a failed session refresh with its Response as the error.
    if (error instanceof Response) {
        return safeText(`HTTP ${error.status} ${error.statusText}`.trimEnd());
    }
    if (!(error instanceof Error)) {
        return safeText(String(error));
    }
    const message = safeText(error.message);
    if (message === error.message) {
        return error;
    }
    // A copy of the same class (instanceof and name still work); the stack starts with the message.
    const copy = Object.create(Object.getPrototypeOf(error)) as Error;
    Object.defineProperties(copy, {
        name: { value: error.name, writable: true, configurable: true },
        message: { value: message, writable: true, configurable: true },
        // A function, so "$&" and the like in a name are not replacement patterns.
        stack: { value: error.stack?.replace(error.message, () => message), writable: true, configurable: true },
        cause: { value: error.cause, writable: true, configurable: true },
    });
    return copy;
}

/**
 * The SDK logs a transfer stopped on purpose (pause, cancel) as
 * "ERROR Download failed: Operation aborted". Kation stops transfers routinely,
 * so these are logged as INFO; real failures stay errors.
 */
export function cancellationIsNotAnError(handler: LogHandler): LogHandler {
    return {
        log(record: LogRecord) {
            if (record.level === LogLevel.ERROR && isAbort(record.error)) {
                handler.log({ ...record, level: LogLevel.INFO, message: `${record.message} (stopped on purpose)`, error: undefined });
                return;
            }
            handler.log(record);
        },
    };
}

const NETWORK_ERROR_CODE = /^(?:EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)$/;
// "getaddrinfo EAI_AGAIN host", "ECONNREFUSED: Unable to connect": only at the start, so a path holding such a word does not count.
const NETWORK_ERROR_MESSAGE = /^(?:\w+ )?(?:EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/;

/**
 * Being offline or without DNS is routine (startup before the network is up,
 * resume from sleep): such an ERROR becomes a one-line WARNING without the stack.
 */
export function networkErrorIsWarning(handler: LogHandler): LogHandler {
    return {
        log(record: LogRecord) {
            if (
                record.level === LogLevel.ERROR &&
                record.error instanceof Error &&
                !isAbort(record.error) &&
                isNetworkError(record.error)
            ) {
                handler.log({
                    ...record,
                    level: LogLevel.WARNING,
                    message: `${record.message}: ${record.error.message}`,
                    error: undefined,
                });
                return;
            }
            handler.log(record);
        },
    };
}

function isNetworkError(error: unknown, depth = 0): boolean {
    if (!(error instanceof Error) || depth > 5) {
        return false;
    }
    if (error instanceof ConnectionError) {
        return true;
    }
    // The message too: safeError's copy of an error does not carry its code.
    const code = (error as { code?: unknown }).code;
    if ((typeof code === 'string' && NETWORK_ERROR_CODE.test(code)) || NETWORK_ERROR_MESSAGE.test(error.message)) {
        return true;
    }
    return isNetworkError(error.cause, depth + 1);
}

function isAbort(error: unknown): boolean {
    // The SDK's AbortError and DOM aborts from an AbortSignal share this name.
    return error instanceof Error && error.name === 'AbortError';
}
