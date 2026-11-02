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
}
