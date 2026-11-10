// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <QString>

namespace Kation
{
/**
 * The media type to report for a file named @p name whose type in Proton Drive
 * is @p storedType. The uploader's client sets the stored type, and KIO picks the
 * application from what the worker reports, so the name decides when it gives a type.
 */
QString fileMimeType(const QString &name, const QString &storedType);
}
