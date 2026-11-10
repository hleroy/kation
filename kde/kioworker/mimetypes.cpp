// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include "mimetypes.h"

#include <QMimeDatabase>
#include <QStringList>

QString Kation::fileMimeType(const QString &name, const QString &storedType)
{
    const QMimeDatabase db;
    // Resolves aliases (text/x-sh is application/x-shellscript); unknown types are invalid.
    const QMimeType stored = db.mimeTypeForName(storedType);
    const QList<QMimeType> fromName = db.mimeTypesForFileName(name);
    if (!fromName.isEmpty()) {
        // An ambiguous extension (.ts: MPEG video or Qt translations) keeps the stored type when it is one of them.
        if (fromName.contains(stored)) {
            return stored.name();
        }
        return db.mimeTypeForFile(name, QMimeDatabase::MatchExtension).name();
    }
    // Viewers that sniff content would still run an image or video stored with any other
    // type (EPS through Ghostscript, playlists), so only plain text survives.
    static const QStringList plainText = {
        QStringLiteral("text/plain"),
        QStringLiteral("text/markdown"),
        QStringLiteral("text/csv"),
    };
    if (plainText.contains(stored.name())) {
        return stored.name();
    }
    return QStringLiteral("application/octet-stream");
}
