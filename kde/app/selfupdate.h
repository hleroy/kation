// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <QObject>
#include <QPointer>
#include <QString>

#include <functional>

namespace Kation
{
/// The path a process was started from, read from its /proc/<pid>/exe link (still
/// given when the file was replaced since), or empty.
QString executablePath(const QString &procExe = QStringLiteral("/proc/self/exe"));

/// True when the file at that path is no longer the one the process runs: a package
/// upgrade put a new version there. False when the path is gone (package removed).
bool executableReplaced(const QString &procExe = QStringLiteral("/proc/self/exe"));

/// Runs `relaunch` once, after request(), but not while a window set with
/// setWindow() is open: then when it is destroyed.
class DeferredRelaunch : public QObject
{
public:
    explicit DeferredRelaunch(std::function<void()> relaunch, QObject *parent = nullptr);

    /// The window now open (it is watched until destroyed).
    void setWindow(QObject *window);
    /// An update was installed: relaunch now, or when the window is gone.
    void request();

private:
    void runIfReady();

    std::function<void()> m_relaunch;
    QPointer<QObject> m_window;
    bool m_requested = false;
    bool m_done = false;
};
}
