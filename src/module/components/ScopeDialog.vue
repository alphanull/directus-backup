<!--
  Scope settings dialog — wraps ScopeFields with a save/cancel flow for the
  global backup scope setting. Edits a local copy and only emits on save.

  @author  Frank Kudermann – alphanull
  @license AGPL-3.0-only
-->
<template>
    <v-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)" @esc="$emit('update:modelValue', false)">
        <v-card class="scope-card">
            <v-card-title>{{ title }}</v-card-title>
            <v-card-text>
                <p v-if="hint" class="scope-hint">{{ hint }}</p>
                <ScopeFields
                    mode="backup"
                    :scope="local"
                    :collections="collections"
                    :relations="relations"
                    @update="onUpdate"
                />
            </v-card-text>
            <v-card-actions>
                <v-button secondary @click="$emit('update:modelValue', false)">{{ t('backup.actions.cancel') }}</v-button>
                <v-button :disabled="scopeEmpty" @click="save">{{ t('backup.scope.save') }}</v-button>
            </v-card-actions>
        </v-card>
    </v-dialog>
</template>

<script setup lang="ts">
import { reactive, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { RunScope } from '../../shared/types.js';
import ScopeFields from './ScopeFields.vue';

const props = defineProps<{
    modelValue: boolean
    title: string
    hint?: string
    scope: RunScope
    collections: string[]
    relations: Array<{ collection: string, related_collection: string }>
}>();

const emit = defineEmits<{
    'update:modelValue': [value: boolean]
    save: [scope: RunScope]
}>();

const { t } = useI18n();

const local = reactive<RunScope>({
    database: true, assets: true, extensions: false, includeCollections: []
});

const scopeEmpty = computed(() => !local.database && !local.assets && !local.extensions || local.database && local.includeCollections.length === 0 && props.collections.length > 0);

watch(() => props.modelValue, open => {
    if (open) {
        local.database = props.scope.database;
        local.assets = props.scope.assets;
        local.extensions = props.scope.extensions;
        // Empty = all: pre-populate so every collection appears checked by default.
        local.includeCollections = props.scope.includeCollections.length > 0
            ? [...props.scope.includeCollections]
            : [...props.collections];
    }
});

/**
 * Applies a partial scope update from ScopeFields onto the local copy.
 */
function onUpdate(patch: Partial<RunScope>) {
    Object.assign(local, patch);
}

/**
 * Emits the edited scope copy to the parent and closes the dialog.
 */
function save() {
    // Normalize: if every collection is selected, use [] (no-filter shorthand for the backend).
    const allSelected = props.collections.length > 0 && props.collections.every(c => local.includeCollections.includes(c));
    emit('save', {
        database: local.database,
        assets: local.assets,
        extensions: local.extensions,
        includeCollections: allSelected ? [] : [...local.includeCollections]
    });
    emit('update:modelValue', false);
}
</script>

<style scoped>
:deep(.v-card-title) {
    margin-bottom: var(--content-padding);
    padding-bottom: var(--content-padding);
    padding-block-start: 0.438rem;
    border-bottom: 0.063rem solid var(--theme--border-color, var(--border-normal));
    font-size: 1.25rem;
}

.scope-card {
    width: 33.75rem;
    min-width: 26.25rem;
    max-width: 33.75rem;
}

.scope-hint {
    margin-bottom: var(--content-padding);
    font-size: 0.875rem;
    color: var(--theme--foreground-subdued, var(--foreground-subdued));
}
</style>
