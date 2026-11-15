// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Wording of kationd's reason and problem codes (kationtexts.h), in English,
 * and in French from the catalog of this build (the "french" test, run by ctest
 * as kation-texts-fr).
 */

#include "kationtexts.h"
#include "kationweb.h"

#include <QLocale>
#include <QTest>

#include <clocale>

using namespace Qt::StringLiterals;

class KationTextsTest : public QObject
{
    Q_OBJECT

private Q_SLOTS:
    void syncReasons_data();
    void syncReasons();
    void safetyPause();
    void problems();
    void storage();
    void french();
    void webUrls_data();
    void webUrls();
};

void KationTextsTest::syncReasons_data()
{
    QTest::addColumn<QVariantMap>("status");
    QTest::addColumn<QString>("expected");

    const QVariantMap paused{{u"state"_s, u"paused"_s}, {u"message"_s, u"English message"_s}, {u"folder"_s, u"/home/u/Proton Drive"_s}};
    auto with = [&](const QString &reason, const QVariantMap &extra = {}) {
        QVariantMap status = paused;
        status.insert(u"reason"_s, reason);
        status.insert(extra);
        return status;
    };
    QTest::newRow("user") << with(u"user"_s) << QString();
    QTest::newRow("deletions") << with(u"deletions"_s, {{u"deletionLimit"_s, 100u}})
                               << u"More than 100 items would be deleted at once. Check the sync folder, then resume sync to continue."_s;
    QTest::newRow("deletions, one") << with(u"deletions"_s, {{u"deletionLimit"_s, 1u}})
                                    << u"More than one item would be deleted at once. Check the sync folder, then resume sync to continue."_s;
    QTest::newRow("folder")
        << with(u"folder"_s)
        << u"The sync folder /home/u/Proton Drive is missing or was replaced. Restore it and sync resumes by itself, or turn sync off and on "
           u"again to start over."_s;
    QTest::newRow("notMounted") << with(u"notMounted"_s)
                                << u"The sync folder /home/u/Proton Drive is on a disk that is not mounted. Mount the disk and sync starts by itself."_s;
    QTest::newRow("account") << with(u"account"_s)
                             << u"You are signed in to a different Proton account than the one this folder was synced with. Turn sync off and on again to "
                                u"sync this folder with the current account instead."_s;
    QTest::newRow("signedOut") << with(u"signedOut"_s) << u"Sign in to sync."_s;
    QTest::newRow("items") << with(u"items"_s) << u"Some items could not be synced."_s;
    QTest::newRow("links") << with(u"links"_s)
                           << u"A symbolic link in the sync folder has the same name as an item in Proton Drive. Kation does not sync symbolic links, so "
                              u"that item is not synced either: rename or remove the link."_s;
    QTest::newRow("storageFull") << with(u"storageFull"_s) << u"Your Proton Drive storage is full: files you add or change are not uploaded."_s;
    QTest::newRow("error from Proton") << with(QString()) << u"English message"_s;
    QTest::newRow("newer reason") << with(u"somethingNew"_s) << u"English message"_s;
}

void KationTextsTest::syncReasons()
{
    QFETCH(QVariantMap, status);
    QFETCH(QString, expected);
    QCOMPARE(Kation::syncReasonText(status), expected);
}

void KationTextsTest::safetyPause()
{
    auto status = [](const QString &state, const QString &reason) {
        return QVariantMap{{u"state"_s, state}, {u"reason"_s, reason}};
    };
    QVERIFY(Kation::isSafetyPause(status(u"paused"_s, u"deletions"_s)));
    QVERIFY(Kation::isSafetyPause(status(u"paused"_s, u"somethingNew"_s)));
    QVERIFY(!Kation::isSafetyPause(status(u"paused"_s, u"user"_s)));
    QVERIFY(!Kation::isSafetyPause(status(u"paused"_s, QString())));
    QVERIFY(!Kation::isSafetyPause(status(u"idle"_s, QString())));
}

void KationTextsTest::problems()
{
    QCOMPARE(Kation::problemText({}), QString());
    QCOMPARE(Kation::problemText({{u"problemCode"_s, u"sessionLost"_s}, {u"problem"_s, u"English"_s}}),
             u"Your Proton session ended (it expired or was signed out elsewhere). Sign in again to continue."_s);
    const QString keyring = Kation::problemText({{u"problemCode"_s, u"keyring"_s}, {u"problemDetail"_s, u"locked"_s}});
    QVERIFY(keyring.startsWith(u"Kation cannot use your keyring"_s));
    QVERIFY(keyring.endsWith(u" (locked)"_s));
    QCOMPARE(Kation::problemText({{u"problemCode"_s, u"somethingNew"_s}, {u"problem"_s, u"English"_s}}), u"English"_s);
}

void KationTextsTest::storage()
{
    constexpr qint64 GiB = 1024LL * 1024 * 1024;
    auto status = [](qint64 used, qint64 max) {
        return QVariantMap{{u"storageUsed"_s, used}, {u"storageMax"_s, max}};
    };
    using Kation::StorageLevel;
    QCOMPARE(Kation::storageLevel({}), StorageLevel::Unknown);
    QCOMPARE(Kation::storageLevel(status(-1, -1)), StorageLevel::Unknown);
    QCOMPARE(Kation::storageLevel(status(5, 0)), StorageLevel::Unknown);
    QCOMPARE(Kation::storageLevel(status(89, 100)), StorageLevel::Ok);
    QCOMPARE(Kation::storageLevel(status(90, 100)), StorageLevel::AlmostFull);
    QCOMPARE(Kation::storageLevel(status(100, 100)), StorageLevel::Full);
    QCOMPARE(Kation::storageLevel(status(120, 100)), StorageLevel::Full);
    // Proton refused a file larger than the space left.
    QCOMPARE(Kation::storageLevel(status(50, 100), true), StorageLevel::Full);
    QCOMPARE(Kation::storageLevel({}, true), StorageLevel::Full);

    // A refusal holds while the next pass retries or sync is paused, until a pass ends without it.
    auto sync = [](const QString &state, const QString &reason = {}) {
        return QVariantMap{{u"state"_s, state}, {u"reason"_s, reason}};
    };
    QVERIFY(Kation::uploadsRefused(sync(u"error"_s, u"storageFull"_s), false));
    QVERIFY(Kation::uploadsRefused(sync(u"syncing"_s), true));
    QVERIFY(Kation::uploadsRefused(sync(u"paused"_s, u"user"_s), true));
    QVERIFY(!Kation::uploadsRefused(sync(u"syncing"_s), false));
    QVERIFY(!Kation::uploadsRefused(sync(u"idle"_s), true));
    QVERIFY(!Kation::uploadsRefused(sync(u"error"_s, u"items"_s), true));
    QVERIFY(!Kation::uploadsRefused(sync(u"disabled"_s), true));

    QCOMPARE(Kation::storagePercent(status(GiB * 3 / 2, 5 * GiB)), 30);
    QCOMPARE(Kation::storagePercent(status(-1, -1)), -1);
    QCOMPARE(Kation::storageUsageText(status(-1, -1)), QString());
    const QString usage = Kation::storageUsageText(status(GiB * 3 / 2, 5 * GiB));
    // Sizes follow the locale's number format.
    QVERIFY2(usage.startsWith(QLocale().toString(1.5, 'f', 1)) && usage.contains(u" of "_s) && usage.endsWith(u" used (30%)"_s), qPrintable(usage));

    QVERIFY(Kation::storageWarningText(StorageLevel::AlmostFull).contains(u"almost full"_s));
    QVERIFY(Kation::storageWarningText(StorageLevel::Full).contains(u"trash"_s));
    QCOMPARE(Kation::storageWarningText(StorageLevel::Ok), QString());
}

void KationTextsTest::french()
{
    if (!qEnvironmentVariable("LANGUAGE").startsWith(u"fr"_s)) {
        QSKIP("Run with LANGUAGE=fr and the build's locale folder in XDG_DATA_DIRS");
    }
    QVERIFY2(std::setlocale(LC_MESSAGES, "") != nullptr, "The locale in LC_ALL is not installed (Fedora: glibc-langpack-en)");
    QCOMPARE(Kation::syncReasonText({{u"reason"_s, u"signedOut"_s}}), u"Connectez-vous pour synchroniser."_s);
    QCOMPARE(Kation::syncReasonText({{u"reason"_s, u"deletions"_s}, {u"deletionLimit"_s, 100u}}),
             u"Plus de 100 éléments seraient supprimés d'un coup. Vérifiez le dossier synchronisé, puis reprenez la synchronisation pour continuer."_s);
    const QString usage = Kation::storageUsageText({{u"storageUsed"_s, 30}, {u"storageMax"_s, 100}});
    QVERIFY2(usage.endsWith(u" utilisés (30\u00A0%)"_s), qPrintable(usage));
}

void KationTextsTest::webUrls_data()
{
    QTest::addColumn<QString>("url");
    QTest::addColumn<bool>("accepted");
    QTest::newRow("https") << u"https://account.proton.me/x"_s << true;
    QTest::newRow("https with query") << u"https://drive.proton.me/urls/ABC#key"_s << true;
    QTest::newRow("file") << u"file:///etc/passwd"_s << false;
    QTest::newRow("javascript") << u"javascript:alert(1)"_s << false;
    QTest::newRow("smb") << u"smb://host/share"_s << false;
    QTest::newRow("http") << u"http://example.org"_s << false;
    QTest::newRow("empty") << QString() << false;
    QTest::newRow("no host") << u"https:"_s << false;
    QTest::newRow("no host, path") << u"https:/etc/passwd"_s << false;
    QTest::newRow("relative") << u"account.proton.me/x"_s << false;
}

void KationTextsTest::webUrls()
{
    QFETCH(QString, url);
    QFETCH(bool, accepted);
    QCOMPARE(Kation::isWebUrl(url), accepted);
}

QTEST_GUILESS_MAIN(KationTextsTest)

#include "kationtextstest.moc"
