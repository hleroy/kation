// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * How the tray app tells that a package upgrade replaced its program: a running
 * copy of `sleep` stands in for it, and its file is replaced the way dpkg, rpm and
 * pacman do (a new file renamed over it).
 */

#include "selfupdate.h"

#include <QCoreApplication>
#include <QFile>
#include <QProcess>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QTest>
#include <QWidget>

#include <cstdio>

using namespace Qt::StringLiterals;

class SelfUpdateTest : public QObject
{
    Q_OBJECT

private Q_SLOTS:
    void ownProgram();
    void replacedProgram();
    void relaunchesWithoutWindow();
    void relaunchesWhenTheWindowCloses();
};

void SelfUpdateTest::ownProgram()
{
    QCOMPARE(Kation::executablePath(), QCoreApplication::applicationFilePath());
    QVERIFY(!Kation::executableReplaced());
    QCOMPARE(Kation::executablePath(u"/proc/0/nothing"_s), QString());
    QVERIFY(!Kation::executableReplaced(u"/proc/0/nothing"_s));
}

void SelfUpdateTest::replacedProgram()
{
    const QString sleep = QStandardPaths::findExecutable(u"sleep"_s);
    QVERIFY(!sleep.isEmpty());
    QTemporaryDir dir;
    const QString program = dir.filePath(u"kation"_s);
    QVERIFY(QFile::copy(sleep, program));
    QVERIFY(QFile::setPermissions(program, QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner));

    QProcess process;
    process.start(program, {u"60"_s});
    QVERIFY(process.waitForStarted());
    const QString procExe = u"/proc/%1/exe"_s.arg(process.processId());
    QCOMPARE(Kation::executablePath(procExe), program);
    QVERIFY(!Kation::executableReplaced(procExe));

    const QString update = dir.filePath(u"kation.new"_s);
    QVERIFY(QFile::copy(sleep, update));
    QCOMPARE(std::rename(QFile::encodeName(update).constData(), QFile::encodeName(program).constData()), 0);
    QCOMPARE(Kation::executablePath(procExe), program);
    QVERIFY(Kation::executableReplaced(procExe));

    // Removed, not upgraded: nothing to run instead.
    QVERIFY(QFile::remove(program));
    QVERIFY(!Kation::executableReplaced(procExe));

    process.kill();
    process.waitForFinished();
}

void SelfUpdateTest::relaunchesWithoutWindow()
{
    int runs = 0;
    Kation::DeferredRelaunch relaunch([&runs] {
        ++runs;
    });
    relaunch.request();
    relaunch.request();
    QCOMPARE(runs, 1);
}

void SelfUpdateTest::relaunchesWhenTheWindowCloses()
{
    int runs = 0;
    Kation::DeferredRelaunch relaunch([&runs] {
        ++runs;
    });
    // The settings window: a widget deleted when closed. QWidget emits destroyed()
    // before its QPointers are cleared, the case that kept the tray from relaunching.
    auto window = new QWidget;
    window->setAttribute(Qt::WA_DeleteOnClose);
    window->show();
    relaunch.setWindow(window);
    relaunch.request();
    QCOMPARE(runs, 0);
    QPointer<QWidget> guard(window);
    window->close();
    QTRY_VERIFY(!guard);
    QCOMPARE(runs, 1);

    // A window opened after the relaunch ran changes nothing.
    auto other = new QWidget;
    relaunch.setWindow(other);
    delete other;
    QCOMPARE(runs, 1);
}

QTEST_MAIN(SelfUpdateTest)

#include "selfupdatetest.moc"
