// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Starts kationd with the graphical session while folder sync is on.
 *
 * With systemd: enables kationd.service for the user (it is bound to
 * graphical-session.target, so it also stops at logout). Without systemd: an
 * XDG autostart entry, and kationd exits when the session bus goes away.
 */
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '@protontech/drive-sdk';

export const SYSTEMD_UNIT = 'kationd.service';
export const XDG_AUTOSTART_NAME = 'com.hleroy.Kation.kationd.desktop';

export type CommandRunner = (command: string[]) => Promise<{ exitCode: number; stderr: string }>;

export type AutostartOptions = {
    configDir: string;
    /** XDG_RUNTIME_DIR, used to detect a systemd user manager. */
    runtimeDir?: string;
    logger: Logger;
    run?: CommandRunner;
    /** The program the XDG entry starts (default: runningProgram()). */
    program?: string;
};

/**
 * The absolute path of the running kationd when it is the compiled program, so
 * the autostart entry does not depend on PATH; "kationd" otherwise (run by Bun
 * from the sources, where process.execPath is Bun).
 */
export function runningProgram(): string {
    return Bun.main.startsWith('/$bunfs/') ? process.execPath : 'kationd';
}

/** One argument of a desktop entry's Exec key, quoted and escaped as the Desktop Entry specification says. */
export function desktopExecArgument(argument: string): string {
    const quoted = /[ \t\n"'\\<>~|&;$*?#()`]/.test(argument) ? `"${argument.replace(/["`$\\]/g, (char) => `\\${char}`)}"` : argument;
    // "%" starts a field code. Then the escaping of every string value, which readers undo first.
    return quoted.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

export const runCommand: CommandRunner = async (command) => {
    const proc = Bun.spawn(command, { stdout: 'ignore', stderr: 'pipe' });
    const stderr = await new Response(proc.stderr).text();
    return { exitCode: await proc.exited, stderr: stderr.trim() };
};

export class Autostart {
    private readonly run: CommandRunner;

    constructor(private readonly options: AutostartOptions) {
        this.run = options.run ?? runCommand;
    }

    /** Whether a systemd user manager is running for this session. */
    hasSystemd(): boolean {
        const runtimeDir = this.options.runtimeDir;
        return !!runtimeDir && existsSync(path.join(runtimeDir, 'systemd', 'private'));
    }

    async set(enabled: boolean): Promise<void> {
        const { logger } = this.options;
        if (this.hasSystemd()) {
            // `enable`/`disable` make systemd reload its configuration, so only call them on a change
            // (kationd applies this setting at every start).
            const current = await this.run(['systemctl', '--user', 'is-enabled', '--quiet', SYSTEMD_UNIT]);
            if ((current.exitCode === 0) === enabled) {
                logger.debug(`Start at login already ${enabled ? 'enabled' : 'disabled'} (${SYSTEMD_UNIT})`);
                return;
            }
            const result = await this.run(['systemctl', '--user', enabled ? 'enable' : 'disable', SYSTEMD_UNIT]);
            if (result.exitCode !== 0) {
                logger.warn(`Could not ${enabled ? 'enable' : 'disable'} start at login (${SYSTEMD_UNIT}): ${result.stderr}`);
                return;
            }
            logger.info(`Start at login ${enabled ? 'enabled' : 'disabled'} (${SYSTEMD_UNIT})`);
            return;
        }
        const entry = path.join(path.dirname(this.options.configDir), 'autostart', XDG_AUTOSTART_NAME);
        if (enabled) {
            await mkdir(path.dirname(entry), { recursive: true });
            await writeFile(
                entry,
                [
                    '[Desktop Entry]',
                    'Type=Application',
                    'Name=Kation background service',
                    'Comment=Keeps your Proton Drive folder in sync (unofficial client)',
                    `Exec=${desktopExecArgument(this.options.program ?? runningProgram())} serve`,
                    'NoDisplay=true',
                    'X-KDE-autostart-phase=2',
                    '',
                ].join('\n'),
            );
        } else {
            await rm(entry, { force: true });
        }
        logger.info(`Start at login ${enabled ? 'enabled' : 'disabled'} (${entry})`);
    }
}
