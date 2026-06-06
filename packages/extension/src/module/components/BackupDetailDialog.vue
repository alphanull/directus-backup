<!--
  Backup detail modal — shows manifest metadata, scope, and verify results for
  a single backup.

  @author  Frank Kudermann – alphanull
  @license AGPL-3.0-only
-->
<template>
    <v-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)" @esc="$emit('update:modelValue', false)">
        <v-card v-if="item" class="detail-card">
            <v-card-title class="detail-title">
                <v-icon :name="item.source === 'scheduled' ? 'schedule' : 'person'" />
                {{ item.label }}
                <v-chip :class="['status-chip', `status-${item.status}`]" small>
                    {{ t('backup.status.' + item.status) }}
                </v-chip>
            </v-card-title>
            <v-card-text>
                <dl class="detail-grid">
                    <dt>{{ t('backup.detail.id') }}</dt>
                    <dd class="detail-mono">{{ item.id }}</dd>

                    <dt>{{ t('backup.detail.source') }}</dt>
                    <dd>{{ item.source === 'scheduled' ? t('backup.activity.source_scheduled') : t('backup.activity.source_manual') }}</dd>

                    <dt>{{ t('backup.detail.created') }}</dt>
                    <dd>{{ formatDate(item.createdAt) }}</dd>

                    <template v-if="item.finishedAt">
                        <dt>{{ t('backup.detail.finished') }}</dt>
                        <dd>{{ formatDate(item.finishedAt) }}</dd>

                        <dt>{{ t('backup.detail.duration') }}</dt>
                        <dd>{{ formatDuration(item.createdAt, item.finishedAt) }}</dd>
                    </template>

                    <template v-if="item.sizeBytes">
                        <dt>{{ t('backup.detail.size') }}</dt>
                        <dd>{{ formatSize(item.sizeBytes) }}</dd>
                    </template>

                    <template v-if="item.directusVersion">
                        <dt>{{ t('backup.detail.directus') }}</dt>
                        <dd>v{{ item.directusVersion }}</dd>
                    </template>

                    <template v-if="item.dumpFormat">
                        <dt>{{ t('backup.detail.format') }}</dt>
                        <dd>{{ item.dumpFormat }}</dd>
                    </template>

                    <template v-if="item.tool">
                        <dt>{{ t('backup.detail.tool') }}</dt>
                        <dd>{{ item.tool.name }}{{ item.tool.version ? ` ${item.tool.version}` : '' }}</dd>
                    </template>

                    <template v-if="item.error">
                        <dt>{{ t('backup.detail.error') }}</dt>
                        <dd class="detail-error detail-error-block">{{ item.error }}</dd>
                    </template>

                    <template v-if="item.scope">
                        <dt>{{ t('backup.detail.scope') }}</dt>
                        <dd>{{ scopeSummary }}</dd>
                    </template>

                    <template v-if="item.scope?.includedCollections?.length">
                        <dt>{{ t('backup.detail.included_collections') }}</dt>
                        <dd class="detail-mono">{{ item.scope.includedCollections.join(', ') }}</dd>
                    </template>

                    <template v-if="item.scope?.excludedCollections?.length">
                        <dt>{{ t('backup.detail.excluded_collections') }}</dt>
                        <dd class="detail-mono">{{ item.scope.excludedCollections.join(', ') }}</dd>
                    </template>
                </dl>

                <template v-if="item.restoredAt">
                    <div class="detail-section-divider">
                        <span class="detail-section-label">{{ t('backup.detail.restore_section') }}</span>
                        <v-chip v-if="item.restoreStatus" :class="['status-chip', `status-${item.restoreStatus}`]" small>
                            {{ restoreStatusLabel }}
                        </v-chip>
                    </div>
                    <dl class="detail-grid">
                        <dt>{{ t('backup.detail.restored') }}</dt>
                        <dd>{{ formatDate(item.restoredAt) }}</dd>

                        <template v-if="item.restore">
                            <dt>{{ t('backup.detail.restore_components') }}</dt>
                            <dd>
                                <div v-for="(state, comp) in item.restore" :key="comp">
                                    {{ t('backup.detail.component_' + comp) }}: {{ t('backup.restore_state.' + state) }}
                                </div>
                            </dd>
                        </template>

                        <template v-if="item.restoreError">
                            <dt>{{ t('backup.detail.restore_error') }}</dt>
                            <dd class="detail-error detail-error-block">{{ item.restoreError }}</dd>
                        </template>
                    </dl>
                </template>
            </v-card-text>
            <v-card-actions>
                <v-button secondary @click="$emit('update:modelValue', false)">{{ t('backup.actions.close') }}</v-button>
            </v-card-actions>
        </v-card>
    </v-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BackupManifest } from '../../shared/types.js';
import { formatDate, formatDuration, formatSize } from '../composables/useFormatters.js';

const props = defineProps<{
    modelValue: boolean
    item: BackupManifest | null
}>();

defineEmits<{
    'update:modelValue': [value: boolean]
}>();

const { t } = useI18n();

const scopeSummary = computed(() => {
    const s = props.item?.scope;
    if (!s) return '';
    const parts: string[] = [];
    if (s.database) parts.push(t('backup.scope.database'));
    if (s.assets) parts.push(t('backup.scope.assets'));
    if (s.extensions) parts.push(t('backup.scope.extensions'));
    return parts.length > 0 ? parts.join(' + ') : '—';
});

const restoreStatusLabel = computed(() => {
    const s = props.item?.restoreStatus;
    if (s === 'failed') return t('backup.status.restore_failed');
    return t('backup.status.success');
});
</script>

<style scoped>
:deep(.v-card-title) {
    margin-bottom: var(--content-padding);
    padding-bottom: var(--content-padding);
    padding-block-start: 0.438rem;
    border-bottom: 0.063rem solid var(--theme--border-color, var(--border-normal));
    font-size: 1.25rem;
}

.detail-card {
    min-width: 30rem;
}

.detail-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.detail-title .status-chip {
    margin-left: auto;
}

.detail-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    align-items: start;
    gap: 0.375rem 1rem;
}

.detail-grid dt {
    min-width: 9.063rem;
    padding-top: 0.063rem;
    font-weight: 600;
    color: var(--theme--foreground-subdued);
    white-space: nowrap;
}

.detail-grid dd {
    margin: 0;
    color: var(--theme--foreground);
    word-break: break-word;
}

.detail-mono {
    font-family: var(--theme--fonts--monospace--font-family, monospace);
    font-size: 0.75rem;
}

.detail-error {
    color: var(--danger);
}

.detail-error-block {
    max-height: 12.5rem;
    padding: 0.5rem 0.625rem;
    border-radius: var(--theme--border-radius, 0.375rem);
    background: var(--danger-10, rgba(var(--danger-rgb), 0.1));
    font-family: var(--theme--fonts--monospace--font-family, monospace);
    white-space: pre-wrap;
    overflow-y: auto;
}

.detail-section-divider {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 1rem 0 0.5rem;
    padding-top: 0.75rem;
    border-top: 0.063rem solid var(--theme--border-color, var(--border-normal));
}

.detail-section-label {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--theme--foreground);
}

.detail-section-divider .status-chip {
    margin-left: auto;
}

.status-chip {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
}

.status-success {
    --v-chip-color: var(--success);
    --v-chip-background-color: var(--success-10);
}

.status-failed {
    --v-chip-color: var(--danger);
    --v-chip-background-color: var(--danger-10);
}

.status-running {
    --v-chip-color: var(--warning);
    --v-chip-background-color: var(--warning-10);
}
</style>
