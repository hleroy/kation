// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Serves the com.hleroy.Kation.Drive1 interface on the session bus.
 *
 * The interface XML in dbus/ is the contract: it is served verbatim for
 * introspection, and incoming calls are checked against its signatures.
 * Low-level message handling (instead of dbus-next's Interface class) gives
 * access to each caller's bus name, so transfers stop when their caller
 * disconnects (for example when a KIO worker is killed after a cancel).
 */

import type { Logger } from '@protontech/drive-sdk';
import dbus from 'dbus-next';

import interfaceXmlText from '../../../dbus/com.hleroy.Kation.Drive1.xml' with { type: 'text' };
import { APP_ID } from '../appInfo';
import type { SyncActivityEntry, SyncController, SyncControllerStatus } from '../sync/controller';
import type { DriveService } from './driveService';
import type { Entry } from './entry';
import { KationError, toKationError } from './errors';
import type { Session, Status } from './session';

const { Message, MessageType, Variant } = dbus;

// Bun's types describe .xml imports as DOM documents; with type 'text' it is the file content.
export const interfaceXml = interfaceXmlText as unknown as string;

/** dbus-next's typings declare the first argument of newError as a string; it is the call message. */
function errorReply(msg: dbus.Message, name: string, text: string): dbus.Message {
    return (Message.newError as unknown as (m: dbus.Message, n: string, t: string) => dbus.Message)(msg, name, text);
}

export const BUS_NAME = APP_ID;
export const OBJECT_PATH = '/com/hleroy/Kation';
export const INTERFACE_NAME = 'com.hleroy.Kation.Drive1';
export const URL_SCHEME = 'protondrive';

const PROGRESS_INTERVAL_MS = 250;

type MethodSignature = { in: string; out: string };
type CallContext = { sender: string };
// biome-ignore lint/suspicious/noExplicitAny: arguments arrive as D-Bus values, already checked against the signature.
type Handler = (args: any[], context: CallContext) => Promise<unknown[]>;

/** Reads method signatures from the interface XML. */
export function parseMethodSignatures(xml: string): Map<string, MethodSignature> {
    const methods = new Map<string, MethodSignature>();
    const methodPattern = /<method name="(\w+)"\s*(?:\/>|>([\s\S]*?)<\/method>)/g;
    for (const [, name, body = ''] of xml.matchAll(methodPattern)) {
        const signature = { in: '', out: '' };
        for (const [, type, direction] of body.matchAll(/<arg name="\w+" type="([^"]+)" direction="(in|out)"\/>/g)) {
            signature[direction as 'in' | 'out'] += type;
        }
        methods.set(name!, signature);
    }
    return methods;
}

export function entryToDbus(entry: Entry): Record<string, dbus.Variant> {
    return {
        name: new Variant('s', entry.name),
        type: new Variant('s', entry.type),
        size: new Variant('x', entry.size),
        mtime: new Variant('x', entry.mtime),
        ctime: new Variant('x', entry.ctime),
        mimeType: new Variant('s', entry.mimeType),
    };
}

export function statusToDbus(status: Status): Record<string, dbus.Variant> {
    return {
        loggedIn: new Variant('b', status.loggedIn),
        email: new Variant('s', status.email),
        loginPending: new Variant('b', status.loginPending),
        signInUrl: new Variant('s', status.signInUrl),
        appVersion: new Variant('s', status.appVersion),
        sdkVersion: new Variant('s', status.sdkVersion),
        problem: new Variant('s', status.problem),
        problemCode: new Variant('s', status.problemCode),
        problemDetail: new Variant('s', status.problemDetail),
    };
}

export function syncStatusToDbus(status: SyncControllerStatus): Record<string, dbus.Variant> {
    return {
        enabled: new Variant('b', status.enabled),
        paused: new Variant('b', status.paused),
        folder: new Variant('s', status.folder),
        excluded: new Variant('as', status.excluded),
        state: new Variant('s', status.state),
        message: new Variant('s', status.message),
        reason: new Variant('s', status.reason),
        deletionLimit: new Variant('u', status.deletionLimit),
        current: new Variant('s', status.current),
        pending: new Variant('u', status.pending),
        lastSync: new Variant('x', status.lastSync),
        uploadLimit: new Variant('u', status.uploadLimit),
        downloadLimit: new Variant('u', status.downloadLimit),
    };
}

export function activityToDbus(activity: SyncActivityEntry): Record<string, dbus.Variant> {
    return {
        time: new Variant('x', activity.time),
        kind: new Variant('s', activity.kind),
        path: new Variant('s', activity.path),
        localPath: new Variant('s', activity.localPath),
        detail: new Variant('s', activity.detail),
    };
}

type Transfer = { sender: string; abort: AbortController };

export class DriveDbusServer {
    private readonly signatures = parseMethodSignatures(interfaceXml);
    private readonly handlers: Record<string, Handler>;
    private readonly transfers = new Map<string, Transfer>();
    private readonly messageHandler = (msg: dbus.Message) => this.onMessage(msg);

    constructor(
        private readonly bus: dbus.MessageBus,
        private readonly session: Session,
        private readonly drive: DriveService,
        private readonly sync: SyncController,
        private readonly logger: Logger,
    ) {
        // biome-ignore lint/suspicious/noExplicitAny: wraps handlers of any signature; see Handler.
        const loggedIn = <T>(fn: (...args: any[]) => Promise<T>) => {
            // biome-ignore lint/suspicious/noExplicitAny: see Handler.
            return async (args: any[], context: CallContext) => {
                this.session.requireLogin();
                return [await fn(...args, context)];
            };
        };
        const noResult = (value: unknown) => (value === undefined ? [] : [value]);

        this.handlers = {
            GetStatus: async () => [statusToDbus(this.session.status())],
            StartLogin: async () => [await this.session.startLogin()],
            CancelLogin: async () => noResult(this.session.cancelLogin()),
            Logout: async () => noResult(await this.session.logout()),
            Stat: loggedIn(async (path: string) => entryToDbus(await this.drive.stat(path))),
            List: loggedIn(async (path: string) => (await this.drive.list(path)).map(entryToDbus)),
            CreateFolder: async ([path]) => {
                this.session.requireLogin();
                return noResult(await this.drive.createFolder(path));
            },
            Move: async ([source, destination, overwrite]) => {
                this.session.requireLogin();
                return noResult(await this.drive.move(source, destination, overwrite));
            },
            Trash: async ([path]) => {
                this.session.requireLogin();
                return noResult(await this.drive.trash(path));
            },
            Download: loggedIn(async (path: string, localPath: string, transferId: string, context: CallContext) =>
                this.runTransfer(transferId, context, (options) => this.drive.download(path, localPath, options)),
            ),
            Upload: loggedIn(async (localPath: string, path: string, overwrite: boolean, transferId: string, context: CallContext) =>
                this.runTransfer(transferId, context, (options) => this.drive.upload(localPath, path, overwrite, options)),
            ),
            GetSyncStatus: async () => [syncStatusToDbus(this.sync.status())],
            SetSyncEnabled: async ([enabled], { sender }) => {
                this.logger.info(`SetSyncEnabled(${enabled}) from ${sender}`);
                return noResult(await this.sync.setEnabled(enabled));
            },
            SetSyncPaused: async ([paused], { sender }) => {
                this.logger.info(`SetSyncPaused(${paused}) from ${sender}`);
                return noResult(await this.sync.setPaused(paused));
            },
            SetSyncFolder: async ([folder]) => noResult(await this.sync.setFolder(folder)),
            SetExcludedFolders: async ([paths]) => noResult(await this.sync.setExcluded(paths)),
            SyncNow: async () => noResult(this.sync.syncNow()),
            SetBandwidthLimits: async ([upload, download]) => noResult(this.sync.setLimits(upload, download)),
            GetRecentActivity: async () => [this.sync.recentActivity().map(activityToDbus)],
            GetItemStates: async ([paths]) => {
                const states = await this.sync.itemStates(paths);
                return [Object.fromEntries([...states].map(([item, state]) => [item, new Variant('s', state)]))];
            },
            GetShareLink: async ([url, create], { sender }) => {
                this.session.requireLogin();
                const drivePath = this.drivePathOfUrl(url);
                if (create) {
                    this.logger.info(`GetShareLink(create) from ${sender}`);
                }
                return [await this.drive.shareLink(drivePath, create)];
            },
            GetWebUrl: loggedIn(async (url: string) => this.drive.webUrl(this.drivePathOfUrl(url))),
            CancelTransfer: async ([transferId]) => {
                const transfer = this.transfers.get(transferId);
                if (transfer) {
                    transfer.abort.abort();
                }
                return [];
            },
        };

        for (const name of this.signatures.keys()) {
            if (!this.handlers[name]) {
                throw new Error(`No handler for D-Bus method ${name}`);
            }
        }
    }

    /** Claims the bus name and starts serving. Fails if another kationd is running. */
    async start(): Promise<void> {
        this.bus.addMethodHandler(this.messageHandler);
        const reply = await this.bus.requestName(BUS_NAME, dbus.NameFlag.DO_NOT_QUEUE);
        if (reply !== dbus.RequestNameReply.PRIMARY_OWNER && reply !== dbus.RequestNameReply.ALREADY_OWNER) {
            this.bus.removeMethodHandler(this.messageHandler);
            throw new Error(`Another kationd already owns ${BUS_NAME}`);
        }
        await this.watchDisconnections();
        this.logger.info(`Serving ${INTERFACE_NAME} on the session bus as ${BUS_NAME}`);
    }

    /** Stops serving. Pass busClosed when the connection is gone: calls on it would never return. */
    async stop(busClosed = false): Promise<void> {
        for (const transfer of this.transfers.values()) {
            transfer.abort.abort();
        }
        this.bus.removeMethodHandler(this.messageHandler);
        if (!busClosed) {
            await Promise.race([this.bus.releaseName(BUS_NAME).catch(() => {}), Bun.sleep(1000)]);
        }
    }

    emitStatusChanged(status: Status): void {
        this.emit('StatusChanged', 'a{sv}', [statusToDbus(status)]);
    }

    emitSyncStatusChanged(status: SyncControllerStatus): void {
        this.emit('SyncStatusChanged', 'a{sv}', [syncStatusToDbus(status)]);
    }

    emitSyncActivity(activity: SyncActivityEntry): void {
        this.emit('SyncActivity', 'a{sv}', [activityToDbus(activity)]);
    }

    emitItemStatesChanged(localPaths: string[]): void {
        this.emit('ItemStatesChanged', 'as', [localPaths]);
    }

    emitLoginFinished(success: boolean, message: string): void {
        this.emit('LoginFinished', 'bs', [success, message]);
    }

    /** Asks KIO clients (Dolphin, file dialogs) to reload these folders. */
    notifyFolderChanged(paths: string[]): void {
        for (const path of paths) {
            this.bus.send(Message.newSignal('/', 'org.kde.KDirNotify', 'FilesAdded', 's', [`${URL_SCHEME}:${path}`]));
        }
    }

    /** protondrive:/path, or a file:// URL inside the sync folder, to a path in "My files". */
    private drivePathOfUrl(url: string): string {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new KationError('InvalidArgument', `Not a URL: ${url}`);
        }
        if (parsed.protocol === `${URL_SCHEME}:`) {
            // protondrive:/a/b and protondrive:///a/b
            const drivePath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '/').replace(/\/+$/, '');
            return drivePath || '/';
        }
        if (parsed.protocol === 'file:') {
            const drivePath = this.sync.status().enabled ? this.sync.drivePathOf(decodeURIComponent(parsed.pathname)) : undefined;
            if (!drivePath) {
                throw new KationError('NotFound', 'This item is not in your synced Proton Drive folder');
            }
            return drivePath;
        }
        throw new KationError('InvalidArgument', `Unsupported URL: ${url}`);
    }

    private emit(name: string, signature: string, body: unknown[]): void {
        this.bus.send(Message.newSignal(OBJECT_PATH, INTERFACE_NAME, name, signature, body));
    }

    private async runTransfer(
        transferId: string,
        context: CallContext,
        run: (options: { onProgress: (bytes: number) => void; signal: AbortSignal }) => Promise<Entry>,
    ): Promise<Record<string, dbus.Variant>> {
        if (!transferId || this.transfers.has(transferId)) {
            throw new KationError('InvalidArgument', 'Transfer ID must be unique and non-empty');
        }
        const transfer = { sender: context.sender, abort: new AbortController() };
        this.transfers.set(transferId, transfer);

        let lastEmit = 0;
        const onProgress = (bytes: number) => {
            const now = Date.now();
            if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
                lastEmit = now;
                this.emit('TransferProgress', 'st', [transferId, bytes]);
            }
        };
        try {
            return entryToDbus(await run({ onProgress, signal: transfer.abort.signal }));
        } finally {
            this.transfers.delete(transferId);
        }
    }

    private async watchDisconnections(): Promise<void> {
        const busObject = await this.bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
        busObject.getInterface('org.freedesktop.DBus').on('NameOwnerChanged', (name: string, _old: string, owner: string) => {
            if (owner !== '' || !name.startsWith(':')) {
                return;
            }
            for (const [id, transfer] of this.transfers) {
                if (transfer.sender === name) {
                    this.logger.info(`Caller ${name} disconnected, cancelling transfer ${id}`);
                    transfer.abort.abort();
                }
            }
        });
    }

    /** Returns true when the message is for us; the reply is sent asynchronously. */
    private onMessage(msg: dbus.Message): boolean {
        if (msg.type !== MessageType.METHOD_CALL) {
            return false;
        }
        if (msg.interface === 'org.freedesktop.DBus.Introspectable' && msg.member === 'Introspect') {
            const xml = this.introspect(msg.path);
            if (xml === undefined) {
                return false;
            }
            this.bus.send(Message.newMethodReturn(msg, 's', [xml]));
            return true;
        }
        if (msg.path !== OBJECT_PATH) {
            return false;
        }
        if (msg.interface === 'org.freedesktop.DBus.Peer' && msg.member === 'Ping') {
            this.bus.send(Message.newMethodReturn(msg));
            return true;
        }
        if (msg.interface && msg.interface !== INTERFACE_NAME) {
            return false;
        }

        const signature = this.signatures.get(msg.member);
        const handler = this.handlers[msg.member];
        if (!signature || !handler) {
            this.bus.send(errorReply(msg, 'org.freedesktop.DBus.Error.UnknownMethod', `No method ${msg.member}`));
            return true;
        }
        if ((msg.signature ?? '') !== signature.in) {
            this.bus.send(
                errorReply(
                    msg,
                    'org.freedesktop.DBus.Error.InvalidArgs',
                    `${msg.member} expects (${signature.in}), got (${msg.signature ?? ''})`,
                ),
            );
            return true;
        }

        handler(msg.body ?? [], { sender: msg.sender }).then(
            (result) => this.bus.send(Message.newMethodReturn(msg, signature.out, result)),
            (error: unknown) => {
                const kationError = toKationError(error);
                if (kationError.code === 'Failed') {
                    this.logger.error(`${msg.member} failed`, error);
                } else {
                    this.logger.debug(`${msg.member}: ${kationError.code}: ${kationError.message}`);
                }
                this.bus.send(errorReply(msg, kationError.dbusName, kationError.message));
            },
        );
        return true;
    }

    private introspect(path: string): string | undefined {
        if (path === OBJECT_PATH) {
            return interfaceXml;
        }
        // Parent nodes ("/", "/com", "/com/hleroy") so tools can walk to the object.
        const prefix = path === '/' ? '/' : `${path}/`;
        if (!OBJECT_PATH.startsWith(prefix)) {
            return undefined;
        }
        const child = OBJECT_PATH.slice(prefix.length).split('/')[0];
        return `<node><node name="${child}"/></node>`;
    }
}
