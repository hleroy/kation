// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include "kationweb.h"

#include <KLocalizedString>

#include <QDesktopServices>
#include <QUrl>

namespace Kation
{
bool isWebUrl(const QString &url)
{
    const QUrl parsed(url, QUrl::StrictMode);
    return parsed.isValid() && parsed.scheme() == QLatin1String("https") && !parsed.host().isEmpty();
}

bool openWebUrl(const QString &url)
{
    if (!isWebUrl(url)) {
        return false;
    }
    return QDesktopServices::openUrl(QUrl(url, QUrl::StrictMode));
}

QString refusedWebUrlText()
{
    return i18n("Kation received a web address it will not open.");
}
}
