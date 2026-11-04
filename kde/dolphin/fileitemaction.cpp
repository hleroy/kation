// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include "kationdriveinterface.h"
#include "kationtypes.h"

#include <KAbstractFileItemActionPlugin>
#include <KFileItem>
#include <KFileItemListProperties>
#include <KLocalizedString>
#include <KNotification>
#include <KPluginFactory>

#include <QAction>
#include <QClipboard>
#include <QDBusConnectionInterface>
#include <QDBusPendingCallWatcher>
#include <QDBusPendingReply>
#include <QDBusReply>
#include <QDesktopServices>
#include <QGuiApplication>
#include <QMenu>
#include <QMessageBox>
#include <QPointer>

/**
 * "Proton Drive" submenu in Dolphin's context menu, for items in the synced
 * folder and in the online view: copy the public link (creating it after
 * asking), and open the item in the Proton Drive web app.
 */
class KationFileItemAction : public KAbstractFileItemActionPlugin
{
    Q_OBJECT

public:
    KationFileItemAction(QObject *parent, const QVariantList &)
        : KAbstractFileItemActionPlugin(parent)
    {
        Kation::registerDBusTypes();
    }

    QList<QAction *> actions(const KFileItemListProperties &items, QWidget *parentWidget) override
    {
        if (items.items().size() != 1) {
            return {};
        }
        const KFileItem item = items.items().constFirst();
        const QUrl url = item.url();
        if (!isProtonItem(url)) {
            return {};
        }

        auto menu = new QMenu(i18n("Proton Drive"), parentWidget);
        menu->setIcon(QIcon::fromTheme(QStringLiteral("kation-folder")));
        const QString name = item.name();
        const QPointer<QWidget> parent(parentWidget);
        menu->addAction(QIcon::fromTheme(QStringLiteral("link")), i18n("Copy Public Link"), this, [this, url, name, parent] {
            copyLink(url, name, parent);
        });
        menu->addAction(QIcon::fromTheme(QStringLiteral("internet-web-browser")), i18n("Open in Proton Drive Website"), this, [this, url] {
            auto watcher = new QDBusPendingCallWatcher(drive()->GetWebUrl(url.toString()), this);
            connect(watcher, &QDBusPendingCallWatcher::finished, this, [this, watcher] {
                watcher->deleteLater();
                QDBusPendingReply<QString> reply = *watcher;
                if (reply.isError()) {
                    Q_EMIT error(reply.error().message());
                    return;
                }
                QDesktopServices::openUrl(QUrl(reply.value()));
            });
        });
        return {menu->menuAction()};
    }

private:
    KationDriveInterface *drive()
    {
        if (!m_drive) {
            m_drive = new KationDriveInterface(Kation::serviceName, Kation::objectPath, QDBusConnection::sessionBus(), this);
            m_drive->setTimeout(60 * 1000);
        }
        return m_drive;
    }

    /// An item in the online view, or in the synced folder (but not the folder itself).
    bool isProtonItem(const QUrl &url)
    {
        if (url.scheme() == QLatin1String("protondrive")) {
            return url.path() != QLatin1String("/") && !url.path().isEmpty();
        }
        if (!url.isLocalFile() || !QDBusConnection::sessionBus().interface()->isServiceRegistered(Kation::serviceName)) {
            // Do not start kationd just to build a context menu.
            return false;
        }
        drive()->setTimeout(500);
        const QDBusReply<QVariantMap> reply = drive()->GetSyncStatus();
        drive()->setTimeout(60 * 1000);
        if (!reply.isValid() || !reply.value().value(QStringLiteral("enabled")).toBool()) {
            return false;
        }
        const QString folder = reply.value().value(QStringLiteral("folder")).toString();
        return url.toLocalFile().startsWith(folder + QLatin1Char('/'));
    }

    void copyLink(const QUrl &url, const QString &name, const QPointer<QWidget> &parent)
    {
        auto watcher = new QDBusPendingCallWatcher(drive()->GetShareLink(url.toString(), false), this);
        connect(watcher, &QDBusPendingCallWatcher::finished, this, [this, watcher, url, name, parent] {
            watcher->deleteLater();
            QDBusPendingReply<QString> reply = *watcher;
            if (reply.isError()) {
                Q_EMIT error(reply.error().message());
                return;
            }
            if (!reply.value().isEmpty()) {
                linkCopied(reply.value(), name, false);
                return;
            }
            const auto answer = QMessageBox::question(parent,
                                                      i18n("Create a Public Link?"),
                                                      i18n("“%1” has no public link yet. Anyone who has the link will be able to view it. "
                                                           "You can remove the link in the Proton Drive website.",
                                                           name),
                                                      QMessageBox::Yes | QMessageBox::Cancel,
                                                      QMessageBox::Cancel);
            if (answer != QMessageBox::Yes) {
                return;
            }
            auto create = new QDBusPendingCallWatcher(drive()->GetShareLink(url.toString(), true), this);
            connect(create, &QDBusPendingCallWatcher::finished, this, [this, create, name] {
                create->deleteLater();
                QDBusPendingReply<QString> created = *create;
                if (created.isError()) {
                    Q_EMIT error(created.error().message());
                    return;
                }
                linkCopied(created.value(), name, true);
            });
        });
    }

    void linkCopied(const QString &link, const QString &name, bool created)
    {
        QGuiApplication::clipboard()->setText(link);
        KNotification::event(KNotification::Notification,
                             created ? i18n("Public link created") : i18n("Public link copied"),
                             i18n("The link to “%1” is in the clipboard.", name),
                             QStringLiteral("com.hleroy.Kation"));
    }

    KationDriveInterface *m_drive = nullptr;
};

K_PLUGIN_CLASS_WITH_JSON(KationFileItemAction, "kationfileitemaction.json")

#include "fileitemaction.moc"
