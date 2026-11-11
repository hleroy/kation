// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <QString>

namespace Kation
{
/// Whether the tray icon starts with the session (kationrc, [General] TrayAtLogin, default on).
bool trayAtLogin();
/// Saves the setting and adds or removes the autostart entry.
void setTrayAtLogin(bool enabled);
/// Makes the autostart entry match the setting (the tray calls this when it starts).
void applyTrayAutostart();

/// One argument of a desktop entry's Exec key, quoted and escaped as the Desktop Entry specification says.
QString desktopExecArgument(const QString &argument);
/// ~/.config/autostart/com.hleroy.Kation.tray.desktop
QString trayAutostartPath();
}
