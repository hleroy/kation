// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include "protondriveworker.h"

#include "errors.h"
#include "kationdriveinterface.h"
#include "kationtypes.h"
#include "logging.h"
#include "mimetypes.h"

#include <KIO/UDSEntry>
#include <KLocalizedString>

#include <QCoreApplication>
#include <QDBusPendingCallWatcher>
#include <QDateTime>
#include <QDir>
#include <QDirIterator>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QStandardPaths>
#include <QUuid>

#include <limits>
#include <sys/stat.h>

using Kation::Operation;
using Kation::toWorkerResult;

// Plugin metadata: the protocol description lives in protondrive.json.
class KIOPluginForMetaData : public QObject
{
    Q_OBJECT
    Q_PLUGIN_METADATA(IID "org.kde.kio.worker.protondrive" FILE "protondrive.json")
};

extern "C" {
int Q_DECL_EXPORT kdemain(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    app.setApplicationName(QStringLiteral("kio_protondrive"));
    if (argc != 4) {
        fprintf(stderr, "Usage: kio_protondrive protocol domain-socket1 domain-socket2\n");
        return 1;
    }
    Kation::registerDBusTypes();
    ProtonDriveWorker worker(argv[2], argv[3]);
    worker.dispatchLoop();
    return 0;
}
}

namespace
{
constexpr int MetadataTimeoutMs = 120 * 1000;
constexpr qint64 ChunkSize = 1024 * 1024;
constexpr qint64 StaleSpoolAgeSecs = 24 * 60 * 60;

/// "My files" path for a URL: "/" for the root, no trailing slash otherwise.
QString drivePath(const QUrl &url)
{
    QString path = QDir::cleanPath(url.path());
    if (path.isEmpty() || path == QLatin1String(".")) {
        path = QStringLiteral("/");
    }
    if (!path.startsWith(QLatin1Char('/'))) {
        path.prepend(QLatin1Char('/'));
    }
    return path;
}

bool isFolder(const QVariantMap &entry)
{
    return entry.value(QStringLiteral("type")).toString() == QLatin1String("folder");
}

QString mimeTypeOf(const QVariantMap &entry)
{
    const QString stored = entry.value(QStringLiteral("mimeType")).toString();
    return isFolder(entry) ? stored : Kation::fileMimeType(entry.value(QStringLiteral("name")).toString(), stored);
}

KIO::UDSEntry toUdsEntry(const QVariantMap &entry, const QString &nameOverride = QString())
{
    KIO::UDSEntry uds;
    const bool folder = isFolder(entry);
    const QString name = nameOverride.isEmpty() ? entry.value(QStringLiteral("name")).toString() : nameOverride;
    uds.fastInsert(KIO::UDSEntry::UDS_NAME, name);
    uds.fastInsert(KIO::UDSEntry::UDS_FILE_TYPE, folder ? S_IFDIR : S_IFREG);
    uds.fastInsert(KIO::UDSEntry::UDS_ACCESS, folder ? 0700 : 0600);
    uds.fastInsert(KIO::UDSEntry::UDS_MIME_TYPE, mimeTypeOf(entry));
    const qlonglong size = entry.value(QStringLiteral("size")).toLongLong();
    if (!folder && size >= 0) {
        uds.fastInsert(KIO::UDSEntry::UDS_SIZE, size);
    }
    if (const qlonglong mtime = entry.value(QStringLiteral("mtime")).toLongLong(); mtime > 0) {
        uds.fastInsert(KIO::UDSEntry::UDS_MODIFICATION_TIME, mtime);
    }
    if (const qlonglong ctime = entry.value(QStringLiteral("ctime")).toLongLong(); ctime > 0) {
        uds.fastInsert(KIO::UDSEntry::UDS_CREATION_TIME, ctime);
    }
    return uds;
}

QString newTransferId()
{
    return QUuid::createUuid().toString(QUuid::WithoutBraces);
}
}

ProtonDriveWorker::ProtonDriveWorker(const QByteArray &poolSocket, const QByteArray &appSocket)
    : KIO::WorkerBase("protondrive", poolSocket, appSocket)
    , m_drive(new KationDriveInterface(Kation::serviceName, Kation::objectPath, QDBusConnection::sessionBus()))
    , m_transfers(new KationDriveInterface(Kation::serviceName, Kation::objectPath, QDBusConnection::sessionBus()))
{
    m_drive->setTimeout(MetadataTimeoutMs);
    m_transfers->setTimeout(std::numeric_limits<int>::max());

    // Spool files hold file content while it passes between KIO and kationd. The
    // worker may create kationd's cache folder first: both are the user's only.
    const auto ownerOnly = QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner;
    const QString cacheDir = QStandardPaths::writableLocation(QStandardPaths::GenericCacheLocation) + QStringLiteral("/kation");
    QDir().mkpath(cacheDir);
    QFile::setPermissions(cacheDir, ownerOnly);
    m_spoolDir = cacheDir + QStringLiteral("/spool");
    QDir().mkpath(m_spoolDir);
    QFile::setPermissions(m_spoolDir, ownerOnly);
    const QDateTime staleBefore = QDateTime::currentDateTime().addSecs(-StaleSpoolAgeSecs);
    for (QDirIterator it(m_spoolDir, QDir::Files); it.hasNext();) {
        const QFileInfo info = it.nextFileInfo();
        if (info.lastModified() < staleBefore) {
            QFile::remove(info.filePath());
        }
    }
}

ProtonDriveWorker::~ProtonDriveWorker()
{
    delete m_drive;
    delete m_transfers;
}

std::optional<KIO::WorkerResult> ProtonDriveWorker::statPath(const QUrl &url, QVariantMap &entry)
{
    QDBusPendingReply<QVariantMap> reply = m_drive->Stat(drivePath(url));
    reply.waitForFinished();
    if (reply.isError()) {
        return toWorkerResult(reply.error(), url);
    }
    entry = reply.value();
    return std::nullopt;
}

KIO::WorkerResult ProtonDriveWorker::stat(const QUrl &url)
{
    qCDebug(KATION_KIO) << "stat" << url;
    QVariantMap entry;
    if (auto failure = statPath(url, entry)) {
        return *failure;
    }
    const bool isRoot = drivePath(url) == QLatin1String("/");
    KIO::UDSEntry uds = toUdsEntry(entry, isRoot ? QStringLiteral(".") : QString());
    if (isRoot) {
        uds.replace(KIO::UDSEntry::UDS_DISPLAY_NAME, i18n("My files"));
    }
    statEntry(uds);
    return KIO::WorkerResult::pass();
}

KIO::WorkerResult ProtonDriveWorker::listDir(const QUrl &url)
{
    qCDebug(KATION_KIO) << "listDir" << url;
    QDBusPendingReply<QVariantMapList> reply = m_drive->List(drivePath(url));
    reply.waitForFinished();
    if (reply.isError()) {
        return toWorkerResult(reply.error(), url);
    }

    KIO::UDSEntry dot;
    dot.fastInsert(KIO::UDSEntry::UDS_NAME, QStringLiteral("."));
    dot.fastInsert(KIO::UDSEntry::UDS_FILE_TYPE, S_IFDIR);
    dot.fastInsert(KIO::UDSEntry::UDS_ACCESS, 0700);
    dot.fastInsert(KIO::UDSEntry::UDS_MIME_TYPE, QStringLiteral("inode/directory"));

    KIO::UDSEntryList entries;
    entries.reserve(reply.value().size() + 1);
    entries.append(dot);
    for (const QVariantMap &entry : reply.value()) {
        entries.append(toUdsEntry(entry));
    }
    listEntries(entries);
    return KIO::WorkerResult::pass();
}

KIO::WorkerResult ProtonDriveWorker::mkdir(const QUrl &url, int /*permissions*/)
{
    qCDebug(KATION_KIO) << "mkdir" << url;
    QDBusPendingReply<> reply = m_drive->CreateFolder(drivePath(url));
    reply.waitForFinished();
    if (reply.isError()) {
        return toWorkerResult(reply.error(), url, Operation::CreateFolder);
    }
    return KIO::WorkerResult::pass();
}

KIO::WorkerResult ProtonDriveWorker::rename(const QUrl &src, const QUrl &dest, KIO::JobFlags flags)
{
    qCDebug(KATION_KIO) << "rename" << src << dest << flags;
    QDBusPendingReply<> reply = m_drive->Move(drivePath(src), drivePath(dest), flags.testFlag(KIO::Overwrite));
    reply.waitForFinished();
    if (reply.isError()) {
        const bool destinationError = reply.error().name().endsWith(QLatin1String("AlreadyExists"));
        return toWorkerResult(reply.error(), destinationError ? dest : src, Operation::Write);
    }
    return KIO::WorkerResult::pass();
}

KIO::WorkerResult ProtonDriveWorker::del(const QUrl &url, bool /*isFile*/)
{
    qCDebug(KATION_KIO) << "del" << url;
    // Deleting moves to the Proton Drive trash, where it can be restored.
    QDBusPendingReply<> reply = m_drive->Trash(drivePath(url));
    reply.waitForFinished();
    if (reply.isError()) {
        return toWorkerResult(reply.error(), url);
    }
    return KIO::WorkerResult::pass();
}

QString ProtonDriveWorker::newSpoolPath() const
{
    return m_spoolDir + QLatin1Char('/') + newTransferId();
}

QDBusPendingCall ProtonDriveWorker::waitForTransfer(const QDBusPendingCall &call, const QString &transferId)
{
    QEventLoop loop;
    auto progress = QObject::connect(m_transfers, &KationDriveInterface::TransferProgress, &loop, [this, transferId](const QString &id, qulonglong bytes) {
        if (id == transferId) {
            processedSize(bytes);
        }
    });
    QDBusPendingCallWatcher watcher(call);
    QObject::connect(&watcher, &QDBusPendingCallWatcher::finished, &loop, &QEventLoop::quit);
    if (!watcher.isFinished()) {
        loop.exec();
    }
    QObject::disconnect(progress);
    return call;
}

KIO::WorkerResult ProtonDriveWorker::download(const QUrl &src, const QString &localPath)
{
    const QString transferId = newTransferId();
    QDBusPendingReply<QVariantMap> reply = waitForTransfer(m_transfers->Download(drivePath(src), localPath, transferId), transferId);
    if (reply.isError()) {
        return toWorkerResult(reply.error(), src);
    }
    return KIO::WorkerResult::pass();
}

KIO::WorkerResult ProtonDriveWorker::upload(const QString &localPath, const QUrl &dest, bool overwrite)
{
    const QString transferId = newTransferId();
    QDBusPendingReply<QVariantMap> reply = waitForTransfer(m_transfers->Upload(localPath, drivePath(dest), overwrite, transferId), transferId);
    if (reply.isError()) {
        return toWorkerResult(reply.error(), dest, Operation::Write);
    }
    return KIO::WorkerResult::pass();
}

KIO::WorkerResult ProtonDriveWorker::get(const QUrl &url)
{
    qCDebug(KATION_KIO) << "get" << url;
    QVariantMap entry;
    if (auto failure = statPath(url, entry)) {
        return *failure;
    }
    if (isFolder(entry)) {
        return KIO::WorkerResult::fail(KIO::ERR_IS_DIRECTORY, url.toDisplayString());
    }
    // Announce the type early so applications can pick a handler.
    mimeType(mimeTypeOf(entry));
    const qlonglong size = entry.value(QStringLiteral("size")).toLongLong();
    if (size >= 0) {
        totalSize(size);
    }

    const QString spool = newSpoolPath();
    const auto removeSpool = qScopeGuard([&spool] {
        QFile::remove(spool);
    });
    if (auto result = download(url, spool); !result.success()) {
        return result;
    }

    QFile file(spool);
    if (!file.open(QIODevice::ReadOnly)) {
        return KIO::WorkerResult::fail(KIO::ERR_CANNOT_READ, url.toDisplayString());
    }
    while (!file.atEnd()) {
        const QByteArray chunk = file.read(ChunkSize);
        if (chunk.isEmpty() && file.error() != QFileDevice::NoError) {
            return KIO::WorkerResult::fail(KIO::ERR_CANNOT_READ, url.toDisplayString());
        }
        data(chunk);
    }
    data(QByteArray());
    processedSize(file.size());
    return KIO::WorkerResult::pass();
}

KIO::WorkerResult ProtonDriveWorker::put(const QUrl &url, int /*permissions*/, KIO::JobFlags flags)
{
    qCDebug(KATION_KIO) << "put" << url << flags;
    const bool overwrite = flags.testFlag(KIO::Overwrite);
    if (!overwrite) {
        // Fail before receiving the data when the destination exists, or when
        // kationd cannot handle the upload anyway (e.g. signed out).
        QDBusPendingReply<QVariantMap> existing = m_drive->Stat(drivePath(url));
        existing.waitForFinished();
        if (!existing.isError()) {
            return KIO::WorkerResult::fail(isFolder(existing.value()) ? KIO::ERR_DIR_ALREADY_EXIST : KIO::ERR_FILE_ALREADY_EXIST, url.toDisplayString());
        }
        if (existing.error().name() != Kation::errorPrefix + QLatin1String("NotFound")) {
            return toWorkerResult(existing.error(), url, Operation::Write);
        }
    }

    const QString spool = newSpoolPath();
    const auto removeSpool = qScopeGuard([&spool] {
        QFile::remove(spool);
    });
    QFile file(spool);
    if (!file.open(QIODevice::WriteOnly | QIODevice::NewOnly, QFileDevice::ReadOwner | QFileDevice::WriteOwner)) {
        return KIO::WorkerResult::fail(KIO::ERR_CANNOT_WRITE, spool);
    }
    while (true) {
        dataReq();
        QByteArray buffer;
        const int read = readData(buffer);
        if (read < 0) {
            return KIO::WorkerResult::fail(KIO::ERR_CANNOT_READ, url.toDisplayString());
        }
        if (read == 0) {
            break;
        }
        if (file.write(buffer) != buffer.size()) {
            return KIO::WorkerResult::fail(KIO::ERR_DISK_FULL, spool);
        }
    }
    file.close();

    // Keep the original modification time when the job provides it.
    const QDateTime modified = QDateTime::fromString(metaData(QStringLiteral("modified")), Qt::ISODate);
    if (modified.isValid() && file.open(QIODevice::ReadWrite)) {
        file.setFileTime(modified, QFileDevice::FileModificationTime);
        file.close();
    }

    return upload(spool, url, overwrite);
}

KIO::WorkerResult ProtonDriveWorker::copy(const QUrl &src, const QUrl &dest, int permissions, KIO::JobFlags flags)
{
    qCDebug(KATION_KIO) << "copy" << src << dest << flags;
    const bool overwrite = flags.testFlag(KIO::Overwrite);

    if (src.isLocalFile() && dest.scheme() == QLatin1String("protondrive")) {
        const QFileInfo local(src.toLocalFile());
        if (!local.exists()) {
            return KIO::WorkerResult::fail(KIO::ERR_DOES_NOT_EXIST, src.toLocalFile());
        }
        if (local.isDir()) {
            return KIO::WorkerResult::fail(KIO::ERR_IS_DIRECTORY, src.toLocalFile());
        }
        totalSize(local.size());
        return upload(local.absoluteFilePath(), dest, overwrite);
    }

    if (src.scheme() == QLatin1String("protondrive") && dest.isLocalFile()) {
        const QFileInfo local(dest.toLocalFile());
        if (local.isDir()) {
            return KIO::WorkerResult::fail(KIO::ERR_IS_DIRECTORY, dest.toLocalFile());
        }
        if (local.exists() && !overwrite) {
            return KIO::WorkerResult::fail(KIO::ERR_FILE_ALREADY_EXIST, dest.toLocalFile());
        }
        QVariantMap entry;
        if (auto failure = statPath(src, entry)) {
            return *failure;
        }
        if (isFolder(entry)) {
            return KIO::WorkerResult::fail(KIO::ERR_IS_DIRECTORY, src.toDisplayString());
        }
        if (const qlonglong size = entry.value(QStringLiteral("size")).toLongLong(); size >= 0) {
            totalSize(size);
        }
        if (auto result = download(src, QDir::cleanPath(local.absoluteFilePath())); !result.success()) {
            return result;
        }
        if (permissions != -1) {
            QFile::setPermissions(dest.toLocalFile(), KIO::convertPermissions(permissions));
        }
        return KIO::WorkerResult::pass();
    }

    // Other combinations (e.g. within Proton Drive): let KIO use get and put.
    return KIO::WorkerResult::fail(KIO::ERR_UNSUPPORTED_ACTION, QString());
}

#include "protondriveworker.moc"
