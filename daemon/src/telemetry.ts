// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { mkdirSync } from 'node:fs';

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
import { FileLogHandler } from './proton/telemetry/fileHandler';
import { ColoredLogFormatter } from './proton/telemetry/logFormatters';

/**
 * Local-only telemetry: logs and SDK metrics go to a rotating log file (and
 * optionally the console). Nothing is sent to Proton or anywhere else.
 */
export function initTelemetry(config: Config) {
    mkdirSync(config.logDir, { recursive: true, mode: 0o700 });
    const fileHandler = new FileLogHandler(config.logDir);
    const logHandlers: LogHandler[] = [cancellationIsNotAnError(fileHandler)];
    const metricHandlers: MetricHandler<MetricEvent>[] = [fileHandler];
    if (config.enableConsoleLog) {
        logHandlers.push(cancellationIsNotAnError(new ConsoleLogHandler(new ColoredLogFormatter())));
    }

    const telemetry = new Telemetry({
        logFilter: new LogFilter({ globalLevel: config.logLevel }),
        logHandlers,
        metricHandlers,
    });

    return {
        telemetry,
        flush: () => fileHandler.flush(),
    };
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
