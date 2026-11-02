// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include "kationtypes.h"

#include <QDBusConnection>
#include <QDBusConnectionInterface>
#include <QProcess>
#include <QTemporaryDir>
#include <QTest>

/// Starts `kationd serve --fake-drive` on the test's session bus, with its files in a temporary folder.
class FakeKationd
{
public:
    explicit FakeKationd(const QTemporaryDir &home, const QProcessEnvironment &extra = {})
    {
        qputenv("XDG_CACHE_HOME", QFile::encodeName(home.filePath(QStringLiteral("cache"))));
        qputenv("XDG_DATA_HOME", QFile::encodeName(home.filePath(QStringLiteral("data"))));
        qputenv("XDG_STATE_HOME", QFile::encodeName(home.filePath(QStringLiteral("state"))));
        qputenv("XDG_CONFIG_HOME", QFile::encodeName(home.filePath(QStringLiteral("config"))));
        QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
        // The default sync folder lives in the home folder.
        env.insert(QStringLiteral("HOME"), home.path());
        env.insert(QStringLiteral("KATION_FAKE_SETTLE_MS"), QStringLiteral("0"));
        env.insert(extra);
        m_process.setProcessEnvironment(env);
        m_process.setProcessChannelMode(QProcess::ForwardedErrorChannel);
    }

    /// Returns false (with a test failure) if kationd does not come up.
    bool start()
    {
        if (!QDBusConnection::sessionBus().isConnected()) {
            qWarning("Run the test inside dbus-run-session");
            return false;
        }
        m_process.start(QStringLiteral(KATIOND_EXECUTABLE), {QStringLiteral("serve"), QStringLiteral("--fake-drive")});
        if (!m_process.waitForStarted()) {
            return false;
        }
        const bool registered = QTest::qWaitFor(
            [this] {
                return QDBusConnection::sessionBus().interface()->isServiceRegistered(Kation::serviceName) || m_process.state() == QProcess::NotRunning;
            },
            15000);
        if (!registered || m_process.state() != QProcess::Running) {
            qWarning("kationd did not register on the session bus");
            return false;
        }
        return true;
    }

    /// Stops kationd; returns whether it exited cleanly.
    bool stop()
    {
        if (m_process.state() == QProcess::NotRunning) {
            return false;
        }
        m_process.terminate();
        return m_process.waitForFinished(10000) && m_process.exitStatus() == QProcess::NormalExit && m_process.exitCode() == 0;
    }

private:
    QProcess m_process;
};
