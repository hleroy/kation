// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include "settingswidget.h"
#include "kationdriveinterface.h"
#include "kationtexts.h"
#include "kationtypes.h"
#include "trayautostart.h"

#include <KIO/JobUiDelegateFactory>
#include <KIO/OpenUrlJob>
#include <KLocalizedString>

#include <QCheckBox>
#include <QClipboard>
#include <QDBusPendingCallWatcher>
#include <QDBusPendingReply>
#include <QDateTime>
#include <QDesktopServices>
#include <QDir>
#include <QFileDialog>
#include <QFormLayout>
#include <QGroupBox>
#include <QGuiApplication>
#include <QHBoxLayout>
#include <QHeaderView>
#include <QLabel>
#include <QLocale>
#include <QPushButton>
#include <QScopedValueRollback>
#include <QSpinBox>
#include <QTabWidget>
#include <QTimer>
#include <QTreeWidget>
#include <QVBoxLayout>

namespace
{
constexpr int PathRole = Qt::UserRole;
constexpr int LoadedRole = Qt::UserRole + 1;
/// Largest speed limit kationd accepts, in KiB/s.
constexpr int MaxLimit = 1024 * 1024;

QString errorText(const QString &message)
{
    return QStringLiteral("<span style=\"color:#da4453\">%1</span>").arg(message.toHtmlEscaped());
}

QString childPath(const QString &parent, const QString &name)
{
    return parent == QLatin1String("/") ? QString(QLatin1Char('/') + name) : QString(parent + QLatin1Char('/') + name);
}

QWidget *wrapped(QLabel *label)
{
    label->setWordWrap(true);
    return label;
}
}

KationSettingsWidget::KationSettingsWidget(QWidget *parent)
    : QWidget(parent)
    , m_drive(new KationDriveInterface(Kation::serviceName, Kation::objectPath, QDBusConnection::sessionBus(), this))
    , m_tabs(new QTabWidget(this))
    , m_state(new QLabel(this))
    , m_details(new QLabel(this))
    , m_notice(new QLabel(i18n("This is a third-party application not officially supported by Proton."), this))
    , m_online(new QLabel(this))
    , m_signIn(new QPushButton(QIcon::fromTheme(QStringLiteral("im-user-online")), i18n("Sign In…"), this))
    , m_cancel(new QPushButton(QIcon::fromTheme(QStringLiteral("dialog-cancel")), i18n("Cancel"), this))
    , m_signOut(new QPushButton(QIcon::fromTheme(QStringLiteral("system-log-out")), i18n("Sign Out"), this))
    , m_openFiles(new QPushButton(QIcon::fromTheme(QStringLiteral("folder-cloud")), i18n("Open Files"), this))
    , m_copyLink(new QPushButton(QIcon::fromTheme(QStringLiteral("edit-copy")), i18n("Copy Link"), this))
    , m_syncBox(new QGroupBox(i18n("Folder Sync"), this))
    , m_syncFolder(new QLabel(m_syncBox))
    , m_syncState(new QLabel(m_syncBox))
    , m_syncToggle(new QPushButton(m_syncBox))
    , m_syncPause(new QPushButton(m_syncBox))
    , m_syncChooseFolder(new QPushButton(QIcon::fromTheme(QStringLiteral("folder-open")), i18n("Change Folder…"), m_syncBox))
    , m_foldersHint(new QLabel(this))
    , m_folders(new QTreeWidget(this))
    , m_limitUpload(new QCheckBox(i18n("Limit upload speed to:"), this))
    , m_uploadLimit(new QSpinBox(this))
    , m_limitDownload(new QCheckBox(i18n("Limit download speed to:"), this))
    , m_downloadLimit(new QSpinBox(this))
    , m_trayAtLogin(new QCheckBox(i18n("Show Kation in the system tray when I log in"), this))
    , m_autoSaveTimer(new QTimer(this))
{
    setWindowTitle(i18n("Kation"));
    setMinimumWidth(480);
    m_drive->setTimeout(120 * 1000);
    m_autoSaveTimer->setSingleShot(true);
    m_autoSaveTimer->setInterval(600);
    connect(m_autoSaveTimer, &QTimer::timeout, this, &KationSettingsWidget::save);

    m_tabs->setObjectName(QStringLiteral("tabs"));
    auto general = new QWidget(m_tabs);
    auto folders = new QWidget(m_tabs);
    auto advanced = new QWidget(m_tabs);
    buildGeneralTab(general);
    buildFoldersTab(folders);
    buildAdvancedTab(advanced);
    m_tabs->addTab(general, i18n("General"));
    m_tabs->addTab(folders, i18n("Folders to Sync"));
    m_tabs->addTab(advanced, i18n("Network and Startup"));

    auto layout = new QVBoxLayout(this);
    layout->setContentsMargins(0, 0, 0, 0);
    layout->addWidget(m_tabs);

    connect(m_drive, &KationDriveInterface::StatusChanged, this, &KationSettingsWidget::showStatus);
    connect(m_drive, &KationDriveInterface::SyncStatusChanged, this, &KationSettingsWidget::showSyncStatus);
    connect(m_drive, &KationDriveInterface::LoginFinished, this, [this](bool success, const QString &message) {
        if (!success && !message.isEmpty()) {
            showError(message);
        }
    });
    connect(m_tabs, &QTabWidget::currentChanged, this, [this] {
        if (m_tabs->currentIndex() == 1 && !m_treeLoaded && m_loggedIn) {
            loadFolderTree();
        }
    });

    m_state->setText(i18n("Connecting…"));
    m_signIn->hide();
    m_cancel->hide();
    m_signOut->hide();
    m_openFiles->hide();
    m_copyLink->hide();
    m_syncBox->hide();
    m_online->hide();
    m_savedTrayAtLogin = Kation::trayAtLogin();
    m_trayAtLogin->setChecked(m_savedTrayAtLogin);
    refresh();
}

void KationSettingsWidget::buildGeneralTab(QWidget *tab)
{
    m_state->setObjectName(QStringLiteral("state"));
    m_details->setObjectName(QStringLiteral("details"));
    m_signIn->setObjectName(QStringLiteral("signIn"));
    m_cancel->setObjectName(QStringLiteral("cancel"));
    m_signOut->setObjectName(QStringLiteral("signOut"));
    m_openFiles->setObjectName(QStringLiteral("openFiles"));
    m_copyLink->setObjectName(QStringLiteral("copyLink"));
    m_syncBox->setObjectName(QStringLiteral("syncBox"));
    m_syncFolder->setObjectName(QStringLiteral("syncFolder"));
    m_syncState->setObjectName(QStringLiteral("syncState"));
    m_syncToggle->setObjectName(QStringLiteral("syncToggle"));
    m_syncPause->setObjectName(QStringLiteral("syncPause"));
    m_syncChooseFolder->setObjectName(QStringLiteral("syncChooseFolder"));
    m_online->setObjectName(QStringLiteral("online"));
    m_notice->setObjectName(QStringLiteral("notice"));

    m_online->setWordWrap(true);
    m_online->setText(
        i18n("<a href=\"protondrive:/\">Online view</a>: your Proton Drive as it is on the server, browsable in Dolphin "
             "without downloading. Changes made there are sent immediately, even while sync is paused."));
    m_syncState->setWordWrap(true);
    m_syncFolder->setTextInteractionFlags(Qt::TextSelectableByMouse);

    QFont stateFont = m_state->font();
    stateFont.setPointSizeF(stateFont.pointSizeF() * 1.3);
    stateFont.setBold(true);
    m_state->setFont(stateFont);
    m_details->setWordWrap(true);
    m_details->setTextInteractionFlags(Qt::TextBrowserInteraction);
    m_notice->setWordWrap(true);
    QFont noticeFont = m_notice->font();
    noticeFont.setItalic(true);
    m_notice->setFont(noticeFont);

    auto buttons = new QHBoxLayout;
    buttons->addStretch();
    buttons->addWidget(m_copyLink);
    buttons->addWidget(m_openFiles);
    buttons->addWidget(m_cancel);
    buttons->addWidget(m_signOut);
    buttons->addWidget(m_signIn);

    auto syncButtons = new QHBoxLayout;
    syncButtons->addWidget(m_syncChooseFolder);
    syncButtons->addStretch();
    syncButtons->addWidget(m_syncPause);
    syncButtons->addWidget(m_syncToggle);
    auto syncLayout = new QVBoxLayout(m_syncBox);
    syncLayout->addWidget(m_syncFolder);
    syncLayout->addWidget(m_syncState);
    syncLayout->addLayout(syncButtons);

    auto layout = new QVBoxLayout(tab);
    layout->addWidget(m_state);
    layout->addWidget(m_details);
    layout->addSpacing(8);
    layout->addWidget(m_syncBox);
    layout->addWidget(m_online);
    layout->addSpacing(8);
    layout->addWidget(m_notice);
    layout->addStretch();
    layout->addLayout(buttons);

    connect(m_signIn, &QPushButton::clicked, this, &KationSettingsWidget::signIn);
    connect(m_cancel, &QPushButton::clicked, this, &KationSettingsWidget::cancelSignIn);
    connect(m_signOut, &QPushButton::clicked, this, &KationSettingsWidget::signOut);
    connect(m_openFiles, &QPushButton::clicked, this, &KationSettingsWidget::openFiles);
    connect(m_copyLink, &QPushButton::clicked, this, [this] {
        QGuiApplication::clipboard()->setText(m_signInUrl);
    });
    connect(m_online, &QLabel::linkActivated, this, [this] {
        openUrl(QUrl(QStringLiteral("protondrive:/")));
    });
    connect(m_details, &QLabel::linkActivated, this, [this](const QString &link) {
        if (link == QLatin1String("protondrive:/")) {
            openUrl(QUrl(link));
        } else {
            QDesktopServices::openUrl(QUrl(link));
        }
    });
    connect(m_syncToggle, &QPushButton::clicked, this, &KationSettingsWidget::toggleSync);
    connect(m_syncPause, &QPushButton::clicked, this, &KationSettingsWidget::togglePause);
    connect(m_syncChooseFolder, &QPushButton::clicked, this, &KationSettingsWidget::chooseFolder);
}

void KationSettingsWidget::buildFoldersTab(QWidget *tab)
{
    m_foldersHint->setObjectName(QStringLiteral("foldersHint"));
    m_folders->setObjectName(QStringLiteral("folders"));
    m_foldersHint->setText(
        i18n("Checked folders in “My files” are synced to this computer. Unchecked folders stay only in Proton Drive: "
             "their files already on this computer are kept, and you can delete them to free space."));
    m_folders->setHeaderHidden(true);
    m_folders->setRootIsDecorated(true);
    m_folders->setUniformRowHeights(true);
    connect(m_folders, &QTreeWidget::itemChanged, this, [this](QTreeWidgetItem *item) {
        if (!m_updatingTree) {
            folderToggled(item);
        }
    });
    connect(m_folders, &QTreeWidget::itemExpanded, this, [this](QTreeWidgetItem *item) {
        if (!item->data(0, LoadedRole).toBool()) {
            loadChildren(item, item->data(0, PathRole).toString());
        }
    });

    auto layout = new QVBoxLayout(tab);
    layout->addWidget(wrapped(m_foldersHint));
    layout->addWidget(m_folders, 1);
}

void KationSettingsWidget::buildAdvancedTab(QWidget *tab)
{
    m_limitUpload->setObjectName(QStringLiteral("limitUpload"));
    m_uploadLimit->setObjectName(QStringLiteral("uploadLimit"));
    m_limitDownload->setObjectName(QStringLiteral("limitDownload"));
    m_downloadLimit->setObjectName(QStringLiteral("downloadLimit"));
    m_trayAtLogin->setObjectName(QStringLiteral("trayAtLogin"));

    for (QSpinBox *spin : {m_uploadLimit, m_downloadLimit}) {
        spin->setRange(1, MaxLimit);
        spin->setValue(1024);
        spin->setSuffix(i18nc("speed unit", " KiB/s"));
        spin->setEnabled(false);
        connect(spin, &QSpinBox::valueChanged, this, &KationSettingsWidget::settingsEdited);
    }
    connect(m_limitUpload, &QCheckBox::toggled, m_uploadLimit, &QSpinBox::setEnabled);
    connect(m_limitDownload, &QCheckBox::toggled, m_downloadLimit, &QSpinBox::setEnabled);
    connect(m_limitUpload, &QCheckBox::toggled, this, &KationSettingsWidget::settingsEdited);
    connect(m_limitDownload, &QCheckBox::toggled, this, &KationSettingsWidget::settingsEdited);
    connect(m_trayAtLogin, &QCheckBox::toggled, this, &KationSettingsWidget::settingsEdited);

    auto speedBox = new QGroupBox(i18n("Speed Limits"), tab);
    auto speed = new QFormLayout(speedBox);
    speed->addRow(m_limitUpload, m_uploadLimit);
    speed->addRow(m_limitDownload, m_downloadLimit);
    auto speedNote = new QLabel(i18n("Apply to all transfers: folder sync and the online view."), speedBox);
    speed->addRow(wrapped(speedNote));

    auto startupBox = new QGroupBox(i18n("Startup"), tab);
    auto startup = new QVBoxLayout(startupBox);
    startup->addWidget(m_trayAtLogin);
    auto startupNote = new QLabel(i18n("While folder sync is on, the background service starts with your session either way."), startupBox);
    startup->addWidget(wrapped(startupNote));

    auto layout = new QVBoxLayout(tab);
    layout->addWidget(speedBox);
    layout->addWidget(startupBox);
    layout->addStretch();
}

void KationSettingsWidget::setAutoSave(bool autoSave)
{
    m_autoSave = autoSave;
}

bool KationSettingsWidget::hasChanges() const
{
    if (!m_settingsLoaded) {
        return m_trayAtLogin->isChecked() != m_savedTrayAtLogin;
    }
    const uint upload = m_limitUpload->isChecked() ? m_uploadLimit->value() : 0;
    const uint download = m_limitDownload->isChecked() ? m_downloadLimit->value() : 0;
    return m_excluded != m_savedExcluded || upload != m_savedUploadLimit || download != m_savedDownloadLimit
        || m_trayAtLogin->isChecked() != m_savedTrayAtLogin;
}

void KationSettingsWidget::load()
{
    m_savedTrayAtLogin = Kation::trayAtLogin();
    {
        QScopedValueRollback guard(m_loading, true);
        m_trayAtLogin->setChecked(m_savedTrayAtLogin);
    }
    refreshSync();
    Q_EMIT changed(hasChanges());
}

void KationSettingsWidget::save()
{
    m_autoSaveTimer->stop();
    if (m_trayAtLogin->isChecked() != m_savedTrayAtLogin) {
        m_savedTrayAtLogin = m_trayAtLogin->isChecked();
        Kation::setTrayAtLogin(m_savedTrayAtLogin);
    }
    if (m_settingsLoaded) {
        const uint upload = m_limitUpload->isChecked() ? m_uploadLimit->value() : 0;
        const uint download = m_limitDownload->isChecked() ? m_downloadLimit->value() : 0;
        if (upload != m_savedUploadLimit || download != m_savedDownloadLimit) {
            m_savedUploadLimit = upload;
            m_savedDownloadLimit = download;
            call(m_drive->SetBandwidthLimits(upload, download));
        }
        if (m_excluded != m_savedExcluded) {
            m_savedExcluded = m_excluded;
            QStringList excluded(m_excluded.cbegin(), m_excluded.cend());
            excluded.sort();
            call(m_drive->SetExcludedFolders(excluded));
        }
    }
    Q_EMIT changed(hasChanges());
}

void KationSettingsWidget::defaults()
{
    m_limitUpload->setChecked(false);
    m_limitDownload->setChecked(false);
    m_trayAtLogin->setChecked(true);
    m_excluded.clear();
    updateFolderItems();
    settingsEdited();
}

void KationSettingsWidget::settingsEdited()
{
    if (m_loading) {
        return;
    }
    const bool changes = hasChanges();
    Q_EMIT changed(changes);
    if (m_autoSave && changes) {
        m_autoSaveTimer->start();
    }
}

void KationSettingsWidget::refresh()
{
    auto watcher = new QDBusPendingCallWatcher(m_drive->GetStatus(), this);
    connect(watcher, &QDBusPendingCallWatcher::finished, this, [this, watcher] {
        watcher->deleteLater();
        QDBusPendingReply<QVariantMap> reply = *watcher;
        if (reply.isError()) {
            m_state->setText(i18n("Kation is not running"));
            showError(i18n("Could not reach the Kation background service: %1", reply.error().message()));
            return;
        }
        showStatus(reply.value());
    });
}

void KationSettingsWidget::showStatus(const QVariantMap &status)
{
    const bool loggedIn = status.value(QStringLiteral("loggedIn")).toBool();
    const bool pending = status.value(QStringLiteral("loginPending")).toBool();
    m_signInUrl = status.value(QStringLiteral("signInUrl")).toString();

    m_signIn->setVisible(!loggedIn && !pending);
    m_signIn->setEnabled(true);
    m_cancel->setVisible(pending);
    m_copyLink->setVisible(pending && !m_signInUrl.isEmpty());
    m_signOut->setVisible(loggedIn);
    m_openFiles->setVisible(loggedIn);
    m_syncBox->setVisible(loggedIn);
    m_online->setVisible(loggedIn);
    m_tabs->setTabEnabled(1, loggedIn);
    if (loggedIn != m_loggedIn) {
        m_loggedIn = loggedIn;
        m_treeLoaded = false;
        m_folders->clear();
        if (loggedIn && m_tabs->currentIndex() == 1) {
            loadFolderTree();
        }
    }
    if (loggedIn) {
        refreshSync();
    }

    if (loggedIn) {
        m_state->setText(i18n("Signed in"));
        m_details->setText(i18n("Signed in to Proton Drive as <b>%1</b>.", status.value(QStringLiteral("email")).toString().toHtmlEscaped()));
    } else if (pending) {
        m_state->setText(i18n("Waiting for sign-in…"));
        m_details->setText(
            i18n("Finish signing in in your browser. If it did not open, <a href=\"%1\">open the sign-in page</a>, "
                 "or copy the link to sign in on another device.",
                 m_signInUrl.toHtmlEscaped()));
    } else {
        m_state->setText(i18n("Not signed in"));
        m_details->setText(i18n("Sign in with your Proton account in your browser. Kation never sees your password."));
    }

    // A problem (e.g. no keyring) is more useful than the generic text.
    const QString problem = Kation::problemText(status);
    if (!problem.isEmpty()) {
        showError(problem);
    }
    fitToContents();
}

void KationSettingsWidget::showError(const QString &message)
{
    m_details->setText(errorText(message));
    fitToContents();
}

void KationSettingsWidget::signIn()
{
    m_signIn->setEnabled(false);
    auto watcher = new QDBusPendingCallWatcher(m_drive->StartLogin(), this);
    connect(watcher, &QDBusPendingCallWatcher::finished, this, [this, watcher] {
        watcher->deleteLater();
        QDBusPendingReply<QString> reply = *watcher;
        if (reply.isError()) {
            m_signIn->setEnabled(true);
            showError(reply.error().message());
            return;
        }
        QDesktopServices::openUrl(QUrl(reply.value()));
    });
}

void KationSettingsWidget::cancelSignIn()
{
    m_drive->CancelLogin();
}

void KationSettingsWidget::signOut()
{
    auto watcher = new QDBusPendingCallWatcher(m_drive->Logout(), this);
    connect(watcher, &QDBusPendingCallWatcher::finished, this, [this, watcher] {
        watcher->deleteLater();
        QDBusPendingReply<> reply = *watcher;
        if (reply.isError()) {
            showError(reply.error().message());
        }
        refresh();
    });
}

void KationSettingsWidget::openFiles()
{
    // With sync on, the synced folder is where files live; otherwise the online view.
    if (m_syncStatus.value(QStringLiteral("enabled")).toBool()) {
        openUrl(QUrl::fromLocalFile(m_syncStatus.value(QStringLiteral("folder")).toString()));
    } else {
        openUrl(QUrl(QStringLiteral("protondrive:/")));
    }
}

void KationSettingsWidget::openUrl(const QUrl &url)
{
    // A folder in the file manager; protondrive: has no browser-style URL handler.
    auto job = new KIO::OpenUrlJob(url, QStringLiteral("inode/directory"));
    job->setUiDelegate(KIO::createDefaultJobUiDelegate(KJobUiDelegate::AutoHandlingEnabled, this));
    job->start();
}

void KationSettingsWidget::call(const QDBusPendingCall &pending)
{
    auto watcher = new QDBusPendingCallWatcher(pending, this);
    connect(watcher, &QDBusPendingCallWatcher::finished, this, [this, watcher] {
        watcher->deleteLater();
        if (watcher->isError()) {
            m_syncState->setText(errorText(watcher->error().message()));
            fitToContents();
        }
    });
}

void KationSettingsWidget::refreshSync()
{
    auto watcher = new QDBusPendingCallWatcher(m_drive->GetSyncStatus(), this);
    connect(watcher, &QDBusPendingCallWatcher::finished, this, [this, watcher] {
        watcher->deleteLater();
        QDBusPendingReply<QVariantMap> reply = *watcher;
        if (!reply.isError()) {
            showSyncStatus(reply.value());
        }
    });
}

void KationSettingsWidget::showSyncStatus(const QVariantMap &status)
{
    m_syncStatus = status;
    const bool enabled = status.value(QStringLiteral("enabled")).toBool();
    const bool paused = status.value(QStringLiteral("paused")).toBool();
    const QString state = status.value(QStringLiteral("state")).toString();
    const QString message = Kation::syncReasonText(status);
    const QString folder = status.value(QStringLiteral("folder")).toString();

    // Settings saved in kationd. Edits in progress are kept; otherwise show the saved values.
    const QStringList excludedList = status.value(QStringLiteral("excluded")).toStringList();
    const QSet<QString> excluded(excludedList.cbegin(), excludedList.cend());
    const uint uploadLimit = status.value(QStringLiteral("uploadLimit")).toUInt();
    const uint downloadLimit = status.value(QStringLiteral("downloadLimit")).toUInt();
    const bool edited = m_settingsLoaded && hasChanges();
    if (!edited) {
        QScopedValueRollback guard(m_loading, true);
        m_savedExcluded = excluded;
        m_excluded = excluded;
        m_savedUploadLimit = uploadLimit;
        m_savedDownloadLimit = downloadLimit;
        m_limitUpload->setChecked(uploadLimit > 0);
        if (uploadLimit > 0) {
            m_uploadLimit->setValue(int(uploadLimit));
        }
        m_limitDownload->setChecked(downloadLimit > 0);
        if (downloadLimit > 0) {
            m_downloadLimit->setValue(int(downloadLimit));
        }
        m_settingsLoaded = true;
        updateFolderItems();
    } else {
        m_savedExcluded = excluded;
        m_savedUploadLimit = uploadLimit;
        m_savedDownloadLimit = downloadLimit;
    }

    QString shownFolder = folder;
    if (shownFolder.startsWith(QDir::homePath() + QLatin1Char('/'))) {
        shownFolder = QLatin1Char('~') + shownFolder.mid(QDir::homePath().size());
    }
    m_syncFolder->setText(i18n("Local folder: <b>%1</b>", shownFolder.toHtmlEscaped()));

    m_syncToggle->setText(enabled ? i18n("Turn Off Sync") : i18n("Turn On Sync"));
    m_syncToggle->setIcon(QIcon::fromTheme(enabled ? QStringLiteral("media-playback-stop") : QStringLiteral("folder-sync")));
    m_syncPause->setVisible(enabled);
    m_syncPause->setText(paused || state == QLatin1String("paused") ? i18n("Resume") : i18n("Pause"));
    m_syncPause->setIcon(
        QIcon::fromTheme(paused || state == QLatin1String("paused") ? QStringLiteral("media-playback-start") : QStringLiteral("media-playback-pause")));
    m_syncChooseFolder->setVisible(!enabled);
    m_openFiles->setText(enabled ? i18n("Open Synced Folder") : i18n("Open Online View"));
    m_openFiles->setToolTip(enabled ? folder : QStringLiteral("protondrive:/"));

    QString text;
    if (!enabled) {
        text = i18n("Sync is off. Turn it on to keep this folder and your Proton Drive \"My files\" in sync.");
    } else if (state == QLatin1String("syncing")) {
        const QString current = status.value(QStringLiteral("current")).toString();
        text = current.isEmpty() ? i18n("Syncing…") : i18n("Syncing %1…", current.toHtmlEscaped());
    } else if (state == QLatin1String("paused")) {
        text = message.isEmpty() ? i18n("Paused.") : i18n("Paused: %1", message.toHtmlEscaped());
    } else if (state == QLatin1String("error")) {
        text = errorText(i18n("Problem: %1", message));
    } else if (state == QLatin1String("disabled")) {
        text = message.toHtmlEscaped();
    } else {
        const qlonglong lastSync = status.value(QStringLiteral("lastSync")).toLongLong();
        text = lastSync > 0 ? i18n("Up to date. Last synced %1.", QLocale().toString(QDateTime::fromSecsSinceEpoch(lastSync), QLocale::ShortFormat))
                            : i18n("Starting…");
    }
    m_syncState->setText(text);
    fitToContents();
    if (!edited) {
        Q_EMIT changed(hasChanges());
    }
}

void KationSettingsWidget::toggleSync()
{
    call(m_drive->SetSyncEnabled(!m_syncStatus.value(QStringLiteral("enabled")).toBool()));
}

void KationSettingsWidget::togglePause()
{
    const bool paused =
        m_syncStatus.value(QStringLiteral("paused")).toBool() || m_syncStatus.value(QStringLiteral("state")).toString() == QLatin1String("paused");
    call(m_drive->SetSyncPaused(!paused));
}

void KationSettingsWidget::chooseFolder()
{
    const QString folder = QFileDialog::getExistingDirectory(this, i18n("Choose the Sync Folder"), m_syncStatus.value(QStringLiteral("folder")).toString());
    if (!folder.isEmpty()) {
        auto watcher = new QDBusPendingCallWatcher(m_drive->SetSyncFolder(folder), this);
        connect(watcher, &QDBusPendingCallWatcher::finished, this, [this, watcher] {
            watcher->deleteLater();
            if (watcher->isError()) {
                m_syncState->setText(errorText(watcher->error().message()));
            }
            refreshSync();
        });
    }
}

// Folders to sync: a lazily loaded tree of the folders in "My files". A checked folder is synced.

void KationSettingsWidget::loadFolderTree()
{
    m_treeLoaded = true;
    m_folders->clear();
    loadChildren(nullptr, QStringLiteral("/"));
}

void KationSettingsWidget::loadChildren(QTreeWidgetItem *parent, const QString &path)
{
    if (parent) {
        parent->setData(0, LoadedRole, true);
    }
    auto watcher = new QDBusPendingCallWatcher(m_drive->List(path), this);
    // The item can be deleted (tree reloaded) before the reply arrives.
    const QPersistentModelIndex parentIndex(parent ? m_folders->indexFromItem(parent) : QModelIndex());
    connect(watcher, &QDBusPendingCallWatcher::finished, this, [this, watcher, parentIndex, path, isRoot = !parent] {
        watcher->deleteLater();
        QTreeWidgetItem *parent = isRoot ? nullptr : m_folders->itemFromIndex(parentIndex);
        if (!isRoot && !parent) {
            return;
        }
        QDBusPendingReply<QVariantMapList> reply = *watcher;
        QScopedValueRollback guard(m_updatingTree, true);
        if (parent) {
            qDeleteAll(parent->takeChildren());
        }
        if (reply.isError()) {
            m_foldersHint->setText(errorText(reply.error().message()));
            return;
        }
        QStringList names;
        for (const QVariantMap &entry : reply.value()) {
            if (entry.value(QStringLiteral("type")).toString() == QLatin1String("folder")) {
                names.append(entry.value(QStringLiteral("name")).toString());
            }
        }
        names.sort(Qt::CaseInsensitive);
        for (const QString &name : std::as_const(names)) {
            auto item = parent ? new QTreeWidgetItem(parent) : new QTreeWidgetItem(m_folders);
            item->setText(0, name);
            item->setIcon(0, QIcon::fromTheme(QStringLiteral("folder")));
            item->setData(0, PathRole, childPath(path, name));
            item->setFlags(Qt::ItemIsEnabled | Qt::ItemIsUserCheckable);
            item->setChildIndicatorPolicy(QTreeWidgetItem::ShowIndicator);
        }
        if (parent && parent->childCount() == 0) {
            parent->setChildIndicatorPolicy(QTreeWidgetItem::DontShowIndicator);
        }
        updateFolderItems(parent);
    });
}

bool KationSettingsWidget::isExcluded(const QString &path) const
{
    return m_excluded.contains(path);
}

bool KationSettingsWidget::hasExcludedAncestor(const QString &path) const
{
    for (const QString &excluded : m_excluded) {
        if (path.startsWith(excluded + QLatin1Char('/'))) {
            return true;
        }
    }
    return false;
}

void KationSettingsWidget::folderToggled(QTreeWidgetItem *item)
{
    const QString path = item->data(0, PathRole).toString();
    if (item->checkState(0) == Qt::Unchecked) {
        // Excluding a folder covers everything inside it.
        for (auto it = m_excluded.begin(); it != m_excluded.end();) {
            it = it->startsWith(path + QLatin1Char('/')) ? m_excluded.erase(it) : std::next(it);
        }
        m_excluded.insert(path);
    } else {
        m_excluded.remove(path);
    }
    updateFolderItems();
    settingsEdited();
}

void KationSettingsWidget::updateFolderItems(QTreeWidgetItem *root)
{
    QScopedValueRollback guard(m_updatingTree, true);
    const auto update = [this](QTreeWidgetItem *item, const auto &self) -> void {
        const QString path = item->data(0, PathRole).toString();
        const bool inherited = hasExcludedAncestor(path);
        item->setCheckState(0, inherited || isExcluded(path) ? Qt::Unchecked : Qt::Checked);
        // Inside an excluded folder: nothing to choose.
        item->setDisabled(inherited);
        for (int i = 0; i < item->childCount(); ++i) {
            self(item->child(i), self);
        }
    };
    if (root) {
        for (int i = 0; i < root->childCount(); ++i) {
            update(root->child(i), update);
        }
        return;
    }
    for (int i = 0; i < m_folders->topLevelItemCount(); ++i) {
        update(m_folders->topLevelItem(i), update);
    }
}

void KationSettingsWidget::resizeEvent(QResizeEvent *event)
{
    QWidget::resizeEvent(event);
    // Narrower means more lines of wrapped text.
    fitToContents();
}

void KationSettingsWidget::fitToContents()
{
    // Qt does not include the height of wrapped text in minimum sizes, so a window sized
    // before the sync section appeared would squeeze it (text and buttons cut off). The
    // page's minimum height propagates to whatever window shows this widget.
    if (m_fitting) {
        return;
    }
    QScopedValueRollback guard(m_fitting, true);
    QWidget *general = m_tabs->widget(0);
    general->layout()->activate();
    general->setMinimumHeight(general->layout()->totalHeightForWidth(general->width()));
}
