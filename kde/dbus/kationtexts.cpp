// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include "kationtexts.h"

#include <KFormat>
#include <KLocalizedString>

QString Kation::syncReasonText(const QVariantMap &syncStatus)
{
    const QString reason = syncStatus.value(QStringLiteral("reason")).toString();
    if (reason == QLatin1String("user")) {
        return {};
    }
    if (reason == QLatin1String("deletions")) {
        return i18np("More than one item would be deleted at once. Check the sync folder, then resume sync to continue.",
                     "More than %1 items would be deleted at once. Check the sync folder, then resume sync to continue.",
                     syncStatus.value(QStringLiteral("deletionLimit")).toUInt());
    }
    if (reason == QLatin1String("folder")) {
        return i18n("The sync folder %1 is missing or was replaced. Restore it and sync resumes by itself, or turn sync off and on again to start over.",
                    syncStatus.value(QStringLiteral("folder")).toString());
    }
    if (reason == QLatin1String("notMounted")) {
        return i18n("The sync folder %1 is on a disk that is not mounted. Mount the disk and sync starts by itself.",
                    syncStatus.value(QStringLiteral("folder")).toString());
    }
    if (reason == QLatin1String("account")) {
        return i18n(
            "You are signed in to a different Proton account than the one this folder was synced with. Turn sync off and on again to sync this folder with "
            "the current account instead.");
    }
    if (reason == QLatin1String("signedOut")) {
        return i18n("Sign in to sync.");
    }
    if (reason == QLatin1String("items")) {
        return i18n("Some items could not be synced.");
    }
    if (reason == QLatin1String("storageFull")) {
        return i18n("Your Proton Drive storage is full: files you add or change are not uploaded.");
    }
    if (reason == QLatin1String("links")) {
        return i18n(
            "A symbolic link in the sync folder has the same name as an item in Proton Drive. Kation does not sync symbolic links, so that item is not "
            "synced either: rename or remove the link.");
    }
    // An error from Proton Drive, or a reason this version does not know.
    return syncStatus.value(QStringLiteral("message")).toString();
}

bool Kation::isSafetyPause(const QVariantMap &syncStatus)
{
    const QString reason = syncStatus.value(QStringLiteral("reason")).toString();
    return syncStatus.value(QStringLiteral("state")).toString() == QLatin1String("paused") && !reason.isEmpty() && reason != QLatin1String("user");
}

QString Kation::problemText(const QVariantMap &status)
{
    const QString code = status.value(QStringLiteral("problemCode")).toString();
    const QString detail = status.value(QStringLiteral("problemDetail")).toString();
    QString text;
    if (code == QLatin1String("keyring")) {
        text = i18n(
            "Kation cannot use your keyring to keep you signed in. On Plasma, enable System Settings → KDE Wallet → “Use KWallet for the Secret Service "
            "interface”, then try again.");
    } else if (code == QLatin1String("sessionLost")) {
        text = i18n("Your Proton session ended (it expired or was signed out elsewhere). Sign in again to continue.");
    } else {
        return status.value(QStringLiteral("problem")).toString();
    }
    return detail.isEmpty() ? text : i18nc("@info a problem, then the error behind it", "%1 (%2)", text, detail);
}

Kation::StorageLevel Kation::storageLevel(const QVariantMap &status, const QVariantMap &syncStatus)
{
    if (syncStatus.value(QStringLiteral("reason")).toString() == QLatin1String("storageFull")) {
        return StorageLevel::Full;
    }
    const int percent = storagePercent(status);
    if (percent < 0) {
        return StorageLevel::Unknown;
    }
    return percent >= 100 ? StorageLevel::Full : percent >= almostFullPercent ? StorageLevel::AlmostFull : StorageLevel::Ok;
}

int Kation::storagePercent(const QVariantMap &status)
{
    const qint64 used = status.value(QStringLiteral("storageUsed"), -1).toLongLong();
    const qint64 max = status.value(QStringLiteral("storageMax"), -1).toLongLong();
    if (used < 0 || max <= 0) {
        return -1;
    }
    return static_cast<int>(used * 100 / max);
}

QString Kation::storageUsageText(const QVariantMap &status)
{
    const int percent = storagePercent(status);
    if (percent < 0) {
        return {};
    }
    const KFormat format;
    return i18nc("@info storage: used, total, percentage used",
                 "%1 of %2 used (%3%)",
                 format.formatByteSize(status.value(QStringLiteral("storageUsed")).toDouble()),
                 format.formatByteSize(status.value(QStringLiteral("storageMax")).toDouble()),
                 percent);
}

QString Kation::storageWarningText(StorageLevel level)
{
    switch (level) {
    case StorageLevel::AlmostFull:
        return i18n("Your Proton Drive storage is almost full. Once it is full, files you add or change are no longer uploaded.");
    case StorageLevel::Full:
        return i18n(
            "Your Proton Drive storage is full: files you add or change are not uploaded. Free up space (files in the Proton Drive trash count too) or get "
            "more storage.");
    case StorageLevel::Unknown:
    case StorageLevel::Ok:
        break;
    }
    return {};
}
