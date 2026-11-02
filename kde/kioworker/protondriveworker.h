// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <KIO/WorkerBase>

#include <QDBusPendingCall>
#include <QVariantMap>

#include <optional>

class KationDriveInterface;

/**
 * KIO worker for protondrive:/ URLs. It holds no Proton logic: every
 * operation is a D-Bus call to kationd, which owns the session and the SDK.
 * protondrive:/ is the root of "My files".
 */
class ProtonDriveWorker : public KIO::WorkerBase
{
public:
    ProtonDriveWorker(const QByteArray &poolSocket, const QByteArray &appSocket);
    ~ProtonDriveWorker() override;

    KIO::WorkerResult stat(const QUrl &url) override;
    KIO::WorkerResult listDir(const QUrl &url) override;
    KIO::WorkerResult mkdir(const QUrl &url, int permissions) override;
    KIO::WorkerResult rename(const QUrl &src, const QUrl &dest, KIO::JobFlags flags) override;
    KIO::WorkerResult del(const QUrl &url, bool isFile) override;
    KIO::WorkerResult get(const QUrl &url) override;
    KIO::WorkerResult put(const QUrl &url, int permissions, KIO::JobFlags flags) override;
    KIO::WorkerResult copy(const QUrl &src, const QUrl &dest, int permissions, KIO::JobFlags flags) override;

private:
    /// Waits for a transfer call while reporting its progress to KIO.
    QDBusPendingCall waitForTransfer(const QDBusPendingCall &call, const QString &transferId);
    /// Runs a metadata call; on failure returns the KIO error to report.
    std::optional<KIO::WorkerResult> statPath(const QUrl &url, QVariantMap &entry);
    KIO::WorkerResult upload(const QString &localPath, const QUrl &dest, bool overwrite);
    KIO::WorkerResult download(const QUrl &src, const QString &localPath);
    QString newSpoolPath() const;

    KationDriveInterface *m_drive;
    /// Separate proxy without a call timeout, for transfers.
    KationDriveInterface *m_transfers;
    QString m_spoolDir;
};
