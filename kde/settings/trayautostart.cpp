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

#include <algorithm>

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

QString desktopExecArgument(const QString &argument)
{
    static const QString reserved = QStringLiteral(" \t\n\"'\\<>~|&;$*?#()`");
    const bool needsQuotes = std::any_of(argument.cbegin(), argument.cend(), [](QChar c) {
        return reserved.contains(c);
    });
    QString quoted;
    for (const QChar c : argument) {
        if (needsQuotes && (c == u'"' || c == u'`' || c == u'$' || c == u'\\')) {
            quoted += u'\\';
        }
        quoted += c;
    }
    if (needsQuotes) {
        quoted = u'"' + quoted + u'"';
    }
    // "%" starts a field code. Then the escaping of every string value, which readers undo first.
    quoted.replace(u'%', QStringLiteral("%%"));
    quoted.replace(u'\\', QStringLiteral("\\\\"));
    quoted.replace(u'\n', QStringLiteral("\\n"));
    return quoted;
}

void applyTrayAutostart()
{
    const QString path = trayAutostartPath();
    if (!trayAtLogin()) {
        QFile::remove(path);
        return;
    }
    // The installed program, not the running one: System Settings runs this code too.
    // Rewritten when it differs, so an entry that relied on PATH is corrected.
    const QByteArray content = QByteArrayLiteral(
                                   "[Desktop Entry]\n"
                                   "Type=Application\n"
                                   "Name=Kation\n"
                                   "Comment=Proton Drive in the system tray (unofficial client)\n"
                                   "Exec=")
        + desktopExecArgument(QStringLiteral(KATION_TRAY_EXECUTABLE)).toUtf8()
        + QByteArrayLiteral(" --tray\n"
                            "Icon=com.hleroy.Kation\n"
                            "X-KDE-autostart-phase=2\n");
    QFile existing(path);
    if (existing.open(QIODevice::ReadOnly) && existing.readAll() == content) {
        return;
    }
    existing.close();
    QDir().mkpath(QFileInfo(path).absolutePath());
    QSaveFile file(path);
    if (!file.open(QIODevice::WriteOnly)) {
        return;
    }
    file.write(content);
    file.commit();
}
}
