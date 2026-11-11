// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * End-to-end test of the KIO worker: KIO jobs -> kio_protondrive -> D-Bus ->
 * kationd serving an in-memory drive. Run inside its own session bus.
 */

#include "fakekationd.h"
#include "kationdriveinterface.h"
#include "kationtypes.h"

#include <KIO/CopyJob>
#include <KIO/DeleteJob>
#include <KIO/FileCopyJob>
#include <KIO/ListJob>
#include <KIO/MkdirJob>
#include <KIO/StatJob>
#include <KIO/StoredTransferJob>

#include <QDBusConnection>
#include <QDBusConnectionInterface>
#include <QDir>
#include <QFile>
#include <QRandomGenerator>
#include <QTemporaryDir>
#include <QTest>

using namespace Qt::StringLiterals;

namespace
{
QUrl driveUrl(const QString &path)
{
    QUrl url;
    url.setScheme(u"protondrive"_s);
    url.setPath(path);
    return url;
}

QByteArray randomBytes(qsizetype size)
{
    QByteArray bytes(size, Qt::Uninitialized);
    QRandomGenerator generator(42);
    for (char &byte : bytes) {
        byte = char(generator.bounded(256));
    }
    return bytes;
}

void writeFile(const QString &path, const QByteArray &content)
{
    QFile file(path);
    QVERIFY(file.open(QIODevice::WriteOnly));
    QCOMPARE(file.write(content), content.size());
}

QByteArray readFile(const QString &path)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
        return {};
    }
    return file.readAll();
}
}

class KioWorkerTest : public QObject
{
    Q_OBJECT

private Q_SLOTS:
    void initTestCase();
    void cleanupTestCase();

    void listsEmptyRoot();
    void createsFolders();
    void putsAndGetsFiles();
    void keepsItsCacheFolderPrivate();
    void copiesLocalFilesBothWays();
    void listsFolderContent();
    void renamesAndMoves();
    void reportsTypesFromNames();
    void copiesFolderTrees();
    void deletesFoldersRecursively();
    void reportsMissingFiles();
    void reloadsViewsOnRemoteChanges();
    void requiresSignIn();

public Q_SLOTS:
    void onFilesAdded(const QString &url)
    {
        m_addedNotifications.append(url);
    }

private:
    QStringList listNames(const QUrl &url);
    QStringList m_addedNotifications;

    QTemporaryDir m_home;
    std::unique_ptr<FakeKationd> m_kationd;
    KationDriveInterface *m_drive = nullptr;
};

void KioWorkerTest::initTestCase()
{
    QVERIFY(m_home.isValid());
    Kation::registerDBusTypes();
    // Also keeps the worker's spool, caches and logs in the test folder.
    m_kationd = std::make_unique<FakeKationd>(m_home);
    QVERIFY(m_kationd->start());
    // kationd made it private as it started: check that the worker does too.
    QVERIFY(QFile::setPermissions(m_home.filePath(u"cache/kation"_s),
                                  QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner | QFileDevice::ReadGroup | QFileDevice::ExeGroup
                                      | QFileDevice::ReadOther | QFileDevice::ExeOther));

    m_drive = new KationDriveInterface(Kation::serviceName, Kation::objectPath, QDBusConnection::sessionBus(), this);
}

void KioWorkerTest::cleanupTestCase()
{
    QVERIFY2(m_kationd->stop(), "kationd did not exit cleanly");
}

QStringList KioWorkerTest::listNames(const QUrl &url)
{
    KIO::ListJob *job = KIO::listDir(url, KIO::HideProgressInfo);
    QStringList names;
    connect(job, &KIO::ListJob::entries, this, [&names](KIO::Job *, const KIO::UDSEntryList &entries) {
        for (const KIO::UDSEntry &entry : entries) {
            names.append(entry.stringValue(KIO::UDSEntry::UDS_NAME));
        }
    });
    if (!job->exec()) {
        qWarning() << "listDir failed:" << job->errorString();
        return {u"<error>"_s};
    }
    names.sort();
    return names;
}

void KioWorkerTest::listsEmptyRoot()
{
    QCOMPARE(listNames(driveUrl(u"/"_s)), QStringList{u"."_s});

    KIO::StatJob *stat = KIO::stat(driveUrl(u"/"_s), KIO::HideProgressInfo);
    QVERIFY2(stat->exec(), qPrintable(stat->errorString()));
    QVERIFY(stat->statResult().isDir());
}

void KioWorkerTest::createsFolders()
{
    KIO::SimpleJob *mkdir = KIO::mkdir(driveUrl(u"/Docs"_s));
    QVERIFY2(mkdir->exec(), qPrintable(mkdir->errorString()));

    KIO::StatJob *stat = KIO::stat(driveUrl(u"/Docs"_s), KIO::HideProgressInfo);
    QVERIFY2(stat->exec(), qPrintable(stat->errorString()));
    QVERIFY(stat->statResult().isDir());
    QCOMPARE(stat->statResult().stringValue(KIO::UDSEntry::UDS_MIME_TYPE), u"inode/directory"_s);

    KIO::SimpleJob *again = KIO::mkdir(driveUrl(u"/Docs"_s));
    QVERIFY(!again->exec());
    QCOMPARE(again->error(), int(KIO::ERR_DIR_ALREADY_EXIST));
}

void KioWorkerTest::putsAndGetsFiles()
{
    const QUrl url = driveUrl(u"/Docs/a.txt"_s);
    KIO::StoredTransferJob *put = KIO::storedPut(QByteArray("hello"), url, -1, KIO::HideProgressInfo);
    QVERIFY2(put->exec(), qPrintable(put->errorString()));

    KIO::StoredTransferJob *get = KIO::storedGet(url, KIO::NoReload, KIO::HideProgressInfo);
    QVERIFY2(get->exec(), qPrintable(get->errorString()));
    QCOMPARE(get->data(), QByteArray("hello"));
    QCOMPARE(get->mimetype(), u"text/plain"_s);

    KIO::StoredTransferJob *refused = KIO::storedPut(QByteArray("again"), url, -1, KIO::HideProgressInfo);
    QVERIFY(!refused->exec());
    QCOMPARE(refused->error(), int(KIO::ERR_FILE_ALREADY_EXIST));

    KIO::StoredTransferJob *overwrite = KIO::storedPut(QByteArray("bye"), url, -1, KIO::Overwrite | KIO::HideProgressInfo);
    QVERIFY2(overwrite->exec(), qPrintable(overwrite->errorString()));
    KIO::StoredTransferJob *getAgain = KIO::storedGet(url, KIO::Reload, KIO::HideProgressInfo);
    QVERIFY2(getAgain->exec(), qPrintable(getAgain->errorString()));
    QCOMPARE(getAgain->data(), QByteArray("bye"));

    KIO::StoredTransferJob *folder = KIO::storedGet(driveUrl(u"/Docs"_s), KIO::NoReload, KIO::HideProgressInfo);
    QVERIFY(!folder->exec());
    QCOMPARE(folder->error(), int(KIO::ERR_IS_DIRECTORY));
}

void KioWorkerTest::keepsItsCacheFolderPrivate()
{
    const auto ownerOnly = QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner;
    const auto others =
        QFileDevice::ReadGroup | QFileDevice::WriteGroup | QFileDevice::ExeGroup | QFileDevice::ReadOther | QFileDevice::WriteOther | QFileDevice::ExeOther;
    for (const QString &folder : {u"cache/kation"_s, u"cache/kation/spool"_s}) {
        const QFileDevice::Permissions permissions = QFile::permissions(m_home.filePath(folder));
        QVERIFY2((permissions & ownerOnly) == ownerOnly, qPrintable(folder));
        QVERIFY2(!(permissions & others), qPrintable(folder));
    }
}

void KioWorkerTest::copiesLocalFilesBothWays()
{
    // Large enough for several chunks; the worker passes local paths to kationd.
    const QByteArray content = randomBytes(2'500'000);
    const QString source = m_home.filePath(u"big.bin"_s);
    writeFile(source, content);
    const QDateTime mtime = QDateTime::fromSecsSinceEpoch(1'700'000'000);
    {
        QFile file(source);
        QVERIFY(file.open(QIODevice::ReadWrite));
        QVERIFY(file.setFileTime(mtime, QFileDevice::FileModificationTime));
    }

    const QUrl remote = driveUrl(u"/Docs/big.bin"_s);
    KIO::FileCopyJob *upload = KIO::file_copy(QUrl::fromLocalFile(source), remote, -1, KIO::HideProgressInfo);
    QVERIFY2(upload->exec(), qPrintable(upload->errorString()));

    KIO::StatJob *stat = KIO::stat(remote, KIO::HideProgressInfo);
    QVERIFY2(stat->exec(), qPrintable(stat->errorString()));
    QCOMPARE(stat->statResult().numberValue(KIO::UDSEntry::UDS_SIZE), content.size());
    QCOMPARE(stat->statResult().numberValue(KIO::UDSEntry::UDS_MODIFICATION_TIME), mtime.toSecsSinceEpoch());
    QCOMPARE(stat->statResult().stringValue(KIO::UDSEntry::UDS_MIME_TYPE), u"application/octet-stream"_s);

    const QString target = m_home.filePath(u"downloaded.bin"_s);
    KIO::FileCopyJob *download = KIO::file_copy(remote, QUrl::fromLocalFile(target), -1, KIO::HideProgressInfo);
    QVERIFY2(download->exec(), qPrintable(download->errorString()));
    QCOMPARE(readFile(target), content);
    QCOMPARE(QFileInfo(target).lastModified().toSecsSinceEpoch(), mtime.toSecsSinceEpoch());

    KIO::FileCopyJob *refused = KIO::file_copy(remote, QUrl::fromLocalFile(target), -1, KIO::HideProgressInfo);
    QVERIFY(!refused->exec());
    QCOMPARE(refused->error(), int(KIO::ERR_FILE_ALREADY_EXIST));
}

void KioWorkerTest::listsFolderContent()
{
    QCOMPARE(listNames(driveUrl(u"/Docs"_s)), (QStringList{u"."_s, u"a.txt"_s, u"big.bin"_s}));
    QCOMPARE(listNames(driveUrl(u"/"_s)), (QStringList{u"."_s, u"Docs"_s}));
}

void KioWorkerTest::renamesAndMoves()
{
    KIO::SimpleJob *rename = KIO::rename(driveUrl(u"/Docs/a.txt"_s), driveUrl(u"/Docs/b.txt"_s), KIO::HideProgressInfo);
    QVERIFY2(rename->exec(), qPrintable(rename->errorString()));

    KIO::CopyJob *move = KIO::moveAs(driveUrl(u"/Docs/b.txt"_s), driveUrl(u"/moved.txt"_s), KIO::HideProgressInfo);
    QVERIFY2(move->exec(), qPrintable(move->errorString()));

    QCOMPARE(listNames(driveUrl(u"/"_s)), (QStringList{u"."_s, u"Docs"_s, u"moved.txt"_s}));
    QCOMPARE(listNames(driveUrl(u"/Docs"_s)), (QStringList{u"."_s, u"big.bin"_s}));

    KIO::StoredTransferJob *get = KIO::storedGet(driveUrl(u"/moved.txt"_s), KIO::NoReload, KIO::HideProgressInfo);
    QVERIFY2(get->exec(), qPrintable(get->errorString()));
    QCOMPARE(get->data(), QByteArray("bye"));
}

void KioWorkerTest::reportsTypesFromNames()
{
    // A rename keeps the stored type, like a client that uploads with any type it likes.
    const QUrl payload = driveUrl(u"/payload.jar"_s);
    KIO::StoredTransferJob *put = KIO::storedPut(QByteArray("PK"), payload, -1, KIO::HideProgressInfo);
    QVERIFY2(put->exec(), qPrintable(put->errorString()));
    QDBusPendingReply<QVariantMap> stored = m_drive->Stat(u"/payload.jar"_s);
    stored.waitForFinished();
    QVERIFY2(!stored.isError(), qPrintable(stored.error().message()));
    QCOMPARE(stored.value().value(u"mimeType"_s).toString(), u"application/java-archive"_s);
    const QUrl photo = driveUrl(u"/photo.jpg"_s);
    KIO::SimpleJob *rename = KIO::rename(payload, photo, KIO::HideProgressInfo);
    QVERIFY2(rename->exec(), qPrintable(rename->errorString()));

    KIO::StatJob *stat = KIO::stat(photo, KIO::HideProgressInfo);
    QVERIFY2(stat->exec(), qPrintable(stat->errorString()));
    QCOMPARE(stat->statResult().stringValue(KIO::UDSEntry::UDS_MIME_TYPE), u"image/jpeg"_s);
    KIO::StoredTransferJob *get = KIO::storedGet(photo, KIO::NoReload, KIO::HideProgressInfo);
    QVERIFY2(get->exec(), qPrintable(get->errorString()));
    QCOMPARE(get->mimetype(), u"image/jpeg"_s);

    const QUrl setup = driveUrl(u"/setup"_s);
    KIO::SimpleJob *strip = KIO::rename(photo, setup, KIO::HideProgressInfo);
    QVERIFY2(strip->exec(), qPrintable(strip->errorString()));
    KIO::StatJob *statSetup = KIO::stat(setup, KIO::HideProgressInfo);
    QVERIFY2(statSetup->exec(), qPrintable(statSetup->errorString()));
    QCOMPARE(statSetup->statResult().stringValue(KIO::UDSEntry::UDS_MIME_TYPE), u"application/octet-stream"_s);
    KIO::StoredTransferJob *getSetup = KIO::storedGet(setup, KIO::NoReload, KIO::HideProgressInfo);
    QVERIFY2(getSetup->exec(), qPrintable(getSetup->errorString()));
    QCOMPARE(getSetup->mimetype(), u"application/octet-stream"_s);

    KIO::DeleteJob *del = KIO::del(setup, KIO::HideProgressInfo);
    QVERIFY2(del->exec(), qPrintable(del->errorString()));
}

void KioWorkerTest::copiesFolderTrees()
{
    const QString tree = m_home.filePath(u"Photos"_s);
    QVERIFY(QDir().mkpath(tree + u"/2026/summer"_s));
    writeFile(tree + u"/readme.md"_s, "# Photos");
    writeFile(tree + u"/2026/summer/beach.jpg"_s, randomBytes(70'000));

    KIO::CopyJob *copy = KIO::copy(QUrl::fromLocalFile(tree), driveUrl(u"/"_s), KIO::HideProgressInfo);
    QVERIFY2(copy->exec(), qPrintable(copy->errorString()));

    QCOMPARE(listNames(driveUrl(u"/Photos"_s)), (QStringList{u"."_s, u"2026"_s, u"readme.md"_s}));
    QCOMPARE(listNames(driveUrl(u"/Photos/2026/summer"_s)), (QStringList{u"."_s, u"beach.jpg"_s}));

    KIO::StatJob *stat = KIO::stat(driveUrl(u"/Photos/2026/summer/beach.jpg"_s), KIO::HideProgressInfo);
    QVERIFY2(stat->exec(), qPrintable(stat->errorString()));
    QCOMPARE(stat->statResult().stringValue(KIO::UDSEntry::UDS_MIME_TYPE), u"image/jpeg"_s);
}

void KioWorkerTest::deletesFoldersRecursively()
{
    KIO::DeleteJob *del = KIO::del(driveUrl(u"/Photos"_s), KIO::HideProgressInfo);
    QVERIFY2(del->exec(), qPrintable(del->errorString()));
    QCOMPARE(listNames(driveUrl(u"/"_s)), (QStringList{u"."_s, u"Docs"_s, u"moved.txt"_s}));
}

void KioWorkerTest::reportsMissingFiles()
{
    KIO::StatJob *stat = KIO::stat(driveUrl(u"/nope.txt"_s), KIO::HideProgressInfo);
    QVERIFY(!stat->exec());
    QCOMPARE(stat->error(), int(KIO::ERR_DOES_NOT_EXIST));

    KIO::StoredTransferJob *get = KIO::storedGet(driveUrl(u"/Docs/nope.txt"_s), KIO::NoReload, KIO::HideProgressInfo);
    QVERIFY(!get->exec());
    QCOMPARE(get->error(), int(KIO::ERR_DOES_NOT_EXIST));
}

void KioWorkerTest::reloadsViewsOnRemoteChanges()
{
    // kationd tells KIO clients to reload a folder they have listed when it changes.
    QVERIFY(QDBusConnection::sessionBus().connect(QString(), QString(), u"org.kde.KDirNotify"_s, u"FilesAdded"_s, this, SLOT(onFilesAdded(QString))));

    QCOMPARE(listNames(driveUrl(u"/Docs"_s)), (QStringList{u"."_s, u"big.bin"_s}));
    QDBusPendingReply<> reply = m_drive->CreateFolder(u"/Docs/FromElsewhere"_s);
    reply.waitForFinished();
    QVERIFY2(!reply.isError(), qPrintable(reply.error().message()));
    QTRY_VERIFY_WITH_TIMEOUT(m_addedNotifications.contains(u"protondrive:/Docs"_s), 5000);
}

void KioWorkerTest::requiresSignIn()
{
    QDBusPendingReply<> logout = m_drive->Logout();
    logout.waitForFinished();
    QVERIFY2(!logout.isError(), qPrintable(logout.error().message()));

    KIO::ListJob *list = KIO::listDir(driveUrl(u"/"_s), KIO::HideProgressInfo);
    QVERIFY(!list->exec());
    QCOMPARE(list->error(), int(KIO::ERR_WORKER_DEFINED));
    QVERIFY2(list->errorString().contains(u"not signed in"_s), qPrintable(list->errorString()));
}

QTEST_GUILESS_MAIN(KioWorkerTest)

#include "kioworkertest.moc"
