// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * The settings (sign-in, sync) against kationd serving a fake drive: signed out ->
 * browser sign-in -> signed in -> signed out. Set KATION_SCREENSHOT_DIR to
 * save a picture of each state.
 */

#include "settingswidget.h"
#include "fakekationd.h"
#include "kationdriveinterface.h"

#include "trayautostart.h"

#include <KCModule>
#include <KCModuleLoader>
#include <KPluginMetaData>

#include <QCheckBox>
#include <QDesktopServices>
#include <QDir>
#include <QFileInfo>
#include <QLabel>
#include <QPushButton>
#include <QSignalSpy>
#include <QSpinBox>
#include <QTabWidget>
#include <QTest>
#include <QTreeWidget>

using namespace Qt::StringLiterals;

class SettingsWidgetTest : public QObject
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
    void signsInAndOut();
    void foldersLimitsAndStartup();
    void systemSettingsMode();
    void loadsInSystemSettings();

private:
    QString state() const;
    QStringList remoteNames() const;
    QPushButton *button(const char *name) const;
    void screenshot(const QString &name);
    bool nothingClipped() const;

    QTemporaryDir m_home;
    std::unique_ptr<FakeKationd> m_kationd;
    std::unique_ptr<KationSettingsWidget> m_window;
    QList<QUrl> m_openedUrls;
};

void SettingsWidgetTest::initTestCase()
{
    Kation::registerDBusTypes();
    QProcessEnvironment env;
    env.insert(u"KATION_FAKE_LOGGED_IN"_s, u"0"_s);
    env.insert(u"KATION_FAKE_LOGIN_DELAY_MS"_s, u"500"_s);
    m_kationd = std::make_unique<FakeKationd>(m_home, env);
    QVERIFY(m_kationd->start());
    QDesktopServices::setUrlHandler(u"https"_s, this, "openUrl");
}

void SettingsWidgetTest::cleanupTestCase()
{
    m_window.reset();
    QDesktopServices::unsetUrlHandler(u"https"_s);
    QVERIFY2(m_kationd->stop(), "kationd did not exit cleanly");
}

QString SettingsWidgetTest::state() const
{
    return m_window->findChild<QLabel *>(u"state"_s)->text();
}

QStringList SettingsWidgetTest::remoteNames() const
{
    KationDriveInterface drive(Kation::serviceName, Kation::objectPath, QDBusConnection::sessionBus());
    QDBusPendingReply<QVariantMapList> reply = drive.List(u"/"_s);
    reply.waitForFinished();
    QStringList names;
    for (const QVariantMap &entry : reply.value()) {
        names.append(entry.value(u"name"_s).toString());
    }
    return names;
}

QPushButton *SettingsWidgetTest::button(const char *name) const
{
    return m_window->findChild<QPushButton *>(QString::fromLatin1(name));
}

void SettingsWidgetTest::screenshot(const QString &name)
{
    const QString dir = qEnvironmentVariable("KATION_SCREENSHOT_DIR");
    if (!dir.isEmpty()) {
        QDir().mkpath(dir);
        QVERIFY(m_window->grab().save(dir + u'/' + name + u".png"_s));
    }
}

bool SettingsWidgetTest::nothingClipped() const
{
    for (auto label : m_window->findChildren<QLabel *>()) {
        const int needed = label->wordWrap() ? label->heightForWidth(label->width()) : label->minimumSizeHint().height();
        if (label->isVisible() && label->height() < needed) {
            qWarning() << "Clipped label" << label->objectName() << label->size() << needed;
            return false;
        }
    }
    for (auto button : m_window->findChildren<QPushButton *>()) {
        if (button->isVisible() && button->height() < button->minimumSizeHint().height()) {
            qWarning() << "Clipped button" << button->objectName() << button->size() << button->minimumSizeHint();
            return false;
        }
    }
    return true;
}

void SettingsWidgetTest::signsInAndOut()
{
    m_window = std::make_unique<KationSettingsWidget>();
    m_window->resize(520, 220);
    m_window->show();
    QVERIFY(QTest::qWaitForWindowExposed(m_window.get()));

    QTRY_COMPARE(state(), u"Not signed in"_s);
    QVERIFY(m_window->findChild<QLabel *>(u"notice"_s)->isEnabled());
    QVERIFY(button("signIn")->isVisible());
    QVERIFY(!button("signOut")->isVisible());
    screenshot(u"1-signed-out"_s);

    QTest::mouseClick(button("signIn"), Qt::LeftButton);
    QTRY_COMPARE(m_openedUrls.size(), 1);
    QVERIFY(m_openedUrls.first().toString().startsWith(u"https://account.proton.me/"_s));
    QTRY_COMPARE(state(), u"Waiting for sign-in…"_s);
    QVERIFY(button("cancel")->isVisible());
    QVERIFY(button("copyLink")->isVisible());
    screenshot(u"2-waiting"_s);

    QTRY_COMPARE_WITH_TIMEOUT(state(), u"Signed in"_s, 5000);
    QVERIFY(m_window->findChild<QLabel *>(u"details"_s)->text().contains(u"tester@example.com"_s));
    QVERIFY(button("signOut")->isVisible());
    QVERIFY(button("openFiles")->isVisible());
    screenshot(u"3-signed-in"_s);

    // Folder sync: off by default, then on.
    auto syncState = m_window->findChild<QLabel *>(u"syncState"_s);
    QTRY_VERIFY(syncState->text().startsWith(u"Sync is off"_s));
    QVERIFY(m_window->findChild<QLabel *>(u"syncFolder"_s)->text().contains(u"Proton Drive"_s));
    QCOMPARE(button("openFiles")->text(), u"Open Online View"_s);
    QVERIFY(m_window->findChild<QLabel *>(u"online"_s)->text().contains(u"even while sync is paused"_s));
    QTest::mouseClick(button("syncToggle"), Qt::LeftButton);
    QTRY_VERIFY_WITH_TIMEOUT(syncState->text().startsWith(u"Up to date"_s), 5000);
    QVERIFY(QFileInfo::exists(m_home.filePath(u"Proton Drive/.kation-sync"_s)));
    QCOMPARE(button("openFiles")->text(), u"Open Synced Folder"_s);
    QVERIFY(button("syncPause")->isVisible());
    QVERIFY(!button("syncChooseFolder")->isVisible());
    // The window was 220 px high before the sync section appeared: it must grow, not squeeze it.
    QTRY_VERIFY2(nothingClipped(), "Text or buttons of the window are cut off");
    screenshot(u"4-syncing"_s);

    // Pausing from the window must stop transfers: a new local file stays local.
    QTest::mouseClick(button("syncPause"), Qt::LeftButton);
    QTRY_VERIFY(syncState->text().startsWith(u"Paused"_s));
    QTRY_COMPARE(button("syncPause")->text(), u"Resume"_s);
    {
        QFile file(m_home.filePath(u"Proton Drive/while-paused.txt"_s));
        QVERIFY(file.open(QIODevice::WriteOnly));
        file.write("local only");
    }
    QTest::qWait(3000);
    QVERIFY2(!remoteNames().contains(u"while-paused.txt"_s), "A file was uploaded while sync was paused");
    QTest::mouseClick(button("syncPause"), Qt::LeftButton);
    QTRY_VERIFY_WITH_TIMEOUT(remoteNames().contains(u"while-paused.txt"_s), 10000);

    QTest::mouseClick(button("syncPause"), Qt::LeftButton);
    QTRY_VERIFY(syncState->text().startsWith(u"Paused"_s));
    QTest::mouseClick(button("syncToggle"), Qt::LeftButton);
    QTRY_VERIFY(syncState->text().startsWith(u"Sync is off"_s));

    QTest::mouseClick(button("signOut"), Qt::LeftButton);
    QTRY_COMPARE(state(), u"Not signed in"_s);
}

static QVariantMap syncStatus()
{
    KationDriveInterface drive(Kation::serviceName, Kation::objectPath, QDBusConnection::sessionBus());
    QDBusPendingReply<QVariantMap> reply = drive.GetSyncStatus();
    reply.waitForFinished();
    return reply.value();
}

static QTreeWidgetItem *childNamed(QTreeWidgetItem *parent, const QString &name)
{
    for (int i = 0; i < parent->childCount(); ++i) {
        if (parent->child(i)->text(0) == name) {
            return parent->child(i);
        }
    }
    return nullptr;
}

void SettingsWidgetTest::foldersLimitsAndStartup()
{
    // Signed out at the end of the previous test: sign in again.
    QTest::mouseClick(button("signIn"), Qt::LeftButton);
    QTRY_COMPARE_WITH_TIMEOUT(state(), u"Signed in"_s, 5000);
    m_window->setAutoSave(true);

    KationDriveInterface drive(Kation::serviceName, Kation::objectPath, QDBusConnection::sessionBus());
    for (const QString &folder : {u"/Docs"_s, u"/Docs/Sub"_s, u"/Videos"_s}) {
        drive.CreateFolder(folder).waitForFinished();
    }

    // Folders to sync: unchecking a folder excludes it, and everything inside it.
    auto tabs = m_window->findChild<QTabWidget *>(u"tabs"_s);
    QVERIFY(tabs->isTabEnabled(1));
    tabs->setCurrentIndex(1);
    auto tree = m_window->findChild<QTreeWidget *>(u"folders"_s);
    QTRY_COMPARE(tree->topLevelItemCount(), 2);
    QTreeWidgetItem *docs = tree->topLevelItem(0);
    QTreeWidgetItem *videos = tree->topLevelItem(1);
    QCOMPARE(docs->text(0), u"Docs"_s);
    QCOMPARE(videos->checkState(0), Qt::Checked);

    videos->setCheckState(0, Qt::Unchecked);
    QTRY_COMPARE(syncStatus().value(u"excluded"_s).toStringList(), QStringList{u"/Videos"_s});

    docs->setExpanded(true);
    QTRY_VERIFY(childNamed(docs, u"Sub"_s));
    QTreeWidgetItem *sub = childNamed(docs, u"Sub"_s);
    QVERIFY(!sub->isDisabled());
    sub->setCheckState(0, Qt::Unchecked);
    QTRY_COMPARE(syncStatus().value(u"excluded"_s).toStringList(), (QStringList{u"/Docs/Sub"_s, u"/Videos"_s}));
    docs->setCheckState(0, Qt::Unchecked);
    QVERIFY(sub->isDisabled());
    QCOMPARE(sub->checkState(0), Qt::Unchecked);
    QTRY_COMPARE(syncStatus().value(u"excluded"_s).toStringList(), (QStringList{u"/Docs"_s, u"/Videos"_s}));
    docs->setCheckState(0, Qt::Checked);
    QVERIFY(!sub->isDisabled());
    QCOMPARE(sub->checkState(0), Qt::Checked);
    QTRY_COMPARE(syncStatus().value(u"excluded"_s).toStringList(), QStringList{u"/Videos"_s});
    screenshot(u"5-folders"_s);

    // Speed limits and the tray at login.
    tabs->setCurrentIndex(2);
    m_window->findChild<QCheckBox *>(u"limitUpload"_s)->setChecked(true);
    m_window->findChild<QSpinBox *>(u"uploadLimit"_s)->setValue(300);
    QTRY_COMPARE(syncStatus().value(u"uploadLimit"_s).toUInt(), 300u);
    QCOMPARE(syncStatus().value(u"downloadLimit"_s).toUInt(), 0u);

    auto tray = m_window->findChild<QCheckBox *>(u"trayAtLogin"_s);
    QVERIFY(tray->isChecked());
    tray->setChecked(false);
    QTRY_VERIFY(!Kation::trayAtLogin());
    QVERIFY(!QFileInfo::exists(Kation::trayAutostartPath()));
    tray->setChecked(true);
    QTRY_VERIFY(QFileInfo::exists(Kation::trayAutostartPath()));
    QVERIFY(Kation::trayAutostartPath().startsWith(m_home.path()));
    QTRY_VERIFY(!m_window->hasChanges());
    screenshot(u"6-network-startup"_s);
}

void SettingsWidgetTest::systemSettingsMode()
{
    // In System Settings, changes wait for Apply.
    KationSettingsWidget module;
    QTRY_VERIFY(module.findChild<QLabel *>(u"state"_s)->text() == u"Signed in"_s);
    auto limitDownload = module.findChild<QCheckBox *>(u"limitDownload"_s);
    QTRY_VERIFY(module.findChild<QCheckBox *>(u"limitUpload"_s)->isChecked()); // loaded from kationd
    QSignalSpy changed(&module, &KationSettingsWidget::changed);
    limitDownload->setChecked(true);
    module.findChild<QSpinBox *>(u"downloadLimit"_s)->setValue(2048);
    QVERIFY(!changed.isEmpty());
    QVERIFY(changed.last().at(0).toBool());
    QTest::qWait(1000);
    QCOMPARE(syncStatus().value(u"downloadLimit"_s).toUInt(), 0u);
    module.save();
    QTRY_COMPARE(syncStatus().value(u"downloadLimit"_s).toUInt(), 2048u);
    QVERIFY(!module.hasChanges());

    module.defaults();
    QVERIFY(module.hasChanges());
    module.save();
    QTRY_COMPARE(syncStatus().value(u"uploadLimit"_s).toUInt(), 0u);
    QTRY_COMPARE(syncStatus().value(u"excluded"_s).toStringList(), QStringList{});
}

void SettingsWidgetTest::loadsInSystemSettings()
{
    const KPluginMetaData metaData(QStringLiteral(KATION_KCM_PLUGIN));
    QVERIFY(metaData.isValid());
    QCOMPARE(metaData.value(u"X-KDE-System-Settings-Parent-Category"_s), u"network"_s);
    QWidget parent;
    KCModule *module = KCModuleLoader::loadModule(metaData, &parent);
    QVERIFY(module);
    // The plugin has its own copy of the widget class: look it up by name.
    QVERIFY(module->widget()->findChild<QTabWidget *>(u"tabs"_s));
    QVERIFY(module->buttons() & KCModule::Apply);
    delete module;
}

QTEST_MAIN(SettingsWidgetTest)

#include "settingswidgettest.moc"
