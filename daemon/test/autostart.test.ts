// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { Autostart, XDG_AUTOSTART_NAME } from '../src/sync/autostart';
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
        const autostart = new Autostart({ configDir: path.join(configHome, 'kation'), runtimeDir: undefined, logger: silentLogger });
        expect(autostart.hasSystemd()).toBe(false);
        const entry = path.join(configHome, 'autostart', XDG_AUTOSTART_NAME);
        await autostart.set(true);
        expect(await readFile(entry, 'utf8')).toContain('Exec=kationd serve');
        await autostart.set(false);
        await expect(stat(entry)).rejects.toThrow();
    });
});
