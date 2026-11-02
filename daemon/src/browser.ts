// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { spawn } from 'node:child_process';

/** Opens an https URL with the desktop's default browser. Fails silently without a desktop session. */
export function openBrowserUrl(rawUrl: string): void {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return;
    }
    if (url.protocol !== 'https:') {
        return;
    }
    const child = spawn('xdg-open', [url.href], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
}
