// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Autostart, desktopExecArgument, runningProgram, XDG_AUTOSTART_NAME } from '../src/sync/autostart';
import { silentLogger, tempDir } from './helpers';

describe('Autostart', () => {
    it('enables and disables the systemd user unit when systemd runs the session', async () => {
        const runtimeDir = await tempDir();
        await mkdir(path.join(runtimeDir, 'systemd'));
        await Bun.write(path.join(runtimeDir, 'systemd', 'private'), '');
        const commands: string[][] = [];
        let enabled = false;
        const autostart = new Autostart({
            configDir: path.join(await tempDir(), 'kation'),
            runtimeDir,
            logger: silentLogger,
            run: async (command) => {
                commands.push(command);
                if (command[2] === 'is-enabled') {
                    return { exitCode: enabled ? 0 : 1, stderr: '' };
                }
                enabled = command[2] === 'enable';
                return { exitCode: 0, stderr: '' };
            },
        });
        expect(autostart.hasSystemd()).toBe(true);
        await autostart.set(true);
        await autostart.set(true); // already enabled: no reload of systemd
        await autostart.set(false);
        expect(commands).toEqual([
            ['systemctl', '--user', 'is-enabled', '--quiet', 'kationd.service'],
            ['systemctl', '--user', 'enable', 'kationd.service'],
            ['systemctl', '--user', 'is-enabled', '--quiet', 'kationd.service'],
            ['systemctl', '--user', 'is-enabled', '--quiet', 'kationd.service'],
            ['systemctl', '--user', 'disable', 'kationd.service'],
        ]);
    });

    it('does not fail when systemctl does', async () => {
        const runtimeDir = await tempDir();
        await mkdir(path.join(runtimeDir, 'systemd'));
        await Bun.write(path.join(runtimeDir, 'systemd', 'private'), '');
        const autostart = new Autostart({
            configDir: path.join(await tempDir(), 'kation'),
            runtimeDir,
            logger: silentLogger,
            run: async () => ({ exitCode: 1, stderr: 'Unit file kationd.service does not exist.' }),
        });
        await autostart.set(true);
    });

    it('uses an XDG autostart entry without systemd', async () => {
        const configHome = await tempDir();
        const autostart = new Autostart({
            configDir: path.join(configHome, 'kation'),
            runtimeDir: undefined,
            logger: silentLogger,
            program: '/usr/bin/kationd',
        });
        expect(autostart.hasSystemd()).toBe(false);
        const entry = path.join(configHome, 'autostart', XDG_AUTOSTART_NAME);
        await autostart.set(true);
        expect(await readFile(entry, 'utf8')).toContain('\nExec=/usr/bin/kationd serve\n');
        await autostart.set(false);
        await expect(stat(entry)).rejects.toThrow();
    });

    it('rewrites an entry written by an older version, which relied on PATH', async () => {
        const configHome = await tempDir();
        const entry = path.join(configHome, 'autostart', XDG_AUTOSTART_NAME);
        await mkdir(path.dirname(entry));
        await writeFile(entry, '[Desktop Entry]\nType=Application\nExec=kationd serve\n');
        const autostart = new Autostart({
            configDir: path.join(configHome, 'kation'),
            logger: silentLogger,
            program: '/opt/My Apps/kationd',
        });
        await autostart.set(true);
        const content = await readFile(entry, 'utf8');
        expect(content).toContain('\nExec="/opt/My Apps/kationd" serve\n');
        expect(content).not.toContain('Exec=kationd');
    });

    it('quotes program paths as the Desktop Entry specification requires', () => {
        expect(desktopExecArgument('/usr/bin/kationd')).toBe('/usr/bin/kationd');
        expect(desktopExecArgument('/opt/My Apps/kationd')).toBe('"/opt/My Apps/kationd"');
        // Quoting escapes " ` $ \ with a backslash; the value's own escaping then doubles every backslash.
        expect(desktopExecArgument('/opt/a$b"c`d\\e/kationd')).toBe('"/opt/a\\\\$b\\\\"c\\\\`d\\\\\\\\e/kationd"');
        expect(desktopExecArgument('/opt/100%/kationd')).toBe('/opt/100%%/kationd');
    });

    it('names the running program only when it is the compiled kationd', () => {
        // Under bun test, the running program is Bun itself.
        expect(runningProgram()).toBe('kationd');
        expect(runningProgram('/$bunfs/root/kationd', '/usr/bin/kationd')).toBe('/usr/bin/kationd');
        // Replaced by an upgrade while running.
        expect(runningProgram('/$bunfs/root/kationd', '/usr/bin/kationd (deleted)')).toBe('/usr/bin/kationd');
        expect(runningProgram('/home/u/kation/daemon/src/main.ts', '/home/u/.bun/bin/bun')).toBe('kationd');
    });
});
