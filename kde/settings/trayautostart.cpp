// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include "trayautostart.h"

#include <KConfigGroup>
#include <KSharedConfig>

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QSaveFile>
#include <QStandardPaths>

namespace
{
KConfigGroup general()
{
    return KSharedConfig::openConfig(QStringLiteral("kationrc"))->group(QStringLiteral("General"));
}
}

namespace Kation
{
QString trayAutostartPath()
{
    return QStandardPaths::writableLocation(QStandardPaths::GenericConfigLocation) + QStringLiteral("/autostart/com.hleroy.Kation.tray.desktop");
}

bool trayAtLogin()
{
    return general().readEntry("TrayAtLogin", true);
}

void setTrayAtLogin(bool enabled)
{
    KConfigGroup group = general();
    group.writeEntry("TrayAtLogin", enabled);
    group.sync();
    applyTrayAutostart();
}

void applyTrayAutostart()
{
    const QString path = trayAutostartPath();
    if (!trayAtLogin()) {
        QFile::remove(path);
        return;
    }
    if (QFile::exists(path)) {
        return;
    }
    QDir().mkpath(QFileInfo(path).absolutePath());
    QSaveFile file(path);
    if (!file.open(QIODevice::WriteOnly)) {
        return;
    }
    file.write(
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=Kation\n"
        "Comment=Proton Drive in the system tray (unofficial client)\n"
        "Exec=kation --tray\n"
        "Icon=com.hleroy.Kation\n"
        "X-KDE-autostart-phase=2\n");
    file.commit();
}
}
