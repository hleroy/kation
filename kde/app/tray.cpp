// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include "tray.h"
#include "kationdriveinterface.h"
#include "kationtexts.h"
#include "kationtypes.h"

#include <KConfig>
#include <KConfigGroup>
#include <KIO/JobUiDelegateFactory>
#include <KIO/OpenFileManagerWindowJob>
#include <KIO/OpenUrlJob>
#include <KLocalizedString>
#include <KNotification>
#include <KStatusNotifierItem>

#include <QAction>
#include <QDBusPendingCallWatcher>
#include <QDBusPendingReply>
#include <QDBusServiceWatcher>
#include <QDateTime>
#include <QFile>
#include <QFileInfo>
#include <QLocale>
#include <QMenu>
#include <QTextDocument>
#include <QTimer>

namespace
{
constexpr int MaxActivityShown = 10;

QString activityText(const QVariantMap &activity)
{
    const QString name = QFileInfo(activity.value(QStringLiteral("path")).toString()).fileName();
    const QString kind = activity.value(QStringLiteral("kind")).toString();
    if (kind == QLatin1String("uploaded")) {
        return i18nc("recent activity", "Uploaded %1", name);
    }
    if (kind == QLatin1String("downloaded")) {
        return i18nc("recent activity", "Downloaded %1", name);
    }
    if (kind == QLatin1String("trashedRemote")) {
        return i18nc("recent activity", "Moved %1 to the Proton Drive trash", name);
    }
    if (kind == QLatin1String("trashedLocal")) {
        return i18nc("recent activity", "Moved %1 to the Trash", name);
    }
    if (kind == QLatin1String("conflict")) {
        return i18nc("recent activity", "Kept both versions of %1", name);
    }
    if (kind == QLatin1String("skipped")) {
        return i18nc("recent activity", "Not synced, its name is too long: %1", name);
    }
    return i18nc("recent activity", "Could not sync %1", name);
}

QString activityIcon(const QString &kind)
{
    if (kind == QLatin1String("uploaded")) {
        return QStringLiteral("cloud-upload");
    }
    if (kind == QLatin1String("downloaded")) {
        return QStringLiteral("cloud-download");
    }
    if (kind == QLatin1String("trashedRemote") || kind == QLatin1String("trashedLocal")) {
        return QStringLiteral("user-trash");
    }
    if (kind == QLatin1String("conflict")) {
        return QStringLiteral("document-duplicate");
    }
    if (kind == QLatin1String("skipped")) {
        return QStringLiteral("dialog-warning");
    }
    return QStringLiteral("dialog-error");
}
}

KationTray::KationTray(QObject *parent)
    : QObject(parent)
    , m_drive(new KationDriveInterface(Kation::serviceName, Kation::objectPath, QDBusConnection::sessionBus(), this))
    , m_item(new KStatusNotifierItem(QStringLiteral("kation"), this))
    , m_menu(new QMenu)
    , m_conflictTimer(new QTimer(this))
{
    m_item->setCategory(KStatusNotifierItem::ApplicationStatus);
    m_item->setTitle(i18n("Kation"));

    m_statusAction = m_menu->addAction(QString());
    m_statusAction->setEnabled(false);
    m_menu->addSeparator();
    m_signIn = m_menu->addAction(QIcon::fromTheme(QStringLiteral("im-user-online")), i18n("Sign In…"), this, &KationTray::settingsRequested);
    m_openFolder = m_menu->addAction(QIcon::fromTheme(QStringLiteral("kation-folder")), i18n("Open Synced Folder"), this, &KationTray::openSyncedFolder);
    m_openOnline = m_menu->addAction(QIcon::fromTheme(QStringLiteral("folder-remote")), i18n("Open Online View"), this, [this] {
        openUrl(QUrl(QStringLiteral("protondrive:/")));
    });
    m_menu->addSeparator();
    m_pause = m_menu->addAction(QString(), this, [this] {
        const bool paused =
            m_syncStatus.value(QStringLiteral("paused")).toBool() || m_syncStatus.value(QStringLiteral("state")).toString() == QLatin1String("paused");
        m_drive->SetSyncPaused(!paused);
    });
    m_syncNow = m_menu->addAction(QIcon::fromTheme(QStringLiteral("view-refresh")), i18n("Sync Now"), this, [this] {
        m_drive->SyncNow();
    });
    m_activityMenu = m_menu->addMenu(QIcon::fromTheme(QStringLiteral("view-history")), i18n("Recent Activity"));
    m_menu->addSeparator();
    m_menu->addAction(QIcon::fromTheme(QStringLiteral("configure")), i18n("Settings…"), this, &KationTray::settingsRequested);
    m_item->setContextMenu(m_menu);
    m_item->setStandardActionsEnabled(true);

    m_statusAction->setObjectName(QStringLiteral("status"));
    m_signIn->setObjectName(QStringLiteral("signIn"));
    m_openFolder->setObjectName(QStringLiteral("openFolder"));
    m_openOnline->setObjectName(QStringLiteral("openOnline"));
    m_pause->setObjectName(QStringLiteral("pause"));
    m_syncNow->setObjectName(QStringLiteral("syncNow"));
    m_activityMenu->setObjectName(QStringLiteral("activity"));

    connect(m_item, &KStatusNotifierItem::activateRequested, this, &KationTray::settingsRequested);
    connect(m_drive, &KationDriveInterface::StatusChanged, this, &KationTray::showStatus);
    connect(m_drive, &KationDriveInterface::SyncStatusChanged, this, &KationTray::showSyncStatus);
    connect(m_drive, &KationDriveInterface::SyncActivity, this, &KationTray::addActivity);
    // kationd restarted (for example after an update): read everything again.
    auto watcher = new QDBusServiceWatcher(Kation::serviceName, QDBusConnection::sessionBus(), QDBusServiceWatcher::WatchForOwnerChange, this);
    connect(watcher, &QDBusServiceWatcher::serviceRegistered, this, &KationTray::refresh);
    connect(watcher, &QDBusServiceWatcher::serviceUnregistered, this, [this] {
        m_reachable = false;
        update();
    });

    m_conflictTimer->setSingleShot(true);
    m_conflictTimer->setInterval(3000);
    connect(m_conflictTimer, &QTimer::timeout, this, &KationTray::flushConflicts);

    update();
    refresh();
}

QMenu *KationTray::menu() const
{
    return m_menu;
}

QString KationTray::iconName() const
{
    return m_item->iconName();
}

void KationTray::refresh()
{
    auto status = new QDBusPendingCallWatcher(m_drive->GetStatus(), this);
    connect(status, &QDBusPendingCallWatcher::finished, this, [this, status] {
        status->deleteLater();
        QDBusPendingReply<QVariantMap> reply = *status;
        m_reachable = !reply.isError();
        if (m_reachable) {
            showStatus(reply.value());
        } else {
            update();
        }
    });
    auto activity = new QDBusPendingCallWatcher(m_drive->GetRecentActivity(), this);
    connect(activity, &QDBusPendingCallWatcher::finished, this, [this, activity] {
        activity->deleteLater();
        QDBusPendingReply<QVariantMapList> reply = *activity;
        if (!reply.isError()) {
            m_activity = reply.value().mid(0, MaxActivityShown);
            updateActivityMenu();
        }
    });
}

void KationTray::showStatus(const QVariantMap &status)
{
    const bool wasLoggedIn = m_status.value(QStringLiteral("loggedIn")).toBool();
    m_status = status;
    m_reachable = true;
    const bool loggedIn = status.value(QStringLiteral("loggedIn")).toBool();
    const QString problem = Kation::problemText(status);
    if (wasLoggedIn && !loggedIn && !problem.isEmpty()) {
        notify(QStringLiteral("sessionEnded"), i18n("Signed out of Proton Drive"), problem, i18n("Sign In…"), [this] {
            Q_EMIT settingsRequested();
        });
    }
    if (loggedIn) {
        auto watcher = new QDBusPendingCallWatcher(m_drive->GetSyncStatus(), this);
        connect(watcher, &QDBusPendingCallWatcher::finished, this, [this, watcher] {
            watcher->deleteLater();
            QDBusPendingReply<QVariantMap> reply = *watcher;
            if (!reply.isError()) {
                showSyncStatus(reply.value());
            }
        });
    }
    update();
}

void KationTray::showSyncStatus(const QVariantMap &status)
{
    const QString previousState = m_syncStatus.value(QStringLiteral("state")).toString();
    m_syncStatus = status;
    const QString state = status.value(QStringLiteral("state")).toString();
    const QString message = Kation::syncReasonText(status);

    if (state == QLatin1String("error") && previousState != state && !m_notifiedProblems.contains(message)) {
        m_notifiedProblems.insert(message);
        notify(QStringLiteral("syncError"), i18n("Some files could not be synced"), message, i18n("Open Settings"), [this] {
            Q_EMIT settingsRequested();
        });
    }
    // A pause Kation decided for safety (mass deletion, missing folder), not one the user asked for.
    if (Kation::isSafetyPause(status) && !m_notifiedProblems.contains(message)) {
        m_notifiedProblems.insert(message);
        notify(QStringLiteral("syncPaused"), i18n("Sync paused"), message, i18n("Open Settings"), [this] {
            Q_EMIT settingsRequested();
        });
    }
    if (state == QLatin1String("idle")) {
        // Notify again if the same problem comes back later.
        m_notifiedProblems.clear();
    }
    updateFolderIcon();
    update();
}

namespace
{
const QString folderIcon = QStringLiteral("kation-folder");

/// Sets or clears the folder's icon in its .directory file, as Dolphin's "Change Icon…" does.
/// kationd does not sync .directory files; an icon the user chose is left alone.
/// Returns false when the folder does not exist (yet).
bool setFolderIcon(const QString &folder, bool on)
{
    if (!QFileInfo(folder).isDir()) {
        return false;
    }
    const QString path = folder + QStringLiteral("/.directory");
    {
        KConfig directory(path, KConfig::SimpleConfig);
        KConfigGroup entry = directory.group(QStringLiteral("Desktop Entry"));
        const QString icon = entry.readEntry("Icon");
        if (on && icon.isEmpty()) {
            entry.writeEntry("Icon", folderIcon);
        } else if (!on && icon == folderIcon) {
            entry.deleteEntry("Icon");
        } else {
            return true;
        }
        directory.sync();
    }
    if (QFileInfo(path).size() == 0) {
        QFile::remove(path);
    }
    return true;
}
}

void KationTray::updateFolderIcon()
{
    const QString folder = m_syncStatus.value(QStringLiteral("folder")).toString();
    const bool on = m_syncStatus.value(QStringLiteral("enabled")).toBool();
    if (folder == m_iconFolder && on == m_iconOn) {
        return;
    }
    if (!m_iconFolder.isEmpty() && m_iconFolder != folder) {
        setFolderIcon(m_iconFolder, false);
    }
    // kationd reports sync as on before it creates the folder: the next status tries again.
    m_iconFolder = folder.isEmpty() || setFolderIcon(folder, on) ? folder : QString();
    m_iconOn = on;
}

void KationTray::addActivity(const QVariantMap &activity)
{
    m_activity.prepend(activity);
    if (m_activity.size() > MaxActivityShown) {
        m_activity.removeLast();
    }
    updateActivityMenu();
    if (activity.value(QStringLiteral("kind")).toString() == QLatin1String("conflict")) {
        m_pendingConflicts.append(activity.value(QStringLiteral("localPath")).toString());
        // Several conflicts at once (e.g. after a pause) make one notification.
        m_conflictTimer->start();
    }
}

void KationTray::flushConflicts()
{
    if (m_pendingConflicts.isEmpty()) {
        return;
    }
    const QStringList conflicts = std::exchange(m_pendingConflicts, {});
    const QString first = conflicts.first();
    const QString text = conflicts.size() == 1
        ? i18n("%1 was changed both here and in Proton Drive. Both versions are kept; your version was renamed with “conflict” in its name.",
               QFileInfo(first).fileName())
        : i18np("%1 file was changed both here and in Proton Drive.", "%1 files were changed both here and in Proton Drive.", conflicts.size())
            + QLatin1Char(' ') + i18n("Both versions are kept; yours were renamed with “conflict” in their names.");
    notify(QStringLiteral("conflict"), i18n("Kept both versions"), text, i18n("Show in Folder"), [this, first] {
        showInFileManager(first);
    });
}

QString KationTray::statusText() const
{
    if (!m_reachable) {
        return i18n("The Kation background service is not available");
    }
    if (!m_status.value(QStringLiteral("loggedIn")).toBool()) {
        return m_status.value(QStringLiteral("loginPending")).toBool() ? i18n("Waiting for sign-in…") : i18n("Not signed in");
    }
    if (!m_syncStatus.value(QStringLiteral("enabled")).toBool()) {
        return i18n("Sync is off");
    }
    const QString state = m_syncStatus.value(QStringLiteral("state")).toString();
    const QString message = Kation::syncReasonText(m_syncStatus);
    if (state == QLatin1String("syncing")) {
        const QString current = m_syncStatus.value(QStringLiteral("current")).toString();
        return current.isEmpty() ? i18n("Syncing…") : i18n("Syncing %1…", QFileInfo(current).fileName());
    }
    if (state == QLatin1String("paused")) {
        return message.isEmpty() ? i18n("Sync paused") : i18n("Sync paused: %1", message);
    }
    if (state == QLatin1String("error")) {
        return i18n("Problem: %1", message);
    }
    if (state == QLatin1String("idle")) {
        return i18n("Up to date");
    }
    return message.isEmpty() ? i18n("Starting…") : message;
}

void KationTray::update()
{
    const bool loggedIn = m_reachable && m_status.value(QStringLiteral("loggedIn")).toBool();
    const bool syncOn = loggedIn && m_syncStatus.value(QStringLiteral("enabled")).toBool();
    const QString state = m_syncStatus.value(QStringLiteral("state")).toString();
    const bool paused = syncOn && (m_syncStatus.value(QStringLiteral("paused")).toBool() || state == QLatin1String("paused"));

    // Plasma's system tray does not draw overlay icons, so each state has its own
    // icon (kde/icons): the K and cloud in the panel's text colour with a state badge.
    QString icon = QStringLiteral("kation-tray");
    KStatusNotifierItem::ItemStatus itemStatus = KStatusNotifierItem::Active;
    if (!loggedIn) {
        icon = QStringLiteral("kation-tray-offline");
    } else if (!syncOn) {
        // Plain cloud.
    } else if (state == QLatin1String("error")) {
        icon = QStringLiteral("kation-tray-error");
        itemStatus = KStatusNotifierItem::NeedsAttention;
    } else if (paused) {
        icon = QStringLiteral("kation-tray-paused");
        if (Kation::isSafetyPause(m_syncStatus)) {
            itemStatus = KStatusNotifierItem::NeedsAttention;
        }
    } else if (state == QLatin1String("syncing")) {
        icon = QStringLiteral("kation-tray-sync");
    } else if (state == QLatin1String("idle")) {
        icon = QStringLiteral("kation-tray-ok");
    }
    m_item->setIconByName(icon);
    // Shown instead of the icon while the status needs attention.
    m_item->setAttentionIconByName(icon);
    m_item->setStatus(itemStatus);
    // Plasma guesses the tooltip's format; the status holds file names and kationd's messages.
    m_item->setToolTip(icon, i18n("Kation"), Qt::convertFromPlainText(statusText(), Qt::WhiteSpaceNormal));

    m_statusAction->setText(statusText());
    m_signIn->setVisible(m_reachable && !loggedIn);
    m_openFolder->setVisible(syncOn);
    m_openOnline->setVisible(loggedIn);
    m_pause->setVisible(syncOn);
    m_pause->setText(paused ? i18n("Resume Sync") : i18n("Pause Sync"));
    m_pause->setIcon(QIcon::fromTheme(paused ? QStringLiteral("media-playback-start") : QStringLiteral("media-playback-pause")));
    m_syncNow->setVisible(syncOn && !paused);
    m_activityMenu->menuAction()->setVisible(loggedIn);
}

void KationTray::updateActivityMenu()
{
    m_activityMenu->clear();
    if (m_activity.isEmpty()) {
        m_activityMenu->addAction(i18n("Nothing synced yet"))->setEnabled(false);
        return;
    }
    for (const QVariantMap &activity : std::as_const(m_activity)) {
        const QString kind = activity.value(QStringLiteral("kind")).toString();
        const QString localPath = activity.value(QStringLiteral("localPath")).toString();
        const QDateTime time = QDateTime::fromSecsSinceEpoch(activity.value(QStringLiteral("time")).toLongLong());
        auto action = m_activityMenu->addAction(QIcon::fromTheme(activityIcon(kind)), activityText(activity), this, [this, kind, localPath] {
            if (kind == QLatin1String("trashedLocal")) {
                openUrl(QUrl(QStringLiteral("trash:/")));
            } else {
                showInFileManager(localPath);
            }
        });
        QString tip = activity.value(QStringLiteral("path")).toString() + QLatin1Char('\n') + QLocale().toString(time, QLocale::ShortFormat);
        // A skipped item's detail is a code, already worded by activityText().
        const QString detail = kind == QLatin1String("skipped") ? QString() : activity.value(QStringLiteral("detail")).toString();
        if (!detail.isEmpty()) {
            tip += QLatin1Char('\n') + detail;
        }
        // Tooltips detect rich text: make it rich text, with the path escaped.
        action->setToolTip(Qt::convertFromPlainText(tip));
    }
}

void KationTray::notify(const QString &eventId, const QString &title, const QString &text, const QString &actionText, const std::function<void()> &action)
{
    auto notification = new KNotification(eventId, KNotification::CloseOnTimeout);
    notification->setComponentName(QStringLiteral("kation"));
    notification->setTitle(title);
    notification->setText(text.toHtmlEscaped());
    notification->setIconName(QStringLiteral("com.hleroy.Kation"));
    if (action) {
        auto notificationAction = notification->addAction(actionText);
        connect(notificationAction, &KNotificationAction::activated, this, action);
    }
    notification->sendEvent();
    Q_EMIT notified(eventId, text);
}

void KationTray::openSyncedFolder()
{
    openUrl(QUrl::fromLocalFile(m_syncStatus.value(QStringLiteral("folder")).toString()));
}

void KationTray::openUrl(const QUrl &url)
{
    auto job = new KIO::OpenUrlJob(url, QStringLiteral("inode/directory"));
    job->setUiDelegate(KIO::createDefaultJobUiDelegate(KJobUiDelegate::AutoHandlingEnabled, nullptr));
    job->start();
}

void KationTray::showInFileManager(const QString &localPath)
{
    QFileInfo info(localPath);
    if (info.exists()) {
        KIO::highlightInFileManager({QUrl::fromLocalFile(localPath)});
    } else {
        openUrl(QUrl::fromLocalFile(info.absolutePath()));
    }
}
