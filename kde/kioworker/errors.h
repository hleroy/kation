// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <KIO/WorkerBase>

#include <QDBusError>
#include <QUrl>

namespace Kation
{
/// What the failed call was doing, to pick the most precise KIO error.
enum class Operation {
    Read,
    CreateFolder,
    Write,
};

/// Converts an error from kationd into a KIO worker result.
KIO::WorkerResult toWorkerResult(const QDBusError &error, const QUrl &url, Operation operation = Operation::Read);
}
