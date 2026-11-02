// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';

import { entryToDbus, interfaceXml, parseMethodSignatures, statusToDbus, syncStatusToDbus } from '../src/service/dbusServer';

describe('D-Bus contract', () => {
    const methods = parseMethodSignatures(interfaceXml);

    it('parses every method of the interface XML', () => {
        expect([...methods.keys()].sort()).toEqual(
            [
                'CancelLogin',
                'CancelTransfer',
                'CreateFolder',
                'Download',
                'GetItemStates',
                'GetRecentActivity',
                'GetShareLink',
                'GetStatus',
                'GetSyncStatus',
                'GetWebUrl',
                'List',
                'Logout',
                'Move',
                'SetBandwidthLimits',
                'SetExcludedFolders',
                'SetSyncEnabled',
                'SetSyncFolder',
                'SetSyncPaused',
                'StartLogin',
                'Stat',
                'SyncNow',
                'Trash',
                'Upload',
            ].sort(),
        );
        expect(methods.get('Upload')).toEqual({ in: 'ssbs', out: 'a{sv}' });
        expect(methods.get('List')).toEqual({ in: 's', out: 'aa{sv}' });
        expect(methods.get('CancelLogin')).toEqual({ in: '', out: '' });
        expect(methods.get('SetExcludedFolders')).toEqual({ in: 'as', out: '' });
        expect(methods.get('GetItemStates')).toEqual({ in: 'as', out: 'a{sv}' });
        expect(methods.get('GetShareLink')).toEqual({ in: 'sb', out: 's' });
        expect(methods.get('SetBandwidthLimits')).toEqual({ in: 'uu', out: '' });
    });

    it('encodes entries with the documented keys and types', () => {
        const encoded = entryToDbus({ name: 'a', type: 'file', size: 1, mtime: 2, ctime: 3, mimeType: 'text/plain' });
        expect(Object.fromEntries(Object.entries(encoded).map(([key, value]) => [key, value.signature]))).toEqual({
            name: 's',
            type: 's',
            size: 'x',
            mtime: 'x',
            ctime: 'x',
            mimeType: 's',
        });
    });

    const signatures = (encoded: Record<string, { signature: string }>) =>
        Object.fromEntries(Object.entries(encoded).map(([key, value]) => [key, value.signature]));

    it('encodes the status with the documented keys and types', () => {
        const encoded = statusToDbus({
            loggedIn: false,
            email: '',
            loginPending: false,
            signInUrl: '',
            appVersion: 'a',
            sdkVersion: 's',
            problem: 'Kation cannot use your keyring (locked)',
            problemCode: 'keyring',
            problemDetail: 'locked',
        });
        expect(signatures(encoded)).toEqual({
            loggedIn: 'b',
            email: 's',
            loginPending: 'b',
            signInUrl: 's',
            appVersion: 's',
            sdkVersion: 's',
            problem: 's',
            problemCode: 's',
            problemDetail: 's',
        });
    });

    it('encodes the sync status with the documented keys and types', () => {
        const encoded = syncStatusToDbus({
            enabled: true,
            paused: false,
            folder: '/home/u/Proton Drive',
            excluded: [],
            state: 'paused',
            message: 'More than 100 items would be deleted at once.',
            reason: 'deletions',
            deletionLimit: 100,
            current: '',
            pending: 0,
            lastSync: 0,
            uploadLimit: 0,
            downloadLimit: 0,
        });
        expect(signatures(encoded)).toEqual({
            enabled: 'b',
            paused: 'b',
            folder: 's',
            excluded: 'as',
            state: 's',
            message: 's',
            reason: 's',
            deletionLimit: 'u',
            current: 's',
            pending: 'u',
            lastSync: 'x',
            uploadLimit: 'u',
            downloadLimit: 'u',
        });
    });
});
