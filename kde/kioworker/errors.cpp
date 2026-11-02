// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include "errors.h"

#include "kationtypes.h"
#include "logging.h"

#include <KLocalizedString>

KIO::WorkerResult Kation::toWorkerResult(const QDBusError &error, const QUrl &url, Operation operation)
{
    const QString name = error.name();
    const QString path = url.toDisplayString(QUrl::PreferLocalFile);
    qCDebug(KATION_KIO) << "kationd error for" << url << name << error.message();

    if (!name.startsWith(errorPrefix)) {
        // kationd is missing, crashed or did not answer.
        switch (error.type()) {
        case QDBusError::ServiceUnknown:
        case QDBusError::NoReply:
        case QDBusError::Disconnected:
        case QDBusError::Timeout:
        case QDBusError::TimedOut:
            return KIO::WorkerResult::fail(KIO::ERR_CANNOT_CONNECT, i18n("The Kation background service is not available (%1).", error.message()));
        default:
            return KIO::WorkerResult::fail(KIO::ERR_INTERNAL, error.message());
        }
    }

    const QString code = name.mid(errorPrefix.size());
    if (code == QLatin1String("NotLoggedIn")) {
        return KIO::WorkerResult::fail(KIO::ERR_WORKER_DEFINED, i18n("You are not signed in to Proton Drive. Open Kation to sign in."));
    }
    if (code == QLatin1String("NotFound")) {
        return KIO::WorkerResult::fail(KIO::ERR_DOES_NOT_EXIST, path);
    }
    if (code == QLatin1String("AlreadyExists")) {
        return KIO::WorkerResult::fail(operation == Operation::CreateFolder ? KIO::ERR_DIR_ALREADY_EXIST : KIO::ERR_FILE_ALREADY_EXIST, path);
    }
    if (code == QLatin1String("NotAFolder")) {
        return KIO::WorkerResult::fail(KIO::ERR_IS_FILE, path);
    }
    if (code == QLatin1String("IsAFolder")) {
        return KIO::WorkerResult::fail(KIO::ERR_IS_DIRECTORY, path);
    }
    if (code == QLatin1String("Cancelled")) {
        return KIO::WorkerResult::fail(KIO::ERR_USER_CANCELED, path);
    }
    if (code == QLatin1String("Connection")) {
        return KIO::WorkerResult::fail(KIO::ERR_CANNOT_CONNECT, error.message());
    }
    if (code == QLatin1String("RateLimited")) {
        return KIO::WorkerResult::fail(KIO::ERR_WORKER_DEFINED, i18n("Proton Drive is limiting requests from this device. Please try again in a few minutes."));
    }
    if (code == QLatin1String("Integrity")) {
        return KIO::WorkerResult::fail(KIO::ERR_WORKER_DEFINED, i18n("The file failed an integrity check: %1", error.message()));
    }
    // InvalidArgument, Failed and anything newer: show kationd's message.
    return KIO::WorkerResult::fail(KIO::ERR_WORKER_DEFINED, error.message());
}
