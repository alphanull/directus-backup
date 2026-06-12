<!--
  Settings panel for the module navigation — schedule, retention, quota, and the
  default-scope entry point. Two-way binds the config object and the raw input
  fields; persistence is delegated to the parent via events.

  @author  Frank Kudermann – alphanull
  @license AGPL-3.0-only
-->
<template>
    <div>
        <div class="nav-section">
            <div class="nav-section-title"><v-icon name="settings" class="nav-section-icon" />{{ t('backup.nav.settings') }}</div>
            <div class="nav-field">
                <span class="nav-field-label">
                    {{ t('backup.settings.schedule') }}
                    <v-icon name="help" filled class="nav-field-help" v-tooltip.right="t('backup.settings.tooltips.schedule')" />
                </span>
                <v-select
                    v-model="schedule"
                    :items="scheduleOptions"
                    :disabled="configLoading"
                    @update:model-value="$emit('save')"
                />
            </div>
            <div v-if="['1h','6h','12h'].includes(schedule)" class="nav-field">
                <span class="nav-field-label">
                    {{ t('backup.settings.at_minute') }}
                    <v-icon name="help" filled class="nav-field-help" v-tooltip.right="t('backup.settings.tooltips.at_minute')" />
                </span>
                <v-input
                    v-model="scheduleMinute"
                    type="number"
                    :min="0"
                    :max="59"
                    placeholder="0"
                    :disabled="configLoading"
                    @blur="$emit('saveScheduleOffset')"
                    @keyup.enter="($event.target as HTMLInputElement)?.blur()"
                />
            </div>
            <div v-if="['daily','3d','weekly'].includes(schedule)" class="nav-field">
                <span class="nav-field-label">
                    {{ t('backup.settings.at_hour') }}<v-icon name="help" filled class="nav-field-help" v-tooltip.right="t('backup.settings.tooltips.at_hour')" />
                </span>
                <v-input
                    v-model="scheduleHour"
                    type="number"
                    :min="0"
                    :max="23"
                    placeholder="0"
                    :disabled="configLoading"
                    @blur="$emit('saveScheduleOffset')"
                    @keyup.enter="($event.target as HTMLInputElement)?.blur()"
                />
            </div>
            <div class="nav-field">
                <span class="nav-field-label">
                    {{ t('backup.settings.retention') }}
                    <v-icon name="help" filled class="nav-field-help" v-tooltip.right="t('backup.settings.tooltips.retention')" />
                </span>
                <v-select
                    v-model="retention"
                    :items="retentionOptions"
                    :disabled="configLoading"
                    @update:model-value="$emit('save')"
                />
            </div>
            <div class="nav-field">
                <span class="nav-field-label">
                    {{ t('backup.settings.quota_mb') }}
                    <v-icon name="help" filled class="nav-field-help" v-tooltip.right="t('backup.settings.tooltips.quota_mb')" />
                </span>
                <v-input
                    v-model="quota"
                    type="number"
                    :min="0"
                    :placeholder="t('backup.settings.quota_placeholder')"
                    :disabled="configLoading"
                    @blur="$emit('saveQuotaFields')"
                    @keyup.enter="($event.target as HTMLInputElement)?.blur()"
                />
            </div>
            <div class="nav-field">
                <span class="nav-field-label">
                    {{ t('backup.settings.min_free_mb') }}
                    <v-icon name="help" filled class="nav-field-help" v-tooltip.right="t('backup.settings.tooltips.min_free_mb')" />
                </span>
                <v-input
                    v-model="minFree"
                    type="number"
                    :min="0"
                    placeholder="100"
                    :disabled="configLoading"
                    @blur="$emit('saveQuotaFields')"
                    @keyup.enter="($event.target as HTMLInputElement)?.blur()"
                />
            </div>
        </div>

        <div class="nav-scope-buttons">
            <span class="nav-field-label">
                {{ t('backup.settings.backup_scope') }}
                <v-icon name="help" filled class="nav-field-help" v-tooltip.right="t('backup.settings.tooltips.backup_scope')" />
            </span>
            <v-button secondary full-width @click="$emit('configureScope')">
                {{ t('backup.actions.configure') }}
            </v-button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';

defineProps<{
    configLoading: boolean
    scheduleOptions: Array<{ text: string, value: string }>
    retentionOptions: Array<{ text: string, value: string }>
}>();

defineEmits<{
    save: []
    saveScheduleOffset: []
    saveQuotaFields: []
    configureScope: []
}>();

const schedule = defineModel<string>('schedule', { required: true });
const retention = defineModel<string>('retention', { required: true });
const scheduleMinute = defineModel<string>('scheduleMinute', { required: true });
const scheduleHour = defineModel<string>('scheduleHour', { required: true });
const quota = defineModel<string>('quota', { required: true });
const minFree = defineModel<string>('minFree', { required: true });

const { t } = useI18n();
</script>

<style scoped>
.nav-section {
    padding: 0.75rem 0;
    border-top: 0.063rem solid var(--theme--border-color-subdued);
}

.nav-section-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--theme--foreground);
}

.nav-section-icon {
    --v-icon-color: var(--theme--foreground);
    --v-icon-size: 1.25rem;
}

.nav-field {
    margin-bottom: 0.75rem;
}

.nav-field:last-child {
    margin-bottom: 0;
}

.nav-field-label {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-bottom: 0.25rem;
    font-size: 0.813rem;
    font-weight: 600;
    color: var(--theme--foreground-subdued);
}

.nav-field-help {
    --v-icon-size: 1rem;
    --v-icon-color: var(--theme--foreground-subdued);

    flex-shrink: 0;
    opacity: 0.5;
    cursor: help;
    transition: opacity 0.15s;
}

.nav-field-help:hover {
    opacity: 1;
}

.nav-scope-buttons {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem 0;
    border-top: 0.063rem solid var(--theme--border-color-subdued);
}
</style>
