// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include "selfupdate.h"

#include <QFile>

#include <climits>
#include <sys/stat.h>
#include <unistd.h>

QString Kation::executablePath(const QString &procExe)
{
    char target[PATH_MAX];
    const ssize_t length = readlink(QFile::encodeName(procExe).constData(), target, sizeof(target) - 1);
    if (length <= 0) {
        return {};
    }
    QByteArray path(target, length);
    // The kernel marks a program file that was deleted or replaced since it started.
    const QByteArray deleted(" (deleted)");
    if (path.endsWith(deleted)) {
        path.chop(deleted.size());
    }
    return QFile::decodeName(path);
}

Kation::DeferredRelaunch::DeferredRelaunch(std::function<void()> relaunch, QObject *parent)
    : QObject(parent)
    , m_relaunch(std::move(relaunch))
{
}

void Kation::DeferredRelaunch::setWindow(QObject *window)
{
    if (!window || window == m_window) {
        return;
    }
    m_window = window;
    connect(window, &QObject::destroyed, this, [this, window] {
        // A QWidget emits destroyed() before its QPointers are cleared: do not read m_window here.
        if (m_window == window) {
            m_window.clear();
        }
        runIfReady();
    });
}

void Kation::DeferredRelaunch::request()
{
    m_requested = true;
    runIfReady();
}

void Kation::DeferredRelaunch::runIfReady()
{
    if (!m_requested || m_done || m_window) {
        return;
    }
    m_done = true;
    m_relaunch();
}

bool Kation::executableReplaced(const QString &procExe)
{
    const QString path = executablePath(procExe);
    struct stat running{};
    struct stat current{};
    // stat() of the /proc link is the program that runs, even when its file is gone.
    if (path.isEmpty() || stat(QFile::encodeName(procExe).constData(), &running) != 0 || stat(QFile::encodeName(path).constData(), &current) != 0) {
        return false;
    }
    return running.st_dev != current.st_dev || running.st_ino != current.st_ino;
}
