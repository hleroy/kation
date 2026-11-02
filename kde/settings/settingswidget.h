// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <QDBusPendingCall>
#include <QSet>
#include <QUrl>
#include <QVariantMap>
#include <QWidget>

class KationDriveInterface;
class QCheckBox;
class QGroupBox;
class QLabel;
class QPushButton;
class QSpinBox;
class QTabWidget;
class QTimer;
class QTreeWidget;
class QTreeWidgetItem;

/**
 * Kation settings: account, folder sync, folders to sync, speed limits and
 * startup. Used by the System Settings module and by the Kation window.
 *
 * Signing in and out, and turning sync on, off or pausing it, act at once.
 * The other settings follow the System Settings model: changed() when they
 * differ from what is saved, save() to apply them. With setAutoSave(true)
 * (the Kation window) they are applied as soon as they change.
 */
class KationSettingsWidget : public QWidget
{
    Q_OBJECT

public:
    explicit KationSettingsWidget(QWidget *parent = nullptr);

    void setAutoSave(bool autoSave);
    /// Whether some settings differ from the saved ones.
    bool hasChanges() const;
    void load();
    void save();
    void defaults();

Q_SIGNALS:
    void changed(bool hasChanges);

protected:
    void resizeEvent(QResizeEvent *event) override;

private:
    void buildGeneralTab(QWidget *tab);
    void buildFoldersTab(QWidget *tab);
    void buildAdvancedTab(QWidget *tab);
    /// Grows the window so wrapped text and buttons are never cut off.
    void fitToContents();

    void refresh();
    void showStatus(const QVariantMap &status);
    void showError(const QString &message);
    void signIn();
    void cancelSignIn();
    void signOut();
    void openFiles();
    void openUrl(const QUrl &url);
    void refreshSync();
    void showSyncStatus(const QVariantMap &status);
    void toggleSync();
    void togglePause();
    void chooseFolder();
    /// Runs a call and shows its error, if any.
    void call(const QDBusPendingCall &pending);

    // Folders to sync
    void loadFolderTree();
    void loadChildren(QTreeWidgetItem *parent, const QString &path);
    void folderToggled(QTreeWidgetItem *item);
    void updateFolderItems(QTreeWidgetItem *root = nullptr);
    bool isExcluded(const QString &path) const;
    bool hasExcludedAncestor(const QString &path) const;

    void settingsEdited();

    KationDriveInterface *m_drive;
    QTabWidget *m_tabs;
    QLabel *m_state;
    QLabel *m_details;
    QLabel *m_notice;
    QLabel *m_online;
    QPushButton *m_signIn;
    QPushButton *m_cancel;
    QPushButton *m_signOut;
    QPushButton *m_openFiles;
    QPushButton *m_copyLink;
    QString m_signInUrl;
    bool m_loggedIn = false;
    bool m_fitting = false;

    QGroupBox *m_syncBox;
    QLabel *m_syncFolder;
    QLabel *m_syncState;
    QPushButton *m_syncToggle;
    QPushButton *m_syncPause;
    QPushButton *m_syncChooseFolder;
    QVariantMap m_syncStatus;

    QLabel *m_foldersHint;
    QTreeWidget *m_folders;
    bool m_treeLoaded = false;
    bool m_updatingTree = false;

    QCheckBox *m_limitUpload;
    QSpinBox *m_uploadLimit;
    QCheckBox *m_limitDownload;
    QSpinBox *m_downloadLimit;
    QCheckBox *m_trayAtLogin;

    // Saved values (from kationd and kationrc) and the edited ones.
    QSet<QString> m_savedExcluded;
    QSet<QString> m_excluded;
    uint m_savedUploadLimit = 0;
    uint m_savedDownloadLimit = 0;
    bool m_savedTrayAtLogin = true;
    bool m_settingsLoaded = false;
    bool m_loading = false;
    bool m_autoSave = false;
    QTimer *m_autoSaveTimer;
};
