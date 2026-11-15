// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include "kationabout.h"
#include "kationtypes.h"
#include "selfupdate.h"
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
#include <QProcess>
#include <QSessionManager>
#include <QTimer>

int main(int argc, char **argv)
{
    QApplication app(argc, argv);
    // The tray keeps running when the window is closed.
    app.setQuitOnLastWindowClosed(false);
    KLocalizedString::setApplicationDomain("kation");

    KAboutData about = Kation::aboutData();
    KAboutData::setApplicationData(about);
    QApplication::setWindowIcon(QIcon::fromTheme(QStringLiteral("com.hleroy.Kation")));

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

    // After a package upgrade, start the new version in the tray and quit, but not
    // under the user's eyes: while the window is open, when it closes.
    Kation::DeferredRelaunch relauncher([&service] {
        // The new instance must be able to take the unique name.
        service.unregister();
        if (QProcess::startDetached(Kation::executablePath(), {QStringLiteral("--tray")})) {
            QCoreApplication::quit();
        } else {
            qWarning("Could not start the updated Kation; it runs at the next login");
        }
    });

    QPointer<KationSettingsWidget> window;
    const auto showWindow = [&window, &relauncher] {
        if (!window) {
            window = new KationSettingsWidget;
            relauncher.setWindow(window);
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
    QObject::connect(&tray, &KationTray::updateInstalled, &app, [&relauncher] {
        // The package manager may still be finishing the upgrade.
        QTimer::singleShot(5000, &relauncher, &Kation::DeferredRelaunch::request);
    });
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
