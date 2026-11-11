// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * The Dolphin plugins from the build tree against kationd serving a fake
 * drive: sync state emblems, and the "Proton Drive" context menu.
 */

#include "fakekationd.h"
#include "kationdriveinterface.h"

#include <KAbstractFileItemActionPlugin>
#include <KFileItem>
#include <KFileItemActions>
#include <KFileItemListProperties>
#include <KOverlayIconPlugin>
#include <KPluginFactory>
#include <KPluginMetaData>

#include <QAction>
#include <QApplication>
#include <QClipboard>
#include <QDesktopServices>
#include <QDir>
#include <QFile>
#include <QGuiApplication>
#include <QMenu>
#include <QMessageBox>
#include <QPluginLoader>
#include <QScopeGuard>
#include <QSignalSpy>
#include <QTest>
#include <QTextDocument>
#include <QTimer>
#include <QWidget>

using namespace Qt::StringLiterals;

class DolphinPluginsTest : public QObject
{
    Q_OBJECT

public Q_SLOTS:
    /// Stands in for the browser.
    void openUrl(const QUrl &url)
    {
        m_openedUrls.append(url);
    }

private Q_SLOTS:
    void initTestCase();
    void cleanupTestCase();
    void showsSyncStates();
    void offersLinksForProtonItems();
    void menuBuilderPicksThePlugin();

private:
    QString local(const QString &name) const
    {
        return m_home.filePath(u"Proton Drive/"_s + name);
    }
    static void write(const QString &path, const QByteArray &content)
    {
        QFile file(path);
        QVERIFY(file.open(QIODevice::WriteOnly));
        file.write(content);
    }
    /// The overlays last reported for url (waits for the plugin to answer).
    QStringList overlaysOf(const QUrl &url, QSignalSpy &spy)
    {
        for (int i = spy.size() - 1; i >= 0; --i) {
            if (spy.at(i).at(0).toUrl() == url) {
                return spy.at(i).at(1).toStringList();
            }
        }
        return {u"(none yet)"_s};
    }

    QTemporaryDir m_home;
    std::unique_ptr<FakeKationd> m_kationd;
    QList<QUrl> m_openedUrls;
};

void DolphinPluginsTest::initTestCase()
{
    Kation::registerDBusTypes();
    m_kationd = std::make_unique<FakeKationd>(m_home);
    QVERIFY(m_kationd->start());
    KationDriveInterface drive(Kation::serviceName, Kation::objectPath, QDBusConnection::sessionBus());
    drive.SetSyncEnabled(true).waitForFinished();
    QDesktopServices::setUrlHandler(u"https"_s, this, "openUrl");
}

void DolphinPluginsTest::cleanupTestCase()
{
    QDesktopServices::unsetUrlHandler(u"https"_s);
    QVERIFY2(m_kationd->stop(), "kationd did not exit cleanly");
}

void DolphinPluginsTest::showsSyncStates()
{
    QPluginLoader loader(QStringLiteral(KATION_OVERLAY_PLUGIN));
    auto plugin = qobject_cast<KOverlayIconPlugin *>(loader.instance());
    QVERIFY2(plugin, qPrintable(loader.errorString()));
    QSignalSpy spy(plugin, &KOverlayIconPlugin::overlaysChanged);

    KationDriveInterface drive(Kation::serviceName, Kation::objectPath, QDBusConnection::sessionBus());
    write(local(u"synced.txt"_s), "hello");
    drive.SyncNow().waitForFinished();
    QTRY_VERIFY_WITH_TIMEOUT(drive.GetSyncStatus().value().value(u"state"_s).toString() == u"idle"_s, 5000);

    const QUrl synced = QUrl::fromLocalFile(local(u"synced.txt"_s));
    const QUrl outside = QUrl::fromLocalFile(m_home.filePath(u"elsewhere.txt"_s));
    // The first answer is empty; the state follows in overlaysChanged.
    plugin->getOverlays(synced);
    QTRY_COMPARE_WITH_TIMEOUT(overlaysOf(synced, spy), QStringList{u"emblem-checked"_s}, 5000);
    QCOMPARE(plugin->getOverlays(synced), QStringList{u"emblem-checked"_s});
    QVERIFY(plugin->getOverlays(outside).isEmpty());
    QVERIFY(plugin->getOverlays(QUrl(u"protondrive:/synced.txt"_s)).isEmpty());

    // While paused, a new file waits.
    drive.SetSyncPaused(true).waitForFinished();
    write(local(u"waiting.txt"_s), "later");
    const QUrl waiting = QUrl::fromLocalFile(local(u"waiting.txt"_s));
    plugin->getOverlays(waiting);
    QTRY_COMPARE_WITH_TIMEOUT(overlaysOf(waiting, spy), QStringList{u"emblem-pause"_s}, 5000);

    // Resumed: the plugin is told and shows it synced.
    drive.SetSyncPaused(false).waitForFinished();
    QTRY_COMPARE_WITH_TIMEOUT(overlaysOf(waiting, spy), QStringList{u"emblem-checked"_s}, 10000);

    // Excluded folders say so.
    QDir().mkpath(local(u"Private"_s));
    drive.SetExcludedFolders({u"/Private"_s}).waitForFinished();
    const QUrl excluded = QUrl::fromLocalFile(local(u"Private"_s));
    plugin->getOverlays(excluded);
    QTRY_COMPARE_WITH_TIMEOUT(overlaysOf(excluded, spy), QStringList{u"emblem-unavailable"_s}, 5000);
    drive.SetExcludedFolders({}).waitForFinished();

    // The "syncing" emblem is Kation's own (Breeze has none), installed by kde/icons.
    QVERIFY(QFile::exists(QStringLiteral(KATION_ICONS_DIR "/sc-emblems-kation-emblem-syncing.svg")));

    // Sync off: every emblem shown so far goes away.
    drive.SetSyncEnabled(false).waitForFinished();
    QTRY_COMPARE(overlaysOf(synced, spy), QStringList{});
    QVERIFY(plugin->getOverlays(synced).isEmpty());
    drive.SetSyncEnabled(true).waitForFinished();
    delete plugin;
}

void DolphinPluginsTest::offersLinksForProtonItems()
{
    const KPluginMetaData metaData = KPluginMetaData::fromJsonFile(QStringLiteral(KATION_FILEITEMACTION_JSON));
    QVERIFY(metaData.isValid());
    QPluginLoader loader(QStringLiteral(KATION_FILEITEMACTION_PLUGIN));
    auto factory = qobject_cast<KPluginFactory *>(loader.instance());
    QVERIFY2(factory, qPrintable(loader.errorString()));
    auto plugin = factory->create<KAbstractFileItemActionPlugin>(this);
    QVERIFY(plugin);
    QWidget parent;

    const auto actionsFor = [&](const QUrl &url) {
        KFileItem item(url, QStringLiteral("text/plain"), S_IFREG);
        return plugin->actions(KFileItemListProperties(KFileItemList{item}), &parent);
    };

    KationDriveInterface drive(Kation::serviceName, Kation::objectPath, QDBusConnection::sessionBus());
    write(local(u"report.txt"_s), "report");
    drive.SyncNow().waitForFinished();
    QTRY_VERIFY_WITH_TIMEOUT(drive.Stat(u"/report.txt"_s).value().value(u"name"_s).toString() == u"report.txt"_s, 5000);

    QVERIFY(actionsFor(QUrl::fromLocalFile(m_home.filePath(u"elsewhere.txt"_s))).isEmpty());
    QVERIFY(actionsFor(QUrl::fromLocalFile(m_home.filePath(u"Proton Drive"_s))).isEmpty());
    QVERIFY(actionsFor(QUrl(u"protondrive:/"_s)).isEmpty());

    const QList<QAction *> actions = actionsFor(QUrl::fromLocalFile(local(u"report.txt"_s)));
    QCOMPARE(actions.size(), 1);
    QMenu *menu = actions.first()->menu();
    QVERIFY(menu);
    QCOMPARE(menu->actions().size(), 2);
    QCOMPARE(menu->actions().at(0)->text(), u"Copy Public Link"_s);

    // Open in the website: the address comes from kationd.
    menu->actions().at(1)->trigger();
    QTRY_COMPARE(m_openedUrls.size(), 1);
    QVERIFY(m_openedUrls.first().toString().startsWith(u"https://drive.proton.me/"_s));

    // An existing link is copied without asking.
    drive.GetShareLink(u"protondrive:/report.txt"_s, true).waitForFinished();
    const QList<QAction *> online = actionsFor(QUrl(u"protondrive:/report.txt"_s));
    QCOMPARE(online.size(), 1);
    online.first()->menu()->actions().at(0)->trigger();
    QTRY_VERIFY(QGuiApplication::clipboard()->text().startsWith(u"https://drive.proton.me/urls/"_s));

    // A name with markup does not change what the question says.
    const QString name = u"<b>x<br>y.txt"_s;
    write(local(name), "marked up");
    drive.SyncNow().waitForFinished();
    QTRY_VERIFY_WITH_TIMEOUT(drive.Stat(u"/"_s + name).value().value(u"name"_s).toString() == name, 5000);
    QString question;
    QTimer answer;
    connect(&answer, &QTimer::timeout, this, [&question] {
        if (auto box = qobject_cast<QMessageBox *>(QApplication::activeModalWidget())) {
            question = box->text();
            box->reject();
        }
    });
    answer.start(20);
    actionsFor(QUrl::fromLocalFile(local(name))).first()->menu()->actions().at(0)->trigger();
    QTRY_VERIFY_WITH_TIMEOUT(!question.isEmpty(), 5000);
    QVERIFY2(question.contains(u"“&lt;b&gt;x&lt;br&gt;y.txt”"_s), qPrintable(question));
    QVERIFY(Qt::mightBeRichText(question));
}

void DolphinPluginsTest::menuBuilderPicksThePlugin()
{
    // Dolphin builds its context menu with KFileItemActions, which only asks the
    // plugins whose metadata lists a matching MIME type.
    const KPluginMetaData metaData(QStringLiteral(KATION_FILEITEMACTION_PLUGIN));
    QVERIFY(metaData.isValid());
    for (const QString &mimeType : {u"text/plain"_s, u"application/pdf"_s, u"image/png"_s, u"inode/directory"_s}) {
        QVERIFY2(metaData.supportsMimeType(mimeType), qPrintable(mimeType));
    }

    // The same menu Dolphin shows, with only this build's plugins: the system ones
    // (KDE Connect, activities, ...) would start services on the test bus.
    const QStringList libraryPaths = QCoreApplication::libraryPaths();
    QCoreApplication::setLibraryPaths({QStringLiteral(KATION_PLUGIN_ROOT)});
    const auto restorePaths = qScopeGuard([&] {
        QCoreApplication::setLibraryPaths(libraryPaths);
    });
    write(local(u"menu.txt"_s), "menu");
    const auto topLevelTitles = [](const QUrl &url) {
        KFileItem item(url);
        item.determineMimeType();
        KFileItemActions actions;
        actions.setItemListProperties(KFileItemListProperties(KFileItemList{item}));
        QMenu menu;
        actions.addActionsTo(&menu);
        QStringList titles;
        for (QAction *action : menu.actions()) {
            titles.append(action->text());
        }
        return titles;
    };
    const QStringList inside = topLevelTitles(QUrl::fromLocalFile(local(u"menu.txt"_s)));
    QVERIFY2(inside.contains(u"Proton Drive"_s), qPrintable(inside.join(u", "_s)));
    QDir().mkpath(local(u"Folder"_s));
    const QStringList folder = topLevelTitles(QUrl::fromLocalFile(local(u"Folder"_s)));
    QVERIFY2(folder.contains(u"Proton Drive"_s), qPrintable(folder.join(u", "_s)));
    write(m_home.filePath(u"elsewhere.txt"_s), "elsewhere");
    QVERIFY(!topLevelTitles(QUrl::fromLocalFile(m_home.filePath(u"elsewhere.txt"_s))).contains(u"Proton Drive"_s));
}

QTEST_MAIN(DolphinPluginsTest)

#include "dolphinpluginstest.moc"
