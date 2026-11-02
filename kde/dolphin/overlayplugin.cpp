// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include "kationdriveinterface.h"
#include "kationtypes.h"

#include <KOverlayIconPlugin>

#include <QDBusConnectionInterface>
#include <QDBusPendingCallWatcher>
#include <QDBusPendingReply>
#include <QDBusServiceWatcher>
#include <QHash>
#include <QSet>
#include <QTimer>

/**
 * Sync state emblems on files in the synced folder, in Dolphin and file
 * dialogs. States come from kationd, which answers from local data; the
 * plugin never starts kationd itself.
 */
class KationOverlayPlugin : public KOverlayIconPlugin
{
    Q_OBJECT
    Q_PLUGIN_METADATA(IID "org.kde.overlayicon.kation" FILE "kationoverlay.json")

public:
    explicit KationOverlayPlugin(QObject *parent = nullptr)
        : KOverlayIconPlugin(parent)
        , m_drive(new KationDriveInterface(Kation::serviceName, Kation::objectPath, QDBusConnection::sessionBus(), this))
    {
        Kation::registerDBusTypes();
        m_timer.setSingleShot(true);
        m_timer.setInterval(100);
        connect(&m_timer, &QTimer::timeout, this, &KationOverlayPlugin::requestStates);
        connect(m_drive, &KationDriveInterface::SyncStatusChanged, this, &KationOverlayPlugin::setSyncStatus);
        connect(m_drive, &KationDriveInterface::ItemStatesChanged, this, &KationOverlayPlugin::statesChanged);
        auto watcher = new QDBusServiceWatcher(Kation::serviceName, QDBusConnection::sessionBus(), QDBusServiceWatcher::WatchForOwnerChange, this);
        connect(watcher, &QDBusServiceWatcher::serviceRegistered, this, &KationOverlayPlugin::refreshSyncStatus);
        connect(watcher, &QDBusServiceWatcher::serviceUnregistered, this, [this] {
            setSyncStatus({});
        });
        if (QDBusConnection::sessionBus().interface()->isServiceRegistered(Kation::serviceName)) {
            refreshSyncStatus();
        }
    }

    QStringList getOverlays(const QUrl &url) override
    {
        if (!url.isLocalFile()) {
            return {};
        }
        const QString path = normalized(url.toLocalFile());
        if (m_folder.isEmpty()) {
            // Asked before kationd said where the synced folder is: answer once it has.
            if (m_statusPending && m_early.size() < 10000) {
                m_early.insert(path);
            }
            return {};
        }
        if (path != m_folder && !path.startsWith(m_folder + QLatin1Char('/'))) {
            return {};
        }
        const auto cached = m_states.constFind(path);
        if (cached != m_states.cend()) {
            return emblems(*cached);
        }
        queue(path);
        return {};
    }

private:
    static QString normalized(QString path)
    {
        while (path.size() > 1 && path.endsWith(QLatin1Char('/'))) {
            path.chop(1);
        }
        return path;
    }

    static QStringList emblems(const QString &state)
    {
        if (state == QLatin1String("synced")) {
            return {QStringLiteral("emblem-checked")};
        }
        if (state == QLatin1String("syncing") || state == QLatin1String("pending")) {
            // Kation's own (kde/icons): Breeze has no emblem-synchronizing.
            return {QStringLiteral("kation-emblem-syncing")};
        }
        if (state == QLatin1String("paused")) {
            return {QStringLiteral("emblem-pause")};
        }
        if (state == QLatin1String("error")) {
            return {QStringLiteral("emblem-error")};
        }
        if (state == QLatin1String("excluded")) {
            return {QStringLiteral("emblem-unavailable")};
        }
        return {};
    }

    void refreshSyncStatus()
    {
        m_statusPending = true;
        auto watcher = new QDBusPendingCallWatcher(m_drive->GetSyncStatus(), this);
        connect(watcher, &QDBusPendingCallWatcher::finished, this, [this, watcher] {
            watcher->deleteLater();
            m_statusPending = false;
            QDBusPendingReply<QVariantMap> reply = *watcher;
            if (!reply.isError()) {
                setSyncStatus(reply.value());
            }
            const QSet<QString> early = std::exchange(m_early, {});
            for (const QString &path : early) {
                if (!m_folder.isEmpty() && (path == m_folder || path.startsWith(m_folder + QLatin1Char('/')))) {
                    queue(path);
                }
            }
        });
    }

    void setSyncStatus(const QVariantMap &status)
    {
        const QString folder = status.value(QStringLiteral("enabled")).toBool() ? normalized(status.value(QStringLiteral("folder")).toString()) : QString();
        if (folder == m_folder) {
            return;
        }
        // Sync turned off or moved: remove the emblems shown so far.
        const QStringList shown = m_states.keys();
        m_states.clear();
        m_queue.clear();
        m_folder = folder;
        for (const QString &path : shown) {
            Q_EMIT overlaysChanged(QUrl::fromLocalFile(path), {});
        }
    }

    void statesChanged(const QStringList &paths)
    {
        if (paths.isEmpty()) {
            for (auto it = m_states.cbegin(); it != m_states.cend(); ++it) {
                queue(it.key());
            }
            return;
        }
        for (const QString &changed : paths) {
            // A folder's state sums up its contents: ask again for the folders above too.
            QString path = normalized(changed);
            while (path.size() >= m_folder.size() && !m_folder.isEmpty()) {
                if (m_states.contains(path)) {
                    queue(path);
                }
                const int slash = path.lastIndexOf(QLatin1Char('/'));
                if (slash <= 0) {
                    break;
                }
                path.truncate(slash);
            }
        }
    }

    void queue(const QString &path)
    {
        m_queue.insert(path);
        if (!m_timer.isActive()) {
            m_timer.start();
        }
    }

    void requestStates()
    {
        if (m_queue.isEmpty() || m_folder.isEmpty()) {
            return;
        }
        const QStringList paths(m_queue.cbegin(), m_queue.cend());
        m_queue.clear();
        auto watcher = new QDBusPendingCallWatcher(m_drive->GetItemStates(paths), this);
        connect(watcher, &QDBusPendingCallWatcher::finished, this, [this, watcher] {
            watcher->deleteLater();
            QDBusPendingReply<QVariantMap> reply = *watcher;
            if (reply.isError()) {
                return;
            }
            const QVariantMap states = reply.value();
            for (auto it = states.cbegin(); it != states.cend(); ++it) {
                const QString state = it.value().toString();
                const auto previous = m_states.constFind(it.key());
                if (previous != m_states.cend() && *previous == state) {
                    continue;
                }
                m_states.insert(it.key(), state);
                Q_EMIT overlaysChanged(QUrl::fromLocalFile(it.key()), emblems(state));
            }
        });
    }

    KationDriveInterface *m_drive;
    /// The synced folder while sync is on, otherwise empty.
    QString m_folder;
    QHash<QString, QString> m_states;
    bool m_statusPending = false;
    QSet<QString> m_early;
    QSet<QString> m_queue;
    QTimer m_timer;
};

#include "overlayplugin.moc"
