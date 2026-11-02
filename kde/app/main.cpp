// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include "kationtypes.h"
#include "settingswidget.h"
#include "tray.h"
#include "trayautostart.h"

#include <KAboutData>
#include <KDBusService>
#include <KLocalizedString>
#include <KWindowSystem>

#include <QApplication>
#include <QCommandLineParser>
#include <QPointer>
#include <QSessionManager>

int main(int argc, char **argv)
{
    QApplication app(argc, argv);
    // The tray keeps running when the window is closed.
    app.setQuitOnLastWindowClosed(false);
    KLocalizedString::setApplicationDomain("kation");

    KAboutData about(QStringLiteral("kation"),
                     i18n("Kation"),
                     QStringLiteral(KATION_VERSION_STRING),
                     i18n("Unofficial Proton Drive client for KDE Plasma"),
                     KAboutLicense::GPL_V2,
                     i18n("© 2026 Kation contributors"));
    about.setOrganizationDomain("hleroy.com");
    about.setDesktopFileName(QStringLiteral("com.hleroy.Kation"));
    about.setOtherText(i18n("This is a third-party application not officially supported by Proton."));
    KAboutData::setApplicationData(about);
    QApplication::setWindowIcon(QIcon::fromTheme(QStringLiteral("folder-cloud")));

    QCommandLineParser parser;
    const QCommandLineOption trayOption(QStringLiteral("tray"), i18n("Start in the system tray without opening the window"));
    parser.addOption(trayOption);
    about.setupCommandLine(&parser);
    parser.process(app);
    about.processCommandLine(&parser);

    // One instance: starting Kation again opens the window of the running one.
    KDBusService service(KDBusService::Unique);

#if QT_CONFIG(sessionmanager)
    // Not reopened by session restore: the tray starts at login by itself (autostart entry).
    QObject::connect(&app, &QGuiApplication::saveStateRequest, &app, [](QSessionManager &manager) {
        manager.setRestartHint(QSessionManager::RestartNever);
    });
#endif

    Kation::registerDBusTypes();
    Kation::applyTrayAutostart();

    QPointer<KationSettingsWidget> window;
    const auto showWindow = [&window] {
        if (!window) {
            window = new KationSettingsWidget;
            window->setAttribute(Qt::WA_DeleteOnClose);
            window->setAutoSave(true);
            window->resize(560, 440);
        }
        window->show();
        window->raise();
        KWindowSystem::updateStartupId(window->windowHandle());
        KWindowSystem::activateWindow(window->windowHandle());
    };

    KationTray tray;
    QObject::connect(&tray, &KationTray::settingsRequested, &app, showWindow);
    QObject::connect(&service, &KDBusService::activateRequested, &app, [&](const QStringList &arguments, const QString &) {
        if (!arguments.contains(QStringLiteral("--tray"))) {
            showWindow();
        }
    });
    if (!parser.isSet(trayOption)) {
        showWindow();
    }
    return app.exec();
}
