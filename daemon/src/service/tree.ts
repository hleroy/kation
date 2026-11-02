// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Resolves "My files" paths to nodes and caches folder listings.
 *
 * The SDK caches node metadata but fetches folder listings from the API on
 * every call. Resolving `/a/b/c` would list three folders each time, which is
 * the kind of repeated tree traversal Proton asks clients to avoid. This
 * cache keeps listings until a Drive event (or our own change) invalidates
 * them. A long TTL is kept as a safety net in case events stop arriving.
 */
import { type DriveEvent, DriveEventType, type Logger, type MaybeMissingNode, type NodeEntity } from '@protontech/drive-sdk';
import { isFolder, isUsableName, nodeName } from './entry';
import { KationError } from './errors';
import type { DriveSdk } from './sdk';

const LISTING_TTL_MS = 10 * 60 * 1000;

type Listing = {
    /** Child name to node UID. */
    children: Map<string, string>;
    loadedAt: number;
};

/** Splits a path inside "My files" into components, rejecting `.` and `..`. */
export function splitPath(path: string): string[] {
    if (!path.startsWith('/')) {
        throw new KationError('InvalidArgument', `Path must be absolute: ${path}`);
    }
    const parts = path.split('/').filter(Boolean);
    if (parts.some((part) => part === '.' || part === '..')) {
        throw new KationError('InvalidArgument', `Invalid path: ${path}`);
    }
    return parts;
}

export function joinPath(parts: string[]): string {
    return `/${parts.join('/')}`;
}

/** Returns [parent path components, name] for a non-root path. */
export function splitParent(path: string): [string[], string] {
    const parts = splitPath(path);
    const name = parts.pop();
    if (name === undefined) {
        throw new KationError('InvalidArgument', 'The root folder cannot be changed');
    }
    return [parts, name];
}

export class DriveTree {
    private rootUid?: string;
    private readonly listings = new Map<string, Listing>();
    /** Listings being loaded, shared by concurrent callers (KIO runs several workers). */
    private readonly loading = new Map<string, Promise<Listing>>();
    /** Bumped on invalidation, so a listing loaded before a change is not cached after it. */
    private readonly generations = new Map<string, number>();
    /** Node UID to its parent UID and name, for nodes seen in a listing. */
    private readonly parents = new Map<string, { parentUid: string; name: string }>();

    constructor(
        private readonly sdk: DriveSdk,
        private readonly logger: Logger,
        private readonly now: () => number = Date.now,
    ) {}

    async root(): Promise<NodeEntity> {
        const root = await this.sdk.getMyFilesRootFolder();
        this.rootUid = root.uid;
        return root;
    }

    /** Resolves a path to a node, or throws NotFound / NotAFolder. */
    async resolve(path: string): Promise<NodeEntity> {
        return this.resolveParts(splitPath(path));
    }

    async resolveParts(parts: string[]): Promise<NodeEntity> {
        let node = await this.root();
        for (const [index, part] of parts.entries()) {
            if (!isFolder(node)) {
                throw new KationError('NotAFolder', `Not a folder: ${joinPath(parts.slice(0, index))}`);
            }
            const childUid = (await this.listing(node.uid)).children.get(part);
            if (!childUid) {
                throw new KationError('NotFound', `Not found: ${joinPath(parts.slice(0, index + 1))}`);
            }
            node = await this.sdk.getNode(childUid);
        }
        return node;
    }

    /** Looks up a child by name, or returns undefined. */
    async child(folder: NodeEntity, name: string): Promise<NodeEntity | undefined> {
        const uid = (await this.listing(folder.uid)).children.get(name);
        return uid ? this.sdk.getNode(uid) : undefined;
    }

    /** Lists a folder. Node metadata comes from the SDK in one batch. */
    async list(folder: NodeEntity): Promise<NodeEntity[]> {
        if (!isFolder(folder)) {
            throw new KationError('NotAFolder', `Not a folder: ${nodeName(folder)}`);
        }
        const listing = await this.listing(folder.uid);
        const uids = [...listing.children.values()];
        if (uids.length === 0) {
            return [];
        }
        const nodes: NodeEntity[] = [];
        for await (const node of this.sdk.iterateNodes(uids)) {
            if (!isMissing(node)) {
                nodes.push(node);
            }
        }
        return nodes;
    }

    /** Drops a cached listing, e.g. after creating or removing a child. */
    invalidate(folderUid: string): void {
        this.listings.delete(folderUid);
        this.loading.delete(folderUid);
        this.generations.set(folderUid, (this.generations.get(folderUid) ?? 0) + 1);
    }

    clear(): void {
        this.rootUid = undefined;
        this.listings.clear();
        this.loading.clear();
        this.generations.clear();
        this.parents.clear();
    }

    /** Path of a cached folder, if the whole chain up to the root is known. */
    pathOf(uid: string): string | undefined {
        const parts: string[] = [];
        let current = uid;
        for (let depth = 0; depth < 256; depth++) {
            if (current === this.rootUid) {
                return joinPath(parts.reverse());
            }
            const parent = this.parents.get(current);
            if (!parent) {
                return undefined;
            }
            parts.push(parent.name);
            current = parent.parentUid;
        }
        return undefined;
    }

    /**
     * Applies a Drive event to the cache. Returns the paths of cached folders
     * whose content changed, so views showing them can be refreshed.
     */
    applyEvent(event: DriveEvent): string[] {
        switch (event.type) {
            case DriveEventType.NodeCreated:
            case DriveEventType.NodeUpdated:
            case DriveEventType.NodeDeleted: {
                const affected = new Set<string>();
                const previous = this.parents.get(event.nodeUid);
                for (const folderUid of [previous?.parentUid, event.parentNodeUid]) {
                    if (folderUid && this.listings.has(folderUid)) {
                        const path = this.pathOf(folderUid);
                        if (path !== undefined) {
                            affected.add(path);
                        }
                        this.invalidate(folderUid);
                    }
                }
                if (event.type === DriveEventType.NodeDeleted) {
                    this.forgetSubtree(event.nodeUid);
                } else if (previous && event.parentNodeUid && previous.parentUid !== event.parentNodeUid) {
                    this.parents.delete(event.nodeUid);
                }
                return [...affected];
            }
            case DriveEventType.TreeRefresh:
            case DriveEventType.TreeRemove: {
                const paths = [...this.listings.keys()].map((uid) => this.pathOf(uid)).filter((path): path is string => path !== undefined);
                this.listings.clear();
                this.parents.clear();
                return paths;
            }
            default:
                return [];
        }
    }

    private async listing(folderUid: string): Promise<Listing> {
        const cached = this.listings.get(folderUid);
        if (cached && this.now() - cached.loadedAt < LISTING_TTL_MS) {
            return cached;
        }
        let loading = this.loading.get(folderUid);
        if (!loading) {
            const promise = this.loadListing(folderUid).finally(() => {
                if (this.loading.get(folderUid) === promise) {
                    this.loading.delete(folderUid);
                }
            });
            loading = promise;
            this.loading.set(folderUid, loading);
        }
        return loading;
    }

    private async loadListing(folderUid: string): Promise<Listing> {
        this.logger.debug(`Listing folder ${folderUid}`);
        const generation = this.generations.get(folderUid) ?? 0;
        const uids: string[] = [];
        for await (const uid of this.sdk.iterateFolderChildrenNodeUids(folderUid)) {
            uids.push(uid);
        }
        const children = new Map<string, string>();
        if (uids.length > 0) {
            for await (const node of this.sdk.iterateNodes(uids)) {
                if (isMissing(node) || node.trashTime) {
                    continue;
                }
                const name = nodeName(node);
                if (node.name.ok && !isUsableName(name)) {
                    // Left out everywhere (online view, sync): it would address something outside this folder.
                    // (Undecryptable names stay: sync refuses their folder rather than see a deletion.)
                    this.logger.warn(`Skipping ${node.uid} in folder ${folderUid}: its name cannot be used as a file name`);
                    continue;
                }
                children.set(name, node.uid);
                this.parents.set(node.uid, { parentUid: folderUid, name });
            }
        }
        const listing = { children, loadedAt: this.now() };
        if ((this.generations.get(folderUid) ?? 0) === generation) {
            this.listings.set(folderUid, listing);
        }
        return listing;
    }

    private forgetSubtree(uid: string): void {
        this.parents.delete(uid);
        const listing = this.listings.get(uid);
        this.listings.delete(uid);
        for (const childUid of listing?.children.values() ?? []) {
            this.forgetSubtree(childUid);
        }
    }
}

function isMissing(node: MaybeMissingNode): node is { missingUid: string } {
    return 'missingUid' in node;
}
