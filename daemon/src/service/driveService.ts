// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * File operations on "My files", addressed by path. This is what the D-Bus
 * methods call; it knows nothing about D-Bus itself.
 */
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, readdir, rename, stat, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';

import type { Logger, NodeEntity, NodeResult } from '@protontech/drive-sdk';

import { type Entry, isFolder, toEntry } from './entry';
import { KationError, toKationError } from './errors';
import { RateLimiter } from './rateLimiter';
import type { DriveSdk } from './sdk';
import { type DriveTree, joinPath, splitParent } from './tree';

export type TransferOptions = {
    onProgress?: (bytes: number) => void;
    signal?: AbortSignal;
    /**
     * Downloads only: keep the partial file when interrupted (as a hidden
     * file next to the destination) and continue from it next time. Used by
     * sync. A resumed download skips the SDK's block and manifest checks: it is
     * checked against the size and SHA-1 in the file's signed attributes instead.
     */
    resumable?: boolean;
    /**
     * Downloads only: runs just before the downloaded file replaces the
     * destination. Throwing keeps the destination as it is.
     */
    beforeReplace?: () => Promise<void>;
};

const RESUME_CHUNK_SIZE = 1024 * 1024;
/** Interruptions after which a partial download is worth keeping. */
const TRANSIENT_CODES = new Set(['Cancelled', 'Connection', 'RateLimited']);

const OCTET_STREAM = 'application/octet-stream';

// O_NOFOLLOW and O_EXCL: a link planted at a partial file's name is never written through.
const NEW_PART_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
// O_NONBLOCK: a FIFO swapped in for a partial file fails to open instead of blocking.
const APPEND_PART_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const READ_PART_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export class DriveService {
    /** Speed limits shared by all transfers (sync and online view), set from the settings. */
    readonly uploadLimiter = new RateLimiter();
    readonly downloadLimiter = new RateLimiter();

    constructor(
        private readonly sdk: DriveSdk,
        readonly tree: DriveTree,
        private readonly logger: Logger,
    ) {}

    async stat(drivePath: string): Promise<Entry> {
        const node = await this.tree.resolve(drivePath);
        return toEntry(node, drivePath === '/' ? '' : undefined);
    }

    async list(drivePath: string): Promise<Entry[]> {
        const folder = await this.tree.resolve(drivePath);
        return (await this.tree.list(folder)).map((node) => toEntry(node));
    }

    async createFolder(drivePath: string): Promise<void> {
        const { parent, name } = await this.resolveParent(drivePath);
        if (await this.tree.child(parent, name)) {
            throw new KationError('AlreadyExists', `Already exists: ${drivePath}`);
        }
        try {
            await this.sdk.createFolder(parent, name);
        } finally {
            this.tree.invalidate(parent.uid);
        }
    }

    async move(source: string, destination: string, overwrite: boolean): Promise<void> {
        const { parent: sourceParent, name: sourceName } = await this.resolveParent(source);
        const node = await this.tree.child(sourceParent, sourceName);
        if (!node) {
            throw new KationError('NotFound', `Not found: ${source}`);
        }
        const { parent: destParent, name: destName } = await this.resolveParent(destination);
        if (destParent.uid === sourceParent.uid && destName === sourceName) {
            return;
        }
        if (isFolder(node) && (await this.isInside(destParent, node))) {
            throw new KationError('InvalidArgument', 'A folder cannot be moved into itself');
        }

        const existing = await this.tree.child(destParent, destName);
        if (existing) {
            if (!overwrite) {
                throw new KationError('AlreadyExists', `Already exists: ${destination}`);
            }
            await this.trashNode(existing);
            this.tree.invalidate(destParent.uid);
        }

        try {
            if (destParent.uid === sourceParent.uid) {
                await this.sdk.renameNode(node, destName);
            } else if (destName === sourceName || !(await this.tree.child(destParent, sourceName))) {
                // Move first, then rename in the destination folder.
                await this.checkResults(this.sdk.moveNodes([node], destParent));
                if (destName !== sourceName) {
                    await this.sdk.renameNode(node.uid, destName);
                }
            } else if (!(await this.tree.child(sourceParent, destName))) {
                // The destination folder already has a child with the source name:
                // rename in the source folder first, then move.
                await this.sdk.renameNode(node, destName);
                await this.checkResults(this.sdk.moveNodes([node.uid], destParent));
            } else {
                throw new KationError('AlreadyExists', `Name conflict while moving to ${destination}`);
            }
        } finally {
            this.tree.invalidate(sourceParent.uid);
            this.tree.invalidate(destParent.uid);
        }
    }

    async trash(drivePath: string): Promise<void> {
        const { parent, name } = await this.resolveParent(drivePath);
        const node = await this.tree.child(parent, name);
        if (!node) {
            throw new KationError('NotFound', `Not found: ${drivePath}`);
        }
        try {
            await this.trashNode(node);
        } finally {
            this.tree.invalidate(parent.uid);
        }
    }

    /** Downloads a file to an absolute local path, replacing it atomically. */
    async download(drivePath: string, localPath: string, options: TransferOptions = {}): Promise<Entry> {
        checkLocalPath(localPath);
        const node = await this.tree.resolve(drivePath);
        if (isFolder(node)) {
            throw new KationError('IsAFolder', `Is a folder: ${drivePath}`);
        }
        await this.downloadNode(node, localPath, options);
        return toEntry(node);
    }

    /**
     * Downloads a file node to `localPath` through a temporary `.kation-part`
     * file, then sets the file's modification time to the one stored in Drive.
     */
    async downloadNode(node: NodeEntity, localPath: string, options: TransferOptions = {}): Promise<void> {
        const revision = node.activeRevision;
        const expectedSha1 = revision?.claimedDigests?.sha1;
        const claimedSize = revision?.claimedSize;
        // The seekable stream skips the SDK's checks: resuming needs a size and checksum, from
        // attributes whose signature verified, to check the result against.
        const resumable =
            !!options.resumable && !!expectedSha1 && claimedSize !== undefined && !!revision?.uid && revision.contentAuthor.ok;
        const partPath = resumable ? resumablePartPath(localPath, revision!.uid) : partPathOf(localPath, '.kation-part', false);

        if (resumable) {
            await removeStaleParts(localPath, partPath);
            const part = await lstat(partPath).catch(() => undefined);
            // Only a file of our own: not a link, nor a hard link to a file elsewhere.
            if (part?.isFile() && part.nlink === 1 && part.size > 0 && part.size <= claimedSize!) {
                if (await this.resumeDownload(node, partPath, part.size, claimedSize!, expectedSha1!, options)) {
                    await finishDownload(node, partPath, localPath, options);
                    return;
                }
            }
        }

        const handle = await createPartFile(partPath);
        let completed = false;
        let keepPart = false;
        try {
            const downloader = await this.sdk.getFileDownloader(node, options.signal);
            const stream = new WritableStream<Uint8Array>({
                write: async (chunk) => {
                    await this.downloadLimiter.take(chunk.length, options.signal);
                    await handle.write(chunk);
                },
            });
            // The signal given to getFileDownloader aborts the transfer itself.
            const controller = downloader.downloadToStream(stream, options.onProgress);
            await raceAbort(controller.completion(), options.signal);
            if (controller.isDownloadCompleteWithSignatureIssues()) {
                this.logger.warn(`Downloaded ${node.uid} with signature verification issues`);
            }
            await handle.close();
            await finishDownload(node, partPath, localPath, options);
            completed = true;
        } catch (error: unknown) {
            keepPart = resumable && TRANSIENT_CODES.has(toKationError(error).code);
            throw error;
        } finally {
            if (!completed) {
                await handle.close().catch(() => {});
                if (!keepPart) {
                    await unlink(partPath).catch(() => {});
                }
            }
        }
    }

    /**
     * Continues an interrupted download from `offset`. Returns false (after
     * deleting the partial file) when the result does not match the size or
     * checksum, so the caller downloads the whole file again.
     */
    private async resumeDownload(
        node: NodeEntity,
        partPath: string,
        offset: number,
        expectedSize: number,
        expectedSha1: string,
        options: TransferOptions,
    ): Promise<boolean> {
        this.logger.info(`Resuming download of ${node.uid} at byte ${offset}`);
        let size: number;
        try {
            const downloader = await this.sdk.getFileDownloader(node, options.signal);
            const stream = downloader.getSeekableStream();
            await stream.seek(offset);
            const handle = await open(partPath, APPEND_PART_FLAGS);
            try {
                const opened = await handle.stat();
                if (!opened.isFile() || opened.nlink !== 1) {
                    throw new Error('The partial file was replaced');
                }
                let written = offset;
                while (true) {
                    options.signal?.throwIfAborted();
                    const { value, done } = await stream.read(RESUME_CHUNK_SIZE);
                    if (value && value.length > 0) {
                        await this.downloadLimiter.take(value.length, options.signal);
                        await handle.write(value);
                        written += value.length;
                        options.onProgress?.(written);
                    }
                    if (done || !value || value.length === 0) {
                        break;
                    }
                }
                size = (await handle.stat()).size;
            } finally {
                await handle.close();
            }
        } catch (error: unknown) {
            if (TRANSIENT_CODES.has(toKationError(error).code)) {
                throw error; // keep the partial file for next time
            }
            this.logger.warn(`Could not resume the download of ${node.uid}, downloading it again: ${error}`);
            await unlink(partPath).catch(() => {});
            return false;
        }
        if (size !== expectedSize) {
            this.logger.warn(`Resumed download of ${node.uid} has ${size} bytes instead of ${expectedSize}, downloading it again`);
            await unlink(partPath).catch(() => {});
            return false;
        }
        const sha1 = await sha1OfPart(partPath, options.signal).catch((error: unknown) => {
            if (options.signal?.aborted) {
                throw error;
            }
            return undefined;
        });
        if (sha1 !== expectedSha1) {
            this.logger.warn(`Resumed download of ${node.uid} failed the checksum, downloading it again`);
            await unlink(partPath).catch(() => {});
            return false;
        }
        return true;
    }

    /** Uploads a local file to a path. With overwrite, an existing file gets a new revision. */
    async upload(localPath: string, drivePath: string, overwrite: boolean, options: TransferOptions = {}): Promise<Entry> {
        checkLocalPath(localPath);
        const { parent, name } = await this.resolveParent(drivePath);
        const existing = await this.tree.child(parent, name);
        if (existing && isFolder(existing)) {
            throw new KationError('IsAFolder', `Is a folder: ${drivePath}`);
        }
        if (existing && !overwrite) {
            throw new KationError('AlreadyExists', `Already exists: ${drivePath}`);
        }
        return toEntry(await this.uploadFile(parent, name, localPath, existing, options), name);
    }

    /**
     * Uploads a local file into `parent` as `name`: a new revision of
     * `existing` when given, otherwise a new file. Returns the resulting node.
     */
    async uploadFile(
        parent: NodeEntity,
        name: string,
        localPath: string,
        existing: NodeEntity | undefined,
        options: TransferOptions = {},
    ): Promise<NodeEntity> {
        const info = await stat(localPath);
        if (!info.isFile()) {
            throw new KationError('InvalidArgument', `Not a regular file: ${localPath}`);
        }
        const metadata = {
            // The destination name decides the type: local paths can be
            // nameless spool files (e.g. data streamed in by KIO).
            mediaType: mediaTypeOf(name),
            expectedSize: info.size,
            expectedSha1: await sha1Of(localPath, options.signal),
            modificationTime: info.mtimeMs > 0 ? info.mtime : undefined,
        };
        try {
            const uploader = existing
                ? await this.sdk.getFileRevisionUploader(existing, metadata, options.signal)
                : await this.sdk.getFileUploader(parent, name, metadata, options.signal);
            const controller = await uploader.uploadFromStream(
                this.uploadLimiter.throttle(Bun.file(localPath).stream(), options.signal),
                [],
                options.onProgress,
            );
            // The signal given to the uploader aborts the transfer itself.
            const { nodeUid } = await raceAbort(controller.completion(), options.signal);
            return await this.sdk.getNode(nodeUid);
        } finally {
            this.tree.invalidate(parent.uid);
        }
    }

    /**
     * Returns the public share link of a file or folder ("" if it has none).
     * With create, makes one first if needed (anyone with the link can view).
     */
    async shareLink(drivePath: string, create: boolean): Promise<string> {
        if (drivePath === '/') {
            throw new KationError('InvalidArgument', 'The root folder cannot be shared');
        }
        const node = await this.tree.resolve(drivePath);
        const existing = (await this.sdk.getSharingInfo(node))?.urlAccess?.url;
        if (existing || !create) {
            return existing ?? '';
        }
        this.logger.info(`Creating a public link for ${node.uid}`);
        const url = (await this.sdk.shareNode(node, { urlAccess: true })).urlAccess?.url;
        if (!url) {
            throw new KationError('Failed', 'Proton did not return a link');
        }
        return url;
    }

    /** The address of a file or folder in the Proton Drive web app. */
    async webUrl(drivePath: string): Promise<string> {
        const node = await this.tree.resolve(drivePath);
        return this.sdk.experimental.getNodeUrl(node);
    }

    /** Creates a folder in `parent` and returns it. */
    async createFolderIn(parent: NodeEntity, name: string, modificationTime?: Date): Promise<NodeEntity> {
        try {
            return await this.sdk.createFolder(parent, name, modificationTime);
        } finally {
            this.tree.invalidate(parent.uid);
        }
    }

    /** Moves a node to the Proton Drive trash. */
    async trashNode(node: NodeEntity): Promise<void> {
        try {
            await this.checkResults(this.sdk.trashNodes([node]));
        } finally {
            if (node.parentUid) {
                this.tree.invalidate(node.parentUid);
            }
        }
    }

    private async resolveParent(drivePath: string): Promise<{ parent: NodeEntity; name: string }> {
        const [parentParts, name] = splitParent(drivePath);
        if (name.length > 255) {
            throw new KationError('InvalidArgument', 'Name is too long');
        }
        const parent = await this.tree.resolveParts(parentParts);
        if (!isFolder(parent)) {
            throw new KationError('NotAFolder', `Not a folder: ${joinPath(parentParts)}`);
        }
        return { parent, name };
    }

    /** Whether `folder` is `ancestor` or inside it. */
    private async isInside(folder: NodeEntity, ancestor: NodeEntity): Promise<boolean> {
        let current: NodeEntity | undefined = folder;
        for (let depth = 0; current && depth < 256; depth++) {
            if (current.uid === ancestor.uid) {
                return true;
            }
            current = current.parentUid ? await this.sdk.getNode(current.parentUid) : undefined;
        }
        return false;
    }

    private async checkResults(results: AsyncGenerator<NodeResult>): Promise<void> {
        for await (const result of results) {
            if (!result.ok) {
                throw toKationError(result.error);
            }
        }
    }
}

/** Hidden partial file for a resumable download, specific to the revision being downloaded. */
export function resumablePartPath(localPath: string, revisionUid: string): string {
    const tag = createHash('sha1').update(revisionUid).digest('hex').slice(0, 8);
    return partPathOf(localPath, `.${tag}.kation-part`, true);
}

/** Longest file name Linux file systems take, in bytes. */
const MAX_NAME_BYTES = 255;

/**
 * `<name><suffix>` next to the file (with a leading dot when hidden). When that is
 * longer than a file name may be, `.kation-<hash of the name><suffix>` instead;
 * sync ignores both forms (see isIgnoredName).
 */
function partPathOf(localPath: string, suffix: string, hidden: boolean): string {
    const name = path.basename(localPath);
    const part = `${hidden ? '.' : ''}${name}${suffix}`;
    return path.join(path.dirname(localPath), Buffer.byteLength(part) <= MAX_NAME_BYTES ? part : `${shortPartPrefix(name)}${suffix}`);
}

function shortPartPrefix(name: string): string {
    return `.kation-${createHash('sha1').update(name).digest('hex').slice(0, 16)}`;
}

/** Deletes partial downloads of older revisions of the same file. */
async function removeStaleParts(localPath: string, currentPart: string): Promise<void> {
    const name = path.basename(localPath);
    const prefixes = [`.${name}.`, `${shortPartPrefix(name)}.`];
    const entries = await readdir(path.dirname(localPath)).catch(() => [] as string[]);
    for (const entry of entries) {
        const candidate = path.join(path.dirname(localPath), entry);
        if (prefixes.some((prefix) => entry.startsWith(prefix)) && entry.endsWith('.kation-part') && candidate !== currentPart) {
            await unlink(candidate).catch(() => {});
        }
    }
}

/**
 * Creates a partial file, replacing whatever has its name. Default mode (the
 * umask applies): downloads into the user's folders get normal permissions.
 */
async function createPartFile(partPath: string) {
    await unlink(partPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    });
    try {
        return await open(partPath, NEW_PART_FLAGS, 0o666);
    } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' || code === 'ELOOP') {
            throw new KationError('Failed', `Something else created ${partPath} during the download`, { cause: error });
        }
        throw error;
    }
}

/** SHA-1 of a partial file, without following a link or blocking on a FIFO swapped in for it. */
async function sha1OfPart(partPath: string, signal?: AbortSignal): Promise<string> {
    const handle = await open(partPath, READ_PART_FLAGS);
    try {
        if (!(await handle.stat()).isFile()) {
            throw new Error('The partial file was replaced');
        }
        const hash = createHash('sha1');
        const buffer = Buffer.alloc(RESUME_CHUNK_SIZE);
        while (true) {
            signal?.throwIfAborted();
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) {
                return hash.digest('hex');
            }
            hash.update(buffer.subarray(0, bytesRead));
        }
    } finally {
        await handle.close();
    }
}

/** Gives the downloaded file Drive's modification time and moves it into place. */
async function finishDownload(node: NodeEntity, partPath: string, localPath: string, options: TransferOptions): Promise<void> {
    const mtime = toEntry(node).mtime;
    if (mtime > 0) {
        await utimes(partPath, new Date(), new Date(mtime * 1000));
    }
    await options.beforeReplace?.();
    await rename(partPath, localPath);
}

/** Local paths come from other processes; insist on absolute, normalised paths. */
function checkLocalPath(localPath: string): void {
    if (!path.isAbsolute(localPath) || path.normalize(localPath) !== localPath) {
        throw new KationError('InvalidArgument', `Local path must be absolute and normalised: ${localPath}`);
    }
}

/** Media type from a file name's extension (case-insensitive), as the Proton CLI does. */
export function mediaTypeOf(fileName: string): string {
    const ext = path.extname(fileName);
    const type = Bun.file(ext ? `${fileName.slice(0, -ext.length)}${ext.toLowerCase()}` : fileName).type;
    // Bun adds a charset to text types; Proton stores the bare media type.
    return type.split(';')[0]?.trim() || OCTET_STREAM;
}

export async function sha1Of(localPath: string, signal?: AbortSignal): Promise<string> {
    const hash = createHash('sha1');
    for await (const chunk of createReadStream(localPath, { signal })) {
        hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
}

/** Returns as soon as the caller aborts, even if the SDK takes a while to wind down. */
async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
        return promise;
    }
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new KationError('Cancelled', 'Transfer cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}
