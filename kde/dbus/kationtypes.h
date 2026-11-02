// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <QDBusConnection>
#include <QList>
#include <QString>
#include <QVariantMap>

// D-Bus type aa{sv}: a list of entries from com.hleroy.Kation.Drive1.List.
using QVariantMapList = QList<QVariantMap>;
Q_DECLARE_METATYPE(QVariantMapList)

namespace Kation
{
inline const QString serviceName = QStringLiteral("com.hleroy.Kation");
inline const QString objectPath = QStringLiteral("/com/hleroy/Kation");
inline const QString errorPrefix = QStringLiteral("com.hleroy.Kation.Error.");

/// Registers the custom D-Bus types. Call once before using KationDriveInterface.
void registerDBusTypes();
}
