// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { closeSync, mkdirSync, openSync } from 'node:fs';
import { readdir, rm, truncate } from 'node:fs/promises';
import path from 'node:path';

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

/**
 * Local-only telemetry: logs and SDK metrics go to a rotating log file (and
 * optionally the console). Nothing is sent to Proton or anywhere else.
 */
export function initTelemetry(config: Config) {
    mkdirSync(config.logDir, { recursive: true, mode: 0o700 });
    // The copied handler creates the log with the umask's mode; create it private first.
    closeSync(openSync(path.join(config.logDir, LOG_FILE_NAME), 'a', 0o600));
    const fileHandler = new FileLogHandler(config.logDir);
    const logHandlers: LogHandler[] = [printableLog(cancellationIsNotAnError(fileHandler))];
    const metricHandlers: MetricHandler<MetricEvent>[] = [fileHandler];
    if (config.enableConsoleLog) {
        logHandlers.push(printableLog(cancellationIsNotAnError(new ConsoleLogHandler(new ColoredLogFormatter()))));
    }

    const telemetry = new Telemetry({
        logFilter: new LogFilter({ globalLevel: config.logLevel }),
        logHandlers,
        metricHandlers,
    });

    return {
        telemetry,
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
 * Messages and errors can hold remote names: their control characters are
 * escaped, so one cannot start a forged line. The formatter's own line breaks
 * (before the error and its stack) stay.
 */
export function printableLog(handler: LogHandler): LogHandler {
    return {
        log(record: LogRecord) {
            handler.log({ ...record, message: printable(record.message), error: printableError(record.error) });
        },
    };
}

function printableError(error: unknown): unknown {
    if (error === undefined) {
        return undefined;
    }
    if (!(error instanceof Error)) {
        return printable(String(error));
    }
    const message = printable(error.message);
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
                handler.log({ ...record, level: LogLevel.INFO, message: `${record.message} (stopped on purpose)` });
                return;
            }
            handler.log(record);
        },
    };
}

function isAbort(error: unknown): boolean {
    // The SDK's AbortError and DOM aborts from an AbortSignal share this name.
    return error instanceof Error && error.name === 'AbortError';
}
