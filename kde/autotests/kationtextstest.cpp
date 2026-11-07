// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Wording of kationd's reason and problem codes (kationtexts.h), in English,
 * and in French from the catalog of this build (the "french" test, run by ctest
 * as kation-texts-fr).
 */

#include "kationtexts.h"

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
    void french();
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

void KationTextsTest::french()
{
    if (!qEnvironmentVariable("LANGUAGE").startsWith(u"fr"_s)) {
        QSKIP("Run with LANGUAGE=fr and the build's locale folder in XDG_DATA_DIRS");
    }
    QVERIFY2(std::setlocale(LC_MESSAGES, "") != nullptr, "The locale in LC_ALL is not installed (Fedora: glibc-langpack-en)");
    QCOMPARE(Kation::syncReasonText({{u"reason"_s, u"signedOut"_s}}), u"Connectez-vous pour synchroniser."_s);
    QCOMPARE(Kation::syncReasonText({{u"reason"_s, u"deletions"_s}, {u"deletionLimit"_s, 100u}}),
             u"Plus de 100 éléments seraient supprimés d'un coup. Vérifiez le dossier synchronisé, puis reprenez la synchronisation pour continuer."_s);
}

QTEST_GUILESS_MAIN(KationTextsTest)

#include "kationtextstest.moc"
