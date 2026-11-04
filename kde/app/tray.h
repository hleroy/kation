// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <QList>
#include <QObject>
#include <QSet>
#include <QStringList>
#include <QUrl>
#include <QVariantMap>

#include <functional>

class KationDriveInterface;
class KStatusNotifierItem;
class QAction;
class QMenu;
class QTimer;

/**
 * The system tray icon: sync status at a glance, pause and resume, recent
 * activity, and notifications for problems and conflicts.
 */
class KationTray : public QObject
{
    Q_OBJECT

public:
    explicit KationTray(QObject *parent = nullptr);

    /// For tests: the context menu, the status text shown in the tooltip, and the
    /// tray icon's name (one of the kation-tray* icons).
    QMenu *menu() const;
    QString statusText() const;
    QString iconName() const;

Q_SIGNALS:
    void settingsRequested();
    /// Emitted with each notification sent (event ID from kation.notifyrc, and its text).
    void notified(const QString &eventId, const QString &text);

private:
    void refresh();
    void showStatus(const QVariantMap &status);
    void showSyncStatus(const QVariantMap &status);
    void addActivity(const QVariantMap &activity);
    void update();
    void updateActivityMenu();
    void flushConflicts();
    void notify(const QString &eventId, const QString &title, const QString &text, const QString &actionText = {}, const std::function<void()> &action = {});
    void openSyncedFolder();
    void openUrl(const QUrl &url);
    void showInFileManager(const QString &localPath);
    void updateFolderIcon();

    KationDriveInterface *m_drive;
    KStatusNotifierItem *m_item;
    QMenu *m_menu;
    QAction *m_statusAction;
    QAction *m_openFolder;
    QAction *m_openOnline;
    QAction *m_pause;
    QAction *m_syncNow;
    QAction *m_signIn;
    QMenu *m_activityMenu;

    bool m_reachable = false;
    QVariantMap m_status;
    QVariantMap m_syncStatus;
    QList<QVariantMap> m_activity;
    QStringList m_pendingConflicts;
    QTimer *m_conflictTimer;
    /// Messages already notified, so a lasting problem is notified once.
    QSet<QString> m_notifiedProblems;
    /// The sync folder whose icon was last set, and whether sync was on.
    QString m_iconFolder;
    bool m_iconOn = false;
};
