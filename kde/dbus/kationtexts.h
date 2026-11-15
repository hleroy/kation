// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <QString>
#include <QVariantMap>

// kationd reports why it is paused or cannot work as codes (see the interface
// XML); these functions word them in the user's language. Unknown codes, from a
// newer kationd, fall back to its English text.
namespace Kation
{
/// Why sync is paused or cannot run, from a sync status: empty for a pause the
/// user asked for, otherwise the reason (or error) to show.
QString syncReasonText(const QVariantMap &syncStatus);

/// True when sync paused by itself for safety, rather than because the user paused it.
bool isSafetyPause(const QVariantMap &syncStatus);

/// Why Kation cannot work right now, from a status, or empty if nothing is wrong.
QString problemText(const QVariantMap &status);

/// How full the Proton Drive storage is. Ordered: a higher level is more urgent.
enum class StorageLevel {
    Unknown,
    Ok,
    AlmostFull,
    Full,
};

/// Usage from which the storage counts as almost full, in percent.
inline constexpr int almostFullPercent = 90;

/// From a status (storageUsed, storageMax) and a sync status: Full also when
/// Proton refused uploads for lack of space (reason "storageFull").
StorageLevel storageLevel(const QVariantMap &status, const QVariantMap &syncStatus = {});

/// Percentage of the storage used, rounded down, or -1 when unknown.
int storagePercent(const QVariantMap &status);

/// "1.5 GiB of 5 GiB used (30%)", or empty when the storage is unknown.
QString storageUsageText(const QVariantMap &status);

/// What a nearly full or full storage means and what to do; empty otherwise.
QString storageWarningText(StorageLevel level);
}
