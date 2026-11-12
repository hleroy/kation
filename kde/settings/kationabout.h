// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <KAboutData>

namespace Kation
{
/// Kation's about data. Built here rather than read from KAboutData::applicationData(),
/// which is System Settings' own data when the settings run as a System Settings module.
KAboutData aboutData();

/// A version reported by kationd, for display: "external-drive-kation@0.3.0-beta+fd6d8cb"
/// (the form Proton requires) becomes "0.3.0 (fd6d8cb)", and "js@0.22.2+df3a717b" "0.22.2 (df3a717b)".
QString displayVersion(const QString &reported);

/// kationd's log file: $XDG_STATE_HOME/kation/kationd.log.
QString logFilePath();
}
