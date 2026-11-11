// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <KAboutData>

namespace Kation
{
/// Kation's about data. Built here rather than read from KAboutData::applicationData(),
/// which is System Settings' own data when the settings run as a System Settings module.
KAboutData aboutData();

/// kationd's log file: $XDG_STATE_HOME/kation/kationd.log.
QString logFilePath();
}
