// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * In-memory stand-in for Proton Drive, used by unit tests and by the KIO
 * integration tests (`kationd serve --fake-drive`). It implements the narrow
 * SDK surface Kation uses, with the same error types the SDK throws.
 */
import { createHash } from 'node:crypto';

import {
    AbortError,
    type DriveEvent,
    DriveEventType,
    IntegrityError,
    MemberRole,
    type NodeEntity,
    NodeType,
    NodeWithSameNameExistsValidationError,
    RevisionState,
    ValidationError,
} from '@protontech/drive-sdk';

import type { Account, DriveSdk } from './sdk';

const CHUNK_SIZE = 64 * 1024;
const SCOPE_ID = 'fake-volume';

type FakeNode = {
    uid: string;
    parentUid?: string;
    name: string;
    type: NodeType;
    mediaType?: string;
    content?: Uint8Array;
    created: Date;
    modified: Date;
    claimedModified?: Date;
    trashed?: Date;
    revision: number;
    /** Public link, once shared. */
    shareUrl?: string;
};

export type FakeDriveOptions = {
    /** Delay per downloaded or uploaded chunk, to test cancellation. */
    chunkDelayMs?: number;
    /** Called for each change, like Drive events would be. */
    onEvent?: (event: DriveEvent) => void;
};

export class FakeDrive {
    private readonly nodes = new Map<string, FakeNode>();
    private nextUid = 1;
    readonly rootUid: string;
    /** Test helper: bytes sent by downloads, to check that resumed downloads skip what they have. */
    bytesServed = 0;

    constructor(private readonly options: FakeDriveOptions = {}) {
        this.rootUid = this.add({ name: 'root', type: NodeType.Folder }).uid;
    }

    /** Test helper: creates a node directly, without events. */
    add(node: { parentUid?: string; name: string; type: NodeType; content?: string | Uint8Array; mediaType?: string }): FakeNode {
        const now = new Date();
        const content = typeof node.content === 'string' ? new TextEncoder().encode(node.content) : node.content;
        const fake: FakeNode = {
            uid: `node-${this.nextUid++}`,
            parentUid: node.parentUid,
            name: node.name,
            type: node.type,
            mediaType: node.mediaType ?? (node.type === NodeType.File ? 'text/plain' : undefined),
            content: node.type === NodeType.File ? (content ?? new Uint8Array()) : undefined,
            created: now,
            modified: now,
            revision: 1,
        };
        this.nodes.set(fake.uid, fake);
        return fake;
    }

    /** Test helper: content of a file node. */
    contentOf(uid: string): string {
        return new TextDecoder().decode(this.get(uid).content);
    }

    /** Test helper: live children of a folder, by name. */
    childrenOf(uid: string): Map<string, FakeNode> {
        return new Map(this.children(uid).map((node) => [node.name, node]));
    }

    /** Simulates another client uploading a new revision of a file. */
    updateContent(uid: string, content: string, options: { silent?: boolean } = {}): void {
        const node = this.get(uid);
        node.content = new TextEncoder().encode(content);
        node.modified = new Date();
        node.claimedModified = new Date();
        node.revision++;
        if (!options.silent) {
            this.notify(DriveEventType.NodeUpdated, node);
        }
    }

    /** Simulates a change made by another client. */
    remoteChange(change: {
        type: DriveEventType.NodeCreated | DriveEventType.NodeUpdated | DriveEventType.NodeDeleted;
        uid: string;
    }): void {
        this.notify(change.type, this.nodes.get(change.uid) ?? { uid: change.uid });
    }

    readonly sdk: DriveSdk = {
        getMyFilesRootFolder: async () => this.entity(this.get(this.rootUid)),

        iterateFolderChildrenNodeUids: async function* (this: FakeDrive, parent: NodeEntity | string) {
            for (const node of this.children(uidOf(parent))) {
                yield node.uid;
            }
        }.bind(this) as DriveSdk['iterateFolderChildrenNodeUids'],

        iterateNodes: async function* (this: FakeDrive, uids: (NodeEntity | string)[]) {
            for (const uid of uids.map(uidOf)) {
                const node = this.nodes.get(uid);
                yield node ? this.entity(node) : { missingUid: uid };
            }
        }.bind(this) as DriveSdk['iterateNodes'],

        getNode: async (nodeOrUid) => this.entity(this.get(uidOf(nodeOrUid))),

        createFolder: async (parent, name, modificationTime) => {
            this.checkName(uidOf(parent), name);
            const node = this.add({ parentUid: uidOf(parent), name, type: NodeType.Folder });
            node.claimedModified = modificationTime;
            this.notify(DriveEventType.NodeCreated, node);
            return this.entity(node);
        },

        renameNode: async (nodeOrUid, newName) => {
            const node = this.get(uidOf(nodeOrUid));
            if (node.parentUid) {
                this.checkName(node.parentUid, newName);
            }
            node.name = newName;
            node.modified = new Date();
            this.notify(DriveEventType.NodeUpdated, node);
            return this.entity(node);
        },

        moveNodes: async function* (this: FakeDrive, nodes: (NodeEntity | string)[], newParent: NodeEntity | string) {
            for (const uid of nodes.map(uidOf)) {
                try {
                    const node = this.get(uid);
                    this.checkName(uidOf(newParent), node.name);
                    node.parentUid = uidOf(newParent);
                    this.notify(DriveEventType.NodeUpdated, node);
                    yield { uid, ok: true as const };
                } catch (error) {
                    yield { uid, ok: false as const, error: error as Error };
                }
            }
        }.bind(this) as DriveSdk['moveNodes'],

        trashNodes: async function* (this: FakeDrive, nodes: (NodeEntity | string)[]) {
            for (const uid of nodes.map(uidOf)) {
                const node = this.get(uid);
                node.trashed = new Date();
                this.notify(DriveEventType.NodeUpdated, node);
                yield { uid, ok: true as const };
            }
        }.bind(this) as DriveSdk['trashNodes'],

        getFileDownloader: async (nodeOrUid, signal) => {
            const node = this.get(uidOf(nodeOrUid));
            const content = node.content ?? new Uint8Array();
            return {
                getClaimedSizeInBytes: () => content.length,
                downloadToStream: (stream: WritableStream, onProgress?: (bytes: number) => void) =>
                    this.controller(async () => {
                        const writer = stream.getWriter();
                        for (let offset = 0; offset < content.length; offset += CHUNK_SIZE) {
                            await this.chunkPause(signal);
                            const chunk = content.slice(offset, offset + CHUNK_SIZE);
                            this.bytesServed += chunk.length;
                            await writer.write(chunk);
                            onProgress?.(Math.min(offset + CHUNK_SIZE, content.length));
                        }
                        writer.releaseLock();
                    }),
                unsafeDownloadToStream: () => {
                    throw new Error('Not implemented');
                },
                getSeekableStream: () => {
                    let position = 0;
                    return {
                        seek: (offset: number) => {
                            position = offset;
                        },
                        read: async (count: number) => {
                            await this.chunkPause(signal);
                            const value = content.slice(position, position + Math.min(count, CHUNK_SIZE));
                            position += value.length;
                            this.bytesServed += value.length;
                            return { value, done: position >= content.length };
                        },
                    };
                },
            } as unknown as Awaited<ReturnType<DriveSdk['getFileDownloader']>>;
        },

        getFileUploader: async (parent, name, metadata, signal) => {
            this.checkName(uidOf(parent), name);
            return this.uploader(metadata, signal, (content) => {
                this.checkName(uidOf(parent), name);
                const node = this.add({ parentUid: uidOf(parent), name, type: NodeType.File, content, mediaType: metadata.mediaType });
                node.claimedModified = metadata.modificationTime;
                this.notify(DriveEventType.NodeCreated, node);
                return node;
            });
        },

        getSharingInfo: async (nodeOrUid) => {
            const node = this.get(uidOf(nodeOrUid));
            return node.shareUrl ? this.shareResult(node) : undefined;
        },

        shareNode: async (nodeOrUid, settings) => {
            const node = this.get(uidOf(nodeOrUid));
            if (settings.urlAccess && !node.shareUrl) {
                node.shareUrl = `https://drive.proton.me/urls/FAKE${node.uid}#secret`;
            }
            return this.shareResult(node);
        },

        experimental: {
            getNodeUrl: async (nodeOrUid) => {
                const node = this.get(uidOf(nodeOrUid));
                return `https://drive.proton.me/fake-share/${node.type === NodeType.File ? 'file' : 'folder'}/${node.uid}`;
            },
        },

        getFileRevisionUploader: async (nodeOrUid, metadata, signal) => {
            const node = this.get(uidOf(nodeOrUid));
            return this.uploader(metadata, signal, (content) => {
                if (this.isTrashed(node)) {
                    // Like Proton: a 422 "does not exist" for a file in the trash.
                    throw Object.assign(new ValidationError('File or folder not found'), { name: 'NotFoundAPIError', code: 2501 });
                }
                node.content = content;
                node.mediaType = metadata.mediaType;
                node.claimedModified = metadata.modificationTime;
                node.modified = new Date();
                node.revision++;
                this.notify(DriveEventType.NodeUpdated, node);
                return node;
            });
        },
    };

    private shareResult(node: FakeNode) {
        return {
            protonInvitations: [],
            nonProtonInvitations: [],
            members: [],
            editorsCanShare: false,
            urlAccess: node.shareUrl
                ? {
                      uid: `url-${node.uid}`,
                      creationTime: new Date(),
                      role: MemberRole.Viewer,
                      url: node.shareUrl,
                      numberOfInitializedDownloads: 0,
                  }
                : undefined,
        };
    }

    /** Test helper: trashes a node without an event, as if the event had not arrived yet. */
    trashSilently(uid: string): void {
        this.get(uid).trashed = new Date();
    }

    private isTrashed(node: FakeNode): boolean {
        for (
            let current: FakeNode | undefined = node;
            current;
            current = current.parentUid ? this.nodes.get(current.parentUid) : undefined
        ) {
            if (current.trashed) {
                return true;
            }
        }
        return false;
    }

    private children(uid: string): FakeNode[] {
        return [...this.nodes.values()].filter((node) => node.parentUid === uid && !node.trashed);
    }

    private get(uid: string): FakeNode {
        const node = this.nodes.get(uid);
        if (!node) {
            throw new ValidationError(`Node ${uid} not found`);
        }
        return node;
    }

    private checkName(parentUid: string, name: string): void {
        if (!name || name.includes('/')) {
            throw new ValidationError(`Invalid name: ${name}`);
        }
        const existing = this.children(parentUid).find((child) => child.name === name);
        if (existing) {
            throw new NodeWithSameNameExistsValidationError(`A file or folder named "${name}" already exists`, 2500, existing.uid);
        }
    }

    private notify(
        type: DriveEventType.NodeCreated | DriveEventType.NodeUpdated | DriveEventType.NodeDeleted,
        node: Pick<FakeNode, 'uid'> & Partial<FakeNode>,
    ): void {
        const base = { nodeUid: node.uid, parentNodeUid: node.parentUid, treeEventScopeId: SCOPE_ID, eventId: `event-${this.nextUid++}` };
        const event: DriveEvent =
            type === DriveEventType.NodeDeleted ? { type, ...base } : { type, ...base, isTrashed: !!node.trashed, isShared: false };
        queueMicrotask(() => this.options.onEvent?.(event));
    }

    private async chunkPause(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            throw new AbortError('Operation aborted');
        }
        if (this.options.chunkDelayMs) {
            await Bun.sleep(this.options.chunkDelayMs);
            if (signal?.aborted) {
                throw new AbortError('Operation aborted');
            }
        }
    }

    private controller<T>(run: () => Promise<T>) {
        const completion = run();
        completion.catch(() => {});
        return {
            pause() {},
            resume() {},
            completion: () => completion,
            isDownloadCompleteWithSignatureIssues: () => false,
        };
    }

    private uploader(
        metadata: { expectedSize: number | null; expectedSha1?: string },
        signal: AbortSignal | undefined,
        commit: (content: Uint8Array) => FakeNode,
    ) {
        return {
            uploadFromStream: async (stream: ReadableStream, _thumbnails: unknown[], onProgress?: (bytes: number) => void) =>
                this.controller(async () => {
                    const chunks: Uint8Array[] = [];
                    let total = 0;
                    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
                        await this.chunkPause(signal);
                        chunks.push(chunk);
                        total += chunk.length;
                        onProgress?.(total);
                    }
                    const content = Buffer.concat(chunks);
                    if (metadata.expectedSize !== null && metadata.expectedSize !== content.length) {
                        throw new IntegrityError('Uploaded size does not match the expected size');
                    }
                    if (metadata.expectedSha1 && createHash('sha1').update(content).digest('hex') !== metadata.expectedSha1) {
                        throw new IntegrityError('Uploaded content does not match the expected SHA1');
                    }
                    const node = commit(new Uint8Array(content));
                    return { nodeUid: node.uid, nodeRevisionUid: `${node.uid}~${node.revision}` };
                }),
            uploadFromFile: () => {
                throw new Error('Not implemented');
            },
        } as unknown as Awaited<ReturnType<DriveSdk['getFileUploader']>>;
    }

    private entity(node: FakeNode): NodeEntity {
        const isFile = node.type === NodeType.File;
        return {
            uid: node.uid,
            parentUid: node.parentUid,
            name: { ok: true, value: node.name },
            keyAuthor: { ok: true, value: 'tester@example.com' },
            nameAuthor: { ok: true, value: 'tester@example.com' },
            directRole: 'admin',
            ownedBy: { email: 'tester@example.com' },
            type: node.type,
            mediaType: node.mediaType,
            isShared: false,
            isSharedByUrl: false,
            creationTime: node.created,
            modificationTime: node.modified,
            trashTime: node.trashed,
            treeEventScopeId: SCOPE_ID,
            activeRevision: isFile
                ? {
                      uid: `${node.uid}~${node.revision}`,
                      state: RevisionState.Active,
                      creationTime: node.modified,
                      contentAuthor: { ok: true, value: 'tester@example.com' },
                      storageSize: node.content?.length ?? 0,
                      isImported: false,
                      claimedSize: node.content?.length ?? 0,
                      claimedModificationTime: node.claimedModified,
                      claimedDigests: {
                          sha1: createHash('sha1')
                              .update(node.content ?? new Uint8Array())
                              .digest('hex'),
                          sha1Verified: false,
                      },
                  }
                : undefined,
            folder: isFile ? undefined : { claimedModificationTime: node.claimedModified, isImported: false },
        } as unknown as NodeEntity;
    }
}

/** Account stand-in: signs in after a short delay without any network access. */
export class FakeAccount implements Account {
    private readonly listeners = new Set<() => void>();

    constructor(
        private loggedIn = true,
        private readonly loginDelayMs = 1000,
    ) {}

    isLoggedIn(): boolean {
        return this.loggedIn;
    }

    async getEmail(): Promise<string> {
        return 'tester@example.com';
    }

    async authViaWeb(onSignInUrl: (url: string) => void, signal: AbortSignal): Promise<void> {
        onSignInUrl('https://account.proton.me/desktop/login?app=drive&pv=3#payload=fake');
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, this.loginDelayMs);
            signal.addEventListener(
                'abort',
                () => {
                    clearTimeout(timer);
                    reject(new AbortError('Sign-in cancelled'));
                },
                { once: true },
            );
        });
        this.loggedIn = true;
        this.notify();
    }

    async logout(): Promise<void> {
        this.loggedIn = false;
        this.notify();
    }

    onSessionChanged(listener: () => void): void {
        this.listeners.add(listener);
    }

    /** Simulates Proton ending the session (e.g. revoked from the web app). */
    expireSession(): void {
        this.loggedIn = false;
        this.notify();
    }

    private notify(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }
}

function uidOf(nodeOrUid: NodeEntity | string): string {
    return typeof nodeOrUid === 'string' ? nodeOrUid : nodeOrUid.uid;
}
