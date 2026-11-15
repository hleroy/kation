// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * The tray icon against kationd serving a fake drive: status, pause and
 * resume from the menu, recent activity, and the conflict notification.
 */

#include "tray.h"
#include "fakekationd.h"
#include "kationdriveinterface.h"

#include <KStatusNotifierItem>

#include <QAction>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QMenu>
#include <QSignalSpy>
#include <QTest>
#include <QTextDocument>

using namespace Qt::StringLiterals;

class TrayTest : public QObject
{
    Q_OBJECT

private Q_SLOTS:
    void initTestCase();
    void cleanupTestCase();
    void followsSyncAndNotifiesConflicts();
    void escapesFileNamesInTheTooltip();
    void notifiesStorageOncePerLevel();
    void shipsItsStateIcons();

private:
    QAction *action(const char *name) const
    {
        return m_tray->menu()->findChild<QAction *>(QString::fromLatin1(name));
    }
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
    static QByteArray read(const QString &path)
    {
        QFile file(path);
        return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray();
    }

    QTemporaryDir m_home;
    QTemporaryDir m_storageHome;
    std::unique_ptr<FakeKationd> m_kationd;
    std::unique_ptr<KationTray> m_tray;
};

void TrayTest::initTestCase()
{
    Kation::registerDBusTypes();
    m_kationd = std::make_unique<FakeKationd>(m_home);
    QVERIFY(m_kationd->start());
}

void TrayTest::cleanupTestCase()
{
    m_tray.reset();
    QVERIFY2(m_kationd->stop(), "kationd did not exit cleanly");
}

void TrayTest::followsSyncAndNotifiesConflicts()
{
    m_tray = std::make_unique<KationTray>();
    QTRY_COMPARE(m_tray->statusText(), u"Sync is off"_s);
    QCOMPARE(m_tray->iconName(), u"kation-tray"_s);
    QVERIFY(!action("pause")->isVisible());
    QVERIFY(action("openOnline")->isVisible());
    QVERIFY(!action("signIn")->isVisible());

    KationDriveInterface drive(Kation::serviceName, Kation::objectPath, QDBusConnection::sessionBus());
    drive.SetSyncEnabled(true).waitForFinished();
    QTRY_COMPARE_WITH_TIMEOUT(m_tray->statusText(), u"Up to date"_s, 5000);
    QCOMPARE(m_tray->iconName(), u"kation-tray-ok"_s);
    // Dolphin shows the synced folder with the Kation folder icon.
    QTRY_VERIFY(read(local(u".directory"_s)).contains("Icon=kation-folder"));
    QVERIFY(action("pause")->isVisible());
    QCOMPARE(action("pause")->text(), u"Pause Sync"_s);
    QVERIFY(action("openFolder")->isVisible());

    // A local file is uploaded and shows up in the recent activity.
    write(local(u"notes.txt"_s), "first");
    drive.SyncNow().waitForFinished();
    auto activity = m_tray->menu()->findChild<QMenu *>(u"activity"_s);
    QTRY_VERIFY_WITH_TIMEOUT(!activity->actions().isEmpty() && activity->actions().first()->text() == u"Uploaded notes.txt"_s, 5000);

    // Pause from the menu, then change the file on both sides.
    action("pause")->trigger();
    QTRY_COMPARE(m_tray->statusText(), u"Sync paused"_s);
    QCOMPARE(m_tray->iconName(), u"kation-tray-paused"_s);
    QCOMPARE(action("pause")->text(), u"Resume Sync"_s);
    QVERIFY(!action("syncNow")->isVisible());

    write(local(u"notes.txt"_s), "local edit");
    const QString remoteCopy = m_home.filePath(u"remote.txt"_s);
    write(remoteCopy, "remote edit");
    // The online view writes to Proton even while sync is paused.
    QDBusPendingReply<QVariantMap> upload = drive.Upload(remoteCopy, u"/notes.txt"_s, true, u"t1"_s);
    upload.waitForFinished();
    QVERIFY2(!upload.isError(), qPrintable(upload.error().message()));

    QSignalSpy notified(m_tray.get(), &KationTray::notified);
    action("pause")->trigger();
    QTRY_VERIFY_WITH_TIMEOUT(!notified.isEmpty(), 10000);
    QCOMPARE(notified.first().at(0).toString(), u"conflict"_s);
    QVERIFY(notified.first().at(1).toString().contains(u"notes.txt"_s));
    QTRY_COMPARE_WITH_TIMEOUT(m_tray->statusText(), u"Up to date"_s, 5000);

    QStringList texts;
    for (QAction *item : activity->actions()) {
        texts.append(item->text());
    }
    QVERIFY2(texts.contains(u"Kept both versions of notes.txt"_s), qPrintable(texts.join(u", "_s)));

    // Sync off: no pause, folder or activity actions that no longer apply.
    drive.SetSyncEnabled(false).waitForFinished();
    QTRY_COMPARE(m_tray->statusText(), u"Sync is off"_s);
    QCOMPARE(m_tray->iconName(), u"kation-tray"_s);
    QTRY_VERIFY(!QFileInfo::exists(local(u".directory"_s)));
    QVERIFY(!action("pause")->isVisible());
    QVERIFY(!action("openFolder")->isVisible());
}

void TrayTest::escapesFileNamesInTheTooltip()
{
    // Slow transfers, so the file being synced shows in the status.
    QVERIFY2(m_kationd->stop(), "kationd did not exit cleanly");
    QProcessEnvironment slow;
    slow.insert(u"KATION_FAKE_CHUNK_DELAY_MS"_s, u"300"_s);
    m_kationd = std::make_unique<FakeKationd>(m_home, slow);
    QVERIFY(m_kationd->start());
    m_tray = std::make_unique<KationTray>();
    QTRY_COMPARE(m_tray->statusText(), u"Sync is off"_s);

    const QString name = u"<b>x<br>y.txt"_s;
    write(local(name), QByteArray(512 * 1024, 'x'));
    // Escaped, a name with only "&" holds no tag: the tooltip must still be read as rich text.
    const QString ampersand = u"Tom & Jerry.txt"_s;
    write(local(ampersand), QByteArray(512 * 1024, 'x'));
    KationDriveInterface drive(Kation::serviceName, Kation::objectPath, QDBusConnection::sessionBus());
    drive.SetSyncEnabled(true).waitForFinished();
    QTRY_VERIFY_WITH_TIMEOUT(m_tray->statusText().contains(name), 10000);

    auto item = m_tray->findChild<KStatusNotifierItem *>();
    QVERIFY(item);
    QVERIFY2(item->toolTipSubTitle().contains(u"&lt;b&gt;x&lt;br&gt;y.txt"_s), qPrintable(item->toolTipSubTitle()));
    QVERIFY(!item->toolTipSubTitle().contains(name));
    QVERIFY(m_tray->menu()->actions().first()->text().contains(name));

    QTRY_VERIFY_WITH_TIMEOUT(m_tray->statusText().contains(ampersand), 20000);
    QVERIFY2(Qt::mightBeRichText(item->toolTipSubTitle()) && item->toolTipSubTitle().contains(u"Tom &amp; Jerry.txt"_s), qPrintable(item->toolTipSubTitle()));

    // The activity menu's tooltips show the path as text too.
    auto activity = m_tray->menu()->findChild<QMenu *>(u"activity"_s);
    const auto activityFor = [activity, &name]() -> QAction * {
        for (QAction *action : activity->actions()) {
            if (action->text().contains(name)) {
                return action;
            }
        }
        return nullptr;
    };
    QTRY_VERIFY_WITH_TIMEOUT(activityFor(), 20000);
    const QString tip = activityFor()->toolTip();
    QVERIFY2(Qt::mightBeRichText(tip) && tip.contains(u"&lt;b&gt;x&lt;br&gt;y.txt"_s), qPrintable(tip));

    drive.SetSyncEnabled(false).waitForFinished();
    QTRY_COMPARE(m_tray->statusText(), u"Sync is off"_s);
}

void TrayTest::notifiesStorageOncePerLevel()
{
    // A fresh home: a 1000-byte drive, and no sync state or files from the tests above.
    m_tray.reset();
    QVERIFY2(m_kationd->stop(), "kationd did not exit cleanly");
    QProcessEnvironment small;
    small.insert(u"KATION_FAKE_STORAGE_MAX"_s, u"1000"_s);
    m_kationd = std::make_unique<FakeKationd>(m_storageHome, small);
    QVERIFY(m_kationd->start());
    m_tray = std::make_unique<KationTray>();
    QSignalSpy spy(m_tray.get(), &KationTray::notified);
    QTRY_COMPARE(m_tray->statusText(), u"Sync is off"_s);
    QTRY_VERIFY(action("storage")->isVisible());
    QVERIFY2(action("storage")->text().startsWith(u"Storage: "_s) && action("storage")->text().endsWith(u" used (0%)"_s),
             qPrintable(action("storage")->text()));
    auto item = m_tray->findChild<KStatusNotifierItem *>();
    QVERIFY(item->toolTipSubTitle().contains(u"Storage: "_s));

    KationDriveInterface drive(Kation::serviceName, Kation::objectPath, QDBusConnection::sessionBus());
    auto upload = [&](const QString &name, int size) {
        const QString path = m_storageHome.filePath(name);
        write(path, QByteArray(size, 'x'));
        QDBusPendingReply<QVariantMap> reply = drive.Upload(path, u"/"_s + name, false, name);
        reply.waitForFinished();
        return reply.isError() ? reply.error().name() : QString();
    };
    QCOMPARE(upload(u"half.bin"_s, 500), QString());
    QTRY_VERIFY(action("storage")->text().endsWith(u" used (50%)"_s));

    // Half full, but a file larger than the space left: "full", in place of the generic sync problem.
    QVERIFY(QDir().mkpath(m_storageHome.filePath(u"Proton Drive"_s)));
    write(m_storageHome.filePath(u"Proton Drive/large.bin"_s), QByteArray(600, 'z'));
    drive.SetSyncEnabled(true).waitForFinished();
    QTRY_COMPARE_WITH_TIMEOUT(spy.size(), 1, 10000);
    QCOMPARE(spy.at(0).at(0).toString(), u"storage"_s);
    QVERIFY2(spy.at(0).at(1).toString().contains(u"storage is full"_s), qPrintable(spy.at(0).at(1).toString()));
    QTRY_VERIFY(m_tray->statusText().startsWith(u"Problem: Your Proton Drive storage is full"_s));
    QCOMPARE(m_tray->iconName(), u"kation-tray-error"_s);

    // Each retry clears the reason while it runs: that must not count as space freed.
    for (int i = 0; i < 2; ++i) {
        drive.SyncNow().waitForFinished();
        QTest::qWait(1000);
        QTRY_VERIFY(m_tray->statusText().startsWith(u"Problem: "_s));
    }
    QCOMPARE(spy.size(), 1);

    // Started again (the next login), whichever status arrives first: not notified again.
    m_tray = std::make_unique<KationTray>();
    QSignalSpy again(m_tray.get(), &KationTray::notified);
    QTRY_VERIFY(m_tray->statusText().startsWith(u"Problem: "_s));
    QTest::qWait(500);
    QCOMPARE(again.size(), 0);

    // Sync off: nothing is refused any more. At 95% the storage is almost full.
    drive.SetSyncEnabled(false).waitForFinished();
    QTRY_COMPARE(m_tray->statusText(), u"Sync is off"_s);
    QCOMPARE(upload(u"more.bin"_s, 450), QString());
    QTRY_COMPARE_WITH_TIMEOUT(again.size(), 1, 5000);
    QCOMPARE(again.at(0).at(0).toString(), u"storage"_s);
    QVERIFY2(again.at(0).at(1).toString().contains(u"almost full"_s), qPrintable(again.at(0).at(1).toString()));
    QTRY_VERIFY(action("storage")->text().endsWith(u" used (95%)"_s));

    // An upload that does not fit is refused with its own error.
    QCOMPARE(upload(u"too-much.bin"_s, 100), Kation::errorPrefix + u"QuotaExceeded"_s);
}

void TrayTest::shipsItsStateIcons()
{
    // Every icon the tray can show is installed by kde/icons.
    for (const QString &name :
         {u"kation-tray"_s, u"kation-tray-ok"_s, u"kation-tray-sync"_s, u"kation-tray-paused"_s, u"kation-tray-error"_s, u"kation-tray-offline"_s}) {
        const QString path = QStringLiteral(KATION_ICONS_DIR "/sc-status-") + name + u".svg"_s;
        QFile file(path);
        QVERIFY2(file.open(QIODevice::ReadOnly), qPrintable(path));
        const QByteArray svg = file.readAll();
        // The cloud follows the colour scheme (Plasma recolours it for the panel).
        QVERIFY2(svg.contains("id=\"current-color-scheme\"") && svg.contains("class=\"ColorScheme-Text\""), qPrintable(path));
    }
    // The application icon, named after the app ID.
    QVERIFY(QFile::exists(QStringLiteral(KATION_ICONS_DIR "/sc-apps-com.hleroy.Kation.svg")));
    for (const QString &size : {u"16"_s, u"22"_s, u"24"_s, u"32"_s, u"48"_s, u"64"_s, u"96"_s}) {
        QVERIFY2(QFile::exists(QStringLiteral(KATION_ICONS_DIR "/") + size + u"-places-kation-folder.svg"_s), qPrintable(size));
    }
}

QTEST_MAIN(TrayTest)

#include "traytest.moc"
