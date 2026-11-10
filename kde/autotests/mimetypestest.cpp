// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include "mimetypes.h"

#include <QMimeDatabase>
#include <QTest>

using namespace Qt::StringLiterals;

class MimeTypesTest : public QObject
{
    Q_OBJECT

private Q_SLOTS:
    void fileMimeType_data();
    void fileMimeType();
};

void MimeTypesTest::fileMimeType_data()
{
    QTest::addColumn<QString>("name");
    QTest::addColumn<QString>("stored");
    QTest::addColumn<QString>("expected");

    QTest::newRow("name and type agree") << u"photo.jpg"_s << u"image/jpeg"_s << u"image/jpeg"_s;
    QTest::newRow("name wins over a disguised program") << u"photo.jpg"_s << u"application/java-archive"_s << u"image/jpeg"_s;
    QTest::newRow("name wins over HTML") << u"notes.txt"_s << u"text/html"_s << u"text/plain"_s;
    QTest::newRow("extension in capitals") << u"PHOTO.JPG"_s << u"application/x-ms-dos-executable"_s << u"image/jpeg"_s;
    QTest::newRow("name without a stored type") << u"report.pdf"_s << QString() << u"application/pdf"_s;
    QTest::newRow("ambiguous extension keeps the stored candidate") << u"clip.ts"_s << u"video/mp2t"_s << u"video/mp2t"_s;
    QTest::newRow("ambiguous extension ignores other types")
        << u"clip.ts"_s << u"application/x-shellscript"_s << QMimeDatabase().mimeTypeForFile(u"clip.ts"_s, QMimeDatabase::MatchExtension).name();

    QTest::newRow("no extension, plain text kept") << u"notes"_s << u"text/plain"_s << u"text/plain"_s;
    QTest::newRow("no extension, Markdown kept") << u"notes"_s << u"text/markdown"_s << u"text/markdown"_s;
    QTest::newRow("no extension, CSV alias resolved") << u"figures"_s << u"text/x-csv"_s << u"text/csv"_s;
    QTest::newRow("unknown extension, plain text kept") << u"notes.kation-backup"_s << u"text/plain"_s << u"text/plain"_s;

    QTest::newRow("no extension, image refused") << u"IMG_0042"_s << u"image/jpeg"_s << u"application/octet-stream"_s;
    QTest::newRow("no extension, audio refused") << u"voice memo"_s << u"audio/mpeg"_s << u"application/octet-stream"_s;
    QTest::newRow("no extension, video refused") << u"clip"_s << u"video/mp4"_s << u"application/octet-stream"_s;
    QTest::newRow("unknown extension, image refused") << u"photo.kation-backup"_s << u"image/png"_s << u"application/octet-stream"_s;
    QTest::newRow("no extension, program refused") << u"setup"_s << u"application/java-archive"_s << u"application/octet-stream"_s;
    QTest::newRow("no extension, HTML refused") << u"page"_s << u"text/html"_s << u"application/octet-stream"_s;
    QTest::newRow("no extension, SVG refused") << u"logo"_s << u"image/svg+xml"_s << u"application/octet-stream"_s;
    QTest::newRow("no extension, EPS refused") << u"Invoice"_s << u"image/x-eps"_s << u"application/octet-stream"_s;
    QTest::newRow("no extension, playlist refused") << u"song"_s << u"audio/x-mpegurl"_s << u"application/octet-stream"_s;
    QTest::newRow("no extension, script alias refused") << u"run"_s << u"text/x-sh"_s << u"application/octet-stream"_s;
    QTest::newRow("no extension, Python refused") << u"tool"_s << u"text/x-python3"_s << u"application/octet-stream"_s;
    QTest::newRow("no extension, desktop file refused") << u"launcher"_s << u"application/x-desktop"_s << u"application/octet-stream"_s;
    QTest::newRow("no extension, Proton Docs") << u"Meeting notes"_s << u"application/vnd.proton.doc"_s << u"application/octet-stream"_s;
    QTest::newRow("no extension, no stored type") << u"thing"_s << QString() << u"application/octet-stream"_s;
}

void MimeTypesTest::fileMimeType()
{
    QFETCH(QString, name);
    QFETCH(QString, stored);
    QFETCH(QString, expected);
    QCOMPARE(Kation::fileMimeType(name, stored), expected);
}

QTEST_GUILESS_MAIN(MimeTypesTest)

#include "mimetypestest.moc"
