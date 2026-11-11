// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * kationd entry point.
 *
 * `serve` runs the D-Bus service the KDE components use. The other commands
 * are for scripts and troubleshooting; they talk to that service.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { NodeType } from '@protontech/drive-sdk';

import { getVersions, THIRD_PARTY_NOTICE } from './appInfo';
import { openBrowserUrl } from './browser';
import { connectService, entryToRow, type Row, type ServiceClient, unwrap } from './client';
import { getConfig } from './config';
import { type Drive, openDrive } from './drive';
import { listFolder, nodeName, resolvePath } from './drivePaths';
import { serve } from './service/serve';
import { forgetSyncedFiles } from './sync/controller';
import { SettingsStore } from './sync/settings';
import { SyncState } from './sync/state';

const USAGE = `Usage: kationd <command> [options]

Commands:
  serve          Run the background service for the KDE components
  login          Sign in to Proton Drive in your browser
  logout         Sign out; delete the caches, sync state, log and partial
                 downloads (synced files and settings stay)
  status         Show whether you are signed in
  ls [PATH]      List a folder in "My files" (default: /)
  sync [ACTION]  Folder sync: status (default), on, off, pause, resume, now,
                 excluded, exclude FOLDER, include FOLDER,
                 limits [UPLOAD DOWNLOAD] (speed limits in KiB/s, 0: none)
  activity       What sync did recently
  link ITEM      Show the public link of a file or folder; with --create,
                 make one if needed (anyone with the link can view it)
  weburl ITEM    Show the address of a file or folder in the Proton web app
                 ITEM: a path in "My files" (/Docs/a.pdf), a local path in
                 the synced folder, or a protondrive:/ URL
  version        Show version information

Commands go through the running Kation service when it is available.

Options:
  -j, --json        Machine-readable output
  -v, --verbose     Log to the console as well as the log file
  -h, --help        Show this help
      --create      With link: create the link if there is none
      --fake-drive  With serve: use an in-memory drive (tests only)

${THIRD_PARTY_NOTICE}`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            json: { type: 'boolean', short: 'j', default: false },
            verbose: { type: 'boolean', short: 'v', default: false },
            help: { type: 'boolean', short: 'h', default: false },
            'fake-drive': { type: 'boolean', default: false },
            create: { type: 'boolean', default: false },
        },
    });
    const [command, ...args] = positionals;
    if (values.help || !command || command === 'help') {
        console.log(USAGE);
        return command || values.help ? 0 : 2;
    }

    const { appVersion, sdkVersion } = await getVersions();
    if (command === 'version') {
        print(values.json, { appVersion, sdkVersion }, `kationd ${appVersion}\nProton Drive SDK ${sdkVersion}`);
        return 0;
    }

    if (command === 'serve') {
        const config = getConfig({ appVersion, sdkVersion, enableConsoleLog: values.verbose });
        await serve({ config, fakeDrive: values['fake-drive'] });
        return 0;
    }

    if (!COMMANDS.has(command)) {
        throw new UsageError(`Unknown command: ${command}`);
    }

    // Use the running service when there is one: never two processes on one session.
    const service = await connectService();
    if (service) {
        try {
            await runThroughService(service, command, args, values.json, values.create);
        } finally {
            service.close();
        }
        return 0;
    }
    if (!LOCAL_COMMANDS[command]) {
        throw new UsageError(`The Kation service is not available; "${command}" needs it (is Kation installed?)`);
    }

    const config = getConfig({ appVersion, sdkVersion, enableConsoleLog: values.verbose });
    const drive = await openDrive(config);
    try {
        await LOCAL_COMMANDS[command]!(drive, args, values.json);
    } finally {
        await drive.dispose();
    }
    return 0;
}

const COMMANDS = new Set(['login', 'logout', 'status', 'ls', 'sync', 'activity', 'link', 'weburl']);

const ACTIVITY_LABELS: Record<string, string> = {
    uploaded: 'Uploaded',
    downloaded: 'Downloaded',
    trashedRemote: 'Moved to the Proton Drive trash',
    trashedLocal: 'Moved to the desktop Trash',
    conflict: 'Conflict, kept both',
    error: 'Could not sync',
};

/** A path in "My files", a local path or a URL, as the URL the service expects. */
export function itemUrl(item: string, cwd = process.cwd()): string {
    if (/^(protondrive|file):/.test(item)) {
        return item;
    }
    const local = path.resolve(cwd, item);
    if (!item.startsWith('/') || existsSync(local)) {
        return pathToFileURL(local).href;
    }
    return `protondrive:${item.split('/').map(encodeURIComponent).join('/')}`;
}

function printSignInInstructions(json: boolean, signInUrl: string): void {
    openBrowserUrl(signInUrl);
    if (json) {
        console.log(JSON.stringify({ signInUrl, notice: THIRD_PARTY_NOTICE }));
    } else {
        console.log(THIRD_PARTY_NOTICE);
        console.log('Sign in with your browser. Keep this terminal open until it completes.');
        console.log('If no browser opened, open this URL (it can be on another device):');
        console.log(signInUrl);
    }
}

function printRows(rows: Row[], json: boolean): void {
    rows.sort((a, b) => Number(b.type === 'folder') - Number(a.type === 'folder') || a.name.localeCompare(b.name));
    if (json) {
        console.log(JSON.stringify(rows));
        return;
    }
    for (const row of rows) {
        const size = row.type === 'folder' ? '-' : String(row.size ?? '?');
        console.log(`${row.modified.slice(0, 16).replace('T', ' ')}  ${size.padStart(12)}  ${row.name}${row.type === 'folder' ? '/' : ''}`);
    }
}

async function runThroughService(service: ServiceClient, command: string, args: string[], json: boolean, create = false): Promise<void> {
    const itemArg = () => {
        if (args.length !== 1) {
            throw new UsageError(`Usage: kationd ${command}${command === 'link' ? ' [--create]' : ''} ITEM`);
        }
        return itemUrl(args[0]!);
    };
    switch (command) {
        case 'activity': {
            const activity = ((await service.call('GetRecentActivity')) as unknown[]).map(unwrap);
            const lines = activity.map((item) => {
                const time = new Date(Number(item.time) * 1000).toLocaleString();
                const detail = item.detail ? ` (${item.detail})` : '';
                return `${time}  ${ACTIVITY_LABELS[String(item.kind)] ?? item.kind}: ${item.path}${detail}`;
            });
            print(json, activity, lines.length > 0 ? lines.join('\n') : 'No sync activity since the service started.');
            return;
        }
        case 'link': {
            const link = String(await service.call('GetShareLink', itemArg(), create));
            print(json, { link }, link || 'No public link. Run again with --create to make one (anyone with the link can view it).');
            return;
        }
        case 'weburl': {
            const webUrl = String(await service.call('GetWebUrl', itemArg()));
            print(json, { webUrl }, webUrl);
            return;
        }
        case 'status': {
            const status = unwrap(await service.call('GetStatus'));
            const text = status.loggedIn ? `Signed in as ${status.email}` : 'Not signed in.';
            print(json, status, status.problem ? `${text}\n${status.problem}` : text);
            return;
        }
        case 'login': {
            const finished = new Promise<[boolean, string]>((resolve) =>
                service.on('LoginFinished', (ok: boolean, message: string) => resolve([ok, message])),
            );
            const signInUrl = String(await service.call('StartLogin'));
            printSignInInstructions(json, signInUrl);
            const [ok, message] = await finished;
            if (!ok) {
                throw new Error(message || 'Sign-in failed');
            }
            print(json, { loggedIn: true }, 'Signed in.');
            return;
        }
        case 'logout':
            await service.call('Logout');
            print(json, { loggedIn: false }, 'Signed out.');
            return;
        case 'ls': {
            if (args.length > 1) {
                throw new UsageError('ls takes at most one path');
            }
            const path = args[0] ? (args[0].startsWith('/') ? args[0] : `/${args[0]}`) : '/';
            const entries = (await service.call('List', path)) as unknown[];
            printRows(
                entries.map((entry) => entryToRow(unwrap(entry))),
                json,
            );
            return;
        }
        case 'sync': {
            const action = args[0] ?? 'status';
            const folderArg = () => {
                const folder = args[1];
                if (!folder || args.length > 2) {
                    throw new UsageError(`Usage: kationd sync ${action} FOLDER  (a folder in "My files", e.g. /Videos)`);
                }
                return folder.startsWith('/') ? folder.replace(/\/+$/, '') || '/' : `/${folder.replace(/\/+$/, '')}`;
            };
            const currentExcluded = async () => (unwrap(await service.call('GetSyncStatus')).excluded as string[]) ?? [];
            if (action === 'excluded') {
                const excluded = await currentExcluded();
                print(json, excluded, excluded.length > 0 ? excluded.join('\n') : 'No folders are excluded.');
                return;
            }
            const actions: Record<string, () => Promise<unknown>> = {
                status: async () => undefined,
                on: () => service.call('SetSyncEnabled', true),
                off: () => service.call('SetSyncEnabled', false),
                pause: () => service.call('SetSyncPaused', true),
                resume: () => service.call('SetSyncPaused', false),
                now: () => service.call('SyncNow'),
                exclude: async () => {
                    const folder = folderArg();
                    await service.call('SetExcludedFolders', [...new Set([...(await currentExcluded()), folder])]);
                    if (!json) {
                        console.log(`${folder} is no longer synced. Files already on this computer stay; delete them to free space.`);
                    }
                },
                limits: async () => {
                    if (args.length === 1) {
                        return;
                    }
                    const [upload, download] = args.slice(1).map(Number);
                    if (args.length !== 3 || !Number.isInteger(upload) || !Number.isInteger(download)) {
                        throw new UsageError('Usage: kationd sync limits UPLOAD DOWNLOAD  (KiB/s, 0 for no limit)');
                    }
                    await service.call('SetBandwidthLimits', upload, download);
                },
                include: async () => {
                    const folder = folderArg();
                    const excluded = await currentExcluded();
                    if (!excluded.includes(folder)) {
                        throw new UsageError(`${folder} is not excluded (see "kationd sync excluded")`);
                    }
                    await service.call(
                        'SetExcludedFolders',
                        excluded.filter((item) => item !== folder),
                    );
                    if (!json) {
                        console.log(`${folder} is synced again.`);
                    }
                },
            };
            const run = actions[action];
            if (!run) {
                throw new UsageError(
                    'Usage: kationd sync [status|on|off|pause|resume|now|excluded|exclude FOLDER|include FOLDER|limits [UPLOAD DOWNLOAD]]',
                );
            }
            await run();
            const status = unwrap(await service.call('GetSyncStatus'));
            const detail = status.message && status.message !== 'Paused' ? ` (${status.message})` : '';
            const limit = (value: unknown) => (Number(value) > 0 ? `${value} KiB/s` : 'no limit');
            const limits =
                action === 'limits' ? `\nSpeed limits: upload ${limit(status.uploadLimit)}, download ${limit(status.downloadLimit)}` : '';
            print(json, status, `Sync ${status.enabled ? status.state : 'off'}${detail}: ${status.folder}${limits}`);
            return;
        }
    }
}

type Handler = (drive: Drive, args: string[], json: boolean) => Promise<void>;

/** Fallback when no service is installed (e.g. running from the build folder). */
const LOCAL_COMMANDS: Record<string, Handler> = {
    async login(drive, _args, json) {
        if (drive.auth.isLoggedIn()) {
            print(json, { loggedIn: true }, 'Already signed in. Run "kationd logout" first to switch accounts.');
            return;
        }
        await drive.auth.authViaWeb((signInUrl) => printSignInInstructions(json, signInUrl));
        print(json, { loggedIn: true }, 'Signed in.');
    },

    async logout(drive, _args, json) {
        await drive.signOut();
        // What the service deletes on sign-out (afterLogout in serve.ts).
        const stateFile = path.join(drive.config.appDir, 'sync.sqlite');
        if (existsSync(stateFile)) {
            const state = new SyncState(stateFile);
            try {
                await forgetSyncedFiles(state, new SettingsStore(drive.config.configDir, drive.config.homeDir).load());
            } finally {
                state.close();
            }
        }
        await drive.clearLocalData();
        print(json, { loggedIn: false }, 'Signed out.');
    },

    async status(drive, _args, json) {
        if (!drive.auth.isLoggedIn()) {
            print(json, { loggedIn: false }, 'Not signed in.');
            return;
        }
        const address = await drive.addresses.getOwnPrimaryAddress();
        print(json, { loggedIn: true, email: address.email }, `Signed in as ${address.email}`);
    },

    async ls(drive, args, json) {
        requireLogin(drive);
        if (args.length > 1) {
            throw new UsageError('ls takes at most one path');
        }
        const folder = await resolvePath(drive.sdk, args[0] ?? '/');
        if (folder.type !== NodeType.Folder) {
            throw new UsageError(`Not a folder: ${args[0]}`);
        }
        printRows(
            (await listFolder(drive.sdk, folder)).map((node) => ({
                name: nodeName(node),
                type: node.type,
                size: node.activeRevision?.claimedSize ?? null,
                modified: (node.activeRevision?.claimedModificationTime ?? node.modificationTime).toISOString(),
            })),
            json,
        );
    },
};

function requireLogin(drive: Drive): void {
    if (!drive.auth.isLoggedIn()) {
        throw new UsageError('Not signed in. Run "kationd login" first.');
    }
}

function print(json: boolean, data: unknown, text: string): void {
    console.log(json ? JSON.stringify(data) : text);
}

try {
    process.exit(await main(process.argv.slice(2)));
} catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`kationd: ${message}`);
    if (error instanceof UsageError) {
        console.error('Run "kationd --help" for usage.');
        process.exit(2);
    }
    process.exit(1);
}
