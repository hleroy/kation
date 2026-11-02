// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { type NodeEntity, NodeType } from '@protontech/drive-sdk';

export const FOLDER_MIME_TYPE = 'inode/directory';

/** A file or folder as exposed over D-Bus. */
export type Entry = {
    name: string;
    type: 'file' | 'folder';
    /** Bytes, -1 if unknown or a folder. */
    size: number;
    /** Seconds since the epoch. */
    mtime: number;
    ctime: number;
    mimeType: string;
};

/** Folders and albums are containers; everything else is a file. */
export function isFolder(node: NodeEntity): boolean {
    return node.type === NodeType.Folder || node.type === NodeType.Album;
}

export function nodeName(node: NodeEntity): string {
    return node.name.ok && node.name.value.length > 0 ? node.name.value : node.uid;
}

/**
 * Whether a name can be used as a single path component. Proton accepts any
 * name, so another client (or a collaborator in a shared folder) can create
 * "..", "a/b" and the like, which would point outside their folder here.
 */
export function isUsableName(name: string): boolean {
    return name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0');
}

export function toEntry(node: NodeEntity, name = nodeName(node)): Entry {
    const folder = isFolder(node);
    const modified =
        (folder ? node.folder?.claimedModificationTime : node.activeRevision?.claimedModificationTime) ?? node.modificationTime;
    return {
        name,
        type: folder ? 'folder' : 'file',
        size: folder ? -1 : (node.activeRevision?.claimedSize ?? -1),
        mtime: toSeconds(modified),
        ctime: toSeconds(node.creationTime),
        mimeType: folder ? FOLDER_MIME_TYPE : node.mediaType || 'application/octet-stream',
    };
}

function toSeconds(date: Date | undefined): number {
    return date ? Math.floor(date.getTime() / 1000) : 0;
}
