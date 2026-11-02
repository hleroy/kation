// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import type { MaybeMissingNode, NodeEntity, ProtonDriveClient } from '@protontech/drive-sdk';
import { ValidationError } from '@protontech/drive-sdk';

type FolderSdk = Pick<ProtonDriveClient, 'getMyFilesRootFolder' | 'iterateFolderChildrenNodeUids' | 'iterateNodes'>;

/** Display name of a node, falling back to its UID when the name cannot be decrypted. */
export function nodeName(node: NodeEntity): string {
    return node.name.ok && node.name.value.length > 0 ? node.name.value : node.uid;
}

/** Splits a POSIX path inside "My files" into its components, rejecting `.` and `..`. */
export function splitDrivePath(drivePath: string): string[] {
    // Split before normalising: normalize() would silently resolve `..`.
    const parts = drivePath.split('/').filter(Boolean);
    if (parts.some((part) => part === '..' || part === '.')) {
        throw new ValidationError(`Invalid path: ${drivePath}`);
    }
    return parts;
}

/** Lists the children of a folder. Fetches node metadata in one batch, as the SDK recommends. */
export async function listFolder(sdk: FolderSdk, folder: NodeEntity | string): Promise<NodeEntity[]> {
    const uids: string[] = [];
    for await (const uid of sdk.iterateFolderChildrenNodeUids(folder)) {
        uids.push(uid);
    }
    if (uids.length === 0) {
        return [];
    }
    const nodes: NodeEntity[] = [];
    for await (const node of sdk.iterateNodes(uids)) {
        if (!isMissing(node)) {
            nodes.push(node);
        }
    }
    return nodes;
}

/** Resolves a path such as `/Documents/Taxes` inside "My files". */
export async function resolvePath(sdk: FolderSdk, drivePath: string): Promise<NodeEntity> {
    let node = await sdk.getMyFilesRootFolder();
    const parts = splitDrivePath(drivePath);
    for (const [index, part] of parts.entries()) {
        const children = await listFolder(sdk, node);
        const child = children.find((candidate) => nodeName(candidate) === part);
        if (!child) {
            throw new ValidationError(`Not found: /${parts.slice(0, index + 1).join('/')}`);
        }
        node = child;
    }
    return node;
}

function isMissing(node: MaybeMissingNode): node is { missingUid: string } {
    return 'missingUid' in node;
}
