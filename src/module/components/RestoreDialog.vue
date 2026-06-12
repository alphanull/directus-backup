<!--
  Restore confirmation dialog — per-run restore scope selector plus a warning.
  Visibility is two-way bound; scope edits and the confirm action are emitted.

  @author  Frank Kudermann – alphanull
  @license AGPL-3.0-only
-->
<template>
    <v-dialog v-model="show" @esc="show = false">
        <v-card>
            <v-card-title>{{ t('backup.dialogs.restore_title', { label: manifest?.label ?? backupId }) }}</v-card-title>
            <v-card-text>
                <div class="create-scope">
                    <div class="create-scope-label">{{ t('backup.scope.title_restore') }}</div>
                    <ScopeFields
                        mode="restore"
                        :scope="scope"
                        :collections="collections"
                        :relations="relations"
                        :available-components="availableComponents"
                        @update="$emit('updateScope', $event)"
                    />
                </div>
                <v-notice type="warning" style="margin-top: 0.75rem;">
                    {{ t('backup.dialogs.restore_warning') }}
                </v-notice>
            </v-card-text>
            <v-card-actions>
                <v-button secondary @click="show = false">{{ t('backup.actions.cancel') }}</v-button>
                <v-button kind="danger" :disabled="scopeEmpty || restoreDisabled" @click="$emit('confirm')">{{ t('backup.actions.restore') }}</v-button>
            </v-card-actions>
        </v-card>
    </v-dialog>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { BackupManifest, RunScope } from '../../shared/types.js';
import ScopeFields from './ScopeFields.vue';

defineProps<{
    manifest: BackupManifest | null
    backupId: string
    scope: RunScope
    collections: string[]
    relations: Array<{ collection: string, related_collection: string }>
    availableComponents: Array<'database' | 'assets' | 'extensions'>
    scopeEmpty: boolean
    restoreDisabled: boolean
}>();

defineEmits<{
    confirm: []
    updateScope: [patch: Partial<RunScope>]
}>();

const show = defineModel<boolean>({ required: true });

const { t } = useI18n();
</script>

<style scoped>
:deep(.v-card-title) {
    margin-bottom: var(--content-padding);
    padding-bottom: var(--content-padding);
    padding-block-start: 0.438rem;
    border-bottom: 0.063rem solid var(--theme--border-color, var(--border-normal));
    font-size: 1.25rem;
}

.create-scope {
    margin-top: 1rem;
}

.create-scope-label {
    margin-bottom: 0.75rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--theme--foreground);
}
</style>
