// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include "kationabout.h"

#include <KLocalizedString>

#include <QDir>
#include <QRegularExpression>

namespace Kation
{
KAboutData aboutData()
{
    KAboutData about(QStringLiteral("kation"),
                     i18n("Kation"),
                     QStringLiteral(KATION_VERSION_STRING),
                     i18n("Unofficial Proton Drive client for KDE Plasma"),
                     KAboutLicense::Unknown,
                     i18n("© 2026 Kation contributors"));
    about.setLicense(KAboutLicense::GPL_V2, KAboutLicense::OrLaterVersions);
    // The modules copied from Proton's SDK repository (daemon/src/proton/).
    about.addLicense(KAboutLicense::MIT);
    about.addCredit(i18n("Proton AG"), i18n("Proton Drive SDK and CLI"), QString(), QStringLiteral("https://github.com/ProtonDriveApps/sdk"));
    about.setHomepage(QStringLiteral("https://github.com/hleroy/kation"));
    about.setBugAddress(QByteArrayLiteral("https://github.com/hleroy/kation/issues"));
    about.setOrganizationDomain("hleroy.com");
    about.setDesktopFileName(QStringLiteral("com.hleroy.Kation"));
    about.setOtherText(i18n("This is a third-party application not officially supported by Proton."));
    return about;
}

QString displayVersion(const QString &reported)
{
    if (reported.isEmpty()) {
        return i18nc("version", "Unknown");
    }
    static const QRegularExpression pattern(QStringLiteral("^(?:([\\w-]+)@)?(\\d+\\.\\d+\\.\\d+(?:-[\\w.-]+)?)(?:\\+(\\w+))?$"));
    const QRegularExpressionMatch match = pattern.match(reported);
    if (!match.hasMatch()) {
        return reported;
    }
    QString version = match.captured(2);
    // kationd appends Proton's release channel to Kation's version (daemon/scripts/versions.ts).
    if (match.captured(1).startsWith(QLatin1String("external-drive-"))) {
        static const QRegularExpression channel(QStringLiteral("-(?:alpha|beta|stable)$"));
        version.remove(channel);
    }
    // Built without git, the commit is "unknown".
    const QString commit = match.captured(3);
    return commit.isEmpty() || commit == QLatin1String("unknown") ? version : i18nc("version (commit)", "%1 (%2)", version, commit);
}

QString logFilePath()
{
    // Matches kationd's getConfig(); QStandardPaths has no state location before Qt 6.7.
    QString state = qEnvironmentVariable("XDG_STATE_HOME");
    if (state.isEmpty()) {
        state = QDir::homePath() + QStringLiteral("/.local/state");
    }
    return state + QStringLiteral("/kation/kationd.log");
}
}
