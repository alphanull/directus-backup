<!--
  Create-backup dialog — label input plus the per-run scope selector. The label
  and visibility are two-way bound; scope edits and the create action are emitted.

  @author  Frank Kudermann – alphanull
  @license AGPL-3.0-only
-->
<template>
    <v-dialog v-model="show" @esc="show = false">
        <v-card>
            <v-card-title>{{ t('backup.dialogs.create_title') }}</v-card-title>
            <v-card-text>
                <v-input
                    v-model="label"
                    :placeholder="t('backup.settings.label_placeholder')"
                    :maxlength="LABEL_MAX"
                />
                <div class="create-scope">
                    <div class="create-scope-label">{{ t('backup.scope.title_create') }}</div>
                    <ScopeFields
                        mode="backup"
                        :scope="scope"
                        :collections="collections"
                        :relations="relations"
                        @update="$emit('updateScope', $event)"
                    />
                </div>
            </v-card-text>
            <v-card-actions>
                <v-button secondary @click="show = false">{{ t('backup.actions.cancel') }}</v-button>
                <v-button :loading="creating" :disabled="scopeEmpty" @click="$emit('create')">{{ t('backup.actions.create') }}</v-button>
            </v-card-actions>
        </v-card>
    </v-dialog>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { RunScope } from '../../shared/types.js';
import { LABEL_MAX } from '../../shared/constants.js';
import ScopeFields from './ScopeFields.vue';

defineProps<{
    creating: boolean
    scope: RunScope
    collections: string[]
    relations: Array<{ collection: string, related_collection: string }>
    scopeEmpty: boolean
}>();

defineEmits<{
    create: []
    updateScope: [patch: Partial<RunScope>]
}>();

const show = defineModel<boolean>({ required: true });
const label = defineModel<string>('label', { required: true });

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
