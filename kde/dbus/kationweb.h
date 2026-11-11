// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <QString>

// Web addresses come from kationd (sign-in, links to the Proton Drive website):
// only https ones are opened, so a bad reply cannot open a local file or a program.
namespace Kation
{
/// True for a valid https URL with a host.
bool isWebUrl(const QString &url);

/// Opens `url` in the browser if isWebUrl() accepts it; returns false otherwise.
bool openWebUrl(const QString &url);

/// The message to show when openWebUrl() refused an address.
QString refusedWebUrlText();
}
