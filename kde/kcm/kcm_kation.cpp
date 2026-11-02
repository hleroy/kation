// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

#include "kationtypes.h"
#include "settingswidget.h"

#include <KCModule>
#include <KPluginFactory>

#include <QVBoxLayout>

/// Kation in System Settings (Network). The same settings as the Kation window.
class KationModule : public KCModule
{
    Q_OBJECT

public:
    KationModule(QObject *parent, const KPluginMetaData &data)
        : KCModule(parent, data)
    {
        Kation::registerDBusTypes();
        m_settings = new KationSettingsWidget(widget());
        auto layout = new QVBoxLayout(widget());
        layout->setContentsMargins(0, 0, 0, 0);
        layout->addWidget(m_settings);
        setButtons(Apply | Default);
        connect(m_settings, &KationSettingsWidget::changed, this, &KCModule::setNeedsSave);
    }

    void load() override
    {
        m_settings->load();
        KCModule::load();
    }

    void save() override
    {
        m_settings->save();
        KCModule::save();
    }

    void defaults() override
    {
        m_settings->defaults();
        KCModule::defaults();
    }

private:
    KationSettingsWidget *m_settings;
};

K_PLUGIN_CLASS_WITH_JSON(KationModule, "kcm_kation.json")

#include "kcm_kation.moc"
