<!--
  Scope selection fields — toggles database/assets/extensions and picks the
  excluded collections. Mutates the passed `scope` object in place so callers
  can bind their own reactive state (per-run scope or a dialog's local copy).

  @author  Frank Kudermann – alphanull
  @license AGPL-3.0-only
-->
<template>
    <div class="scope-fields">
        <div class="scope-section">
            <label v-if="showComponent('database')" class="scope-toggle">
                <v-checkbox :model-value="scope.database" @update:model-value="$emit('update', { database: $event })" />
                <span>{{ t('backup.scope.database') }}</span>
            </label>
            <label v-if="showComponent('assets')" class="scope-toggle">
                <v-checkbox :model-value="scope.assets" @update:model-value="$emit('update', { assets: $event })" />
                <span>{{ t('backup.scope.assets') }}</span>
            </label>
            <label v-if="showComponent('extensions')" class="scope-toggle">
                <v-checkbox :model-value="scope.extensions" @update:model-value="$emit('update', { extensions: $event })" />
                <span>{{ t('backup.scope.extensions') }}</span>
            </label>
        </div>

        <div v-if="scope.database && showComponent('database') && collections.length > 0" class="scope-section">
            <div class="scope-section-label">{{ t('backup.scope.include_collections') }}</div>

            <v-input
                v-model="search"
                :placeholder="t('backup.scope.search_placeholder')"
                class="scope-search"
                @keydown.stop
            >
                <template #prepend><v-icon name="search" /></template>
            </v-input>

            <div v-if="filteredCollections.length > 0" class="collection-select-all">
                <button class="select-all-btn" @click="selectAll">{{ t('backup.scope.select_all') }}</button>
                <span class="select-all-sep">·</span>
                <button class="select-all-btn" @click="selectNone">{{ t('backup.scope.select_none') }}</button>
            </div>

            <div class="collection-list">
                <label
                    v-for="col in filteredCollections"
                    :key="col"
                    class="collection-item"
                >
                    <v-checkbox
                        :model-value="scope.includeCollections.includes(col)"
                        @update:model-value="toggleCollection(col, $event)"
                    />
                    <span class="collection-name">{{ col }}</span>
                </label>
                <p v-if="filteredCollections.length === 0" class="scope-empty">
                    {{ search ? '—' : t('backup.scope.no_selections') }}
                </p>
            </div>

            <v-notice v-if="dependencyIssues.length > 0" type="warning" class="scope-warning">
                <p class="dependency-intro">{{ dependencyIntro }}</p>
                <ul class="dependency-list">
                    <li v-for="item in dependencyIssues" :key="item.deselected">
                        <span class="dependency-name">{{ item.deselected }}</span>
                        <span class="dependency-arrow">→</span>
                        <span class="dependency-linked">{{ item.linked.join(', ') }}</span>
                    </li>
                </ul>
                <p class="dependency-hint">{{ dependencyHint }}</p>
            </v-notice>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { RunScope } from '../../shared/types.js';

type Component = 'database' | 'assets' | 'extensions';

const props = withDefaults(defineProps<{
    scope: RunScope
    collections: string[]
    relations?: Array<{ collection: string, related_collection: string }>
    availableComponents?: Component[]
    mode?: 'backup' | 'restore'
}>(), {
    relations: () => [],
    availableComponents: () => ['database', 'assets', 'extensions'],
    mode: 'backup'
});

const emit = defineEmits<{
    update: [patch: Partial<RunScope>]
}>();

const { t } = useI18n();
const search = ref('');

/** Whether a given component should be offered (ie is part of this scope). */
function showComponent(component: Component): boolean {
    return props.availableComponents.includes(component);
}

const filteredCollections = computed(() => {
    const q = (search.value ?? '').toLowerCase();
    return props.collections.filter(c => !q || c.toLowerCase().includes(q));
});

/**
 * Emits an updated inclusion list with the collection added or removed.
 */
function toggleCollection(col: string, checked: boolean) {
    const next = checked
        ? [...props.scope.includeCollections, col]
        : props.scope.includeCollections.filter(c => c !== col);
    emit('update', { includeCollections: next });
}

/**
 * Adds collections to the inclusion list: everything when no search is active,
 * otherwise only the currently filtered results.
 */
function selectAll() {
    // When no search is active, select everything; otherwise add only filtered results.
    const toAdd = search.value ? filteredCollections.value : props.collections;
    const current = new Set(props.scope.includeCollections);
    toAdd.forEach(c => current.add(c));
    emit('update', { includeCollections: [...current] });
}

/**
 * Removes the currently filtered collections from the inclusion list.
 */
function selectNone() {
    const filtered = new Set(filteredCollections.value);
    emit('update', { includeCollections: props.scope.includeCollections.filter(c => !filtered.has(c)) });
}

const dependencyIssues = computed(() => {
    // Empty selection means "everything is included" — nothing can be missing.
    if (props.scope.includeCollections.length === 0) return [];
    const included = new Set(props.scope.includeCollections);
    const known = new Set(props.collections);
    /** @type {Map<string, Set<string>>} */
    const groups = new Map();

    for (const rel of props.relations) {
        if (!known.has(rel.collection) || !known.has(rel.related_collection)) continue;
        if (included.has(rel.collection) && !included.has(rel.related_collection)) {
            const linked = groups.get(rel.related_collection) ?? new Set();
            linked.add(rel.collection);
            groups.set(rel.related_collection, linked);
        }
        if (included.has(rel.related_collection) && !included.has(rel.collection)) {
            const linked = groups.get(rel.collection) ?? new Set();
            linked.add(rel.related_collection);
            groups.set(rel.collection, linked);
        }
    }
    return [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([deselected, linkedSet]) => ({
            deselected,
            linked: [...linkedSet].sort()
        }));
});

const dependencyIntro = computed(() => t('backup.scope.dependency_warning_intro'));

const dependencyHint = computed(() => t(
    props.mode === 'restore'
        ? 'backup.scope.dependency_warning_hint_restore'
        : 'backup.scope.dependency_warning_hint_backup'
));
</script>

<style scoped>
.scope-section {
    margin-bottom: 1rem;
}

.scope-section:last-child {
    margin-bottom: 0;
}

.scope-section-label {
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--theme--foreground);
}

.scope-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0;
    cursor: pointer;
}

.scope-search {
    margin-bottom: 0.5rem;
}

.collection-select-all {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-bottom: 0.375rem;
    font-size: 0.813rem;
    color: var(--theme--foreground-subdued);
}

.select-all-btn {
    padding: 0;
    border: none;
    background: none;
    font-size: 0.813rem;
    color: var(--theme--primary);
    cursor: pointer;
}

.select-all-btn:hover {
    text-decoration: underline;
}

.select-all-sep {
    color: var(--theme--border-color);
}

.collection-list {
    max-height: 17.5rem;
    padding: 0.25rem 0;
    border: 0.063rem solid var(--theme--border-color-subdued);
    border-radius: var(--theme--border-radius);
    overflow-y: auto;
}

.collection-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.75rem;
    cursor: pointer;
}

.collection-item:hover {
    background: var(--theme--background-accent);
}

.collection-name {
    font-family: var(--theme--fonts--monospace--font-family, monospace);
    font-size: 0.813rem;
}

.scope-empty {
    padding: 0.75rem;
    font-size: 0.813rem;
    color: var(--theme--foreground-subdued);
    text-align: center;
}

.scope-warning {
    box-sizing: border-box;
    width: 100%;
    margin-top: 0.75rem;
    word-break: break-word;
    overflow-wrap: break-word;
}

.scope-warning :deep(*) {
    white-space: normal;
    word-break: break-word;
    overflow-wrap: break-word;
}

.dependency-intro,
.dependency-hint {
    margin: 0;
    font-size: 0.813rem;
    line-height: 1.4;
}

.dependency-hint {
    margin-top: 0.5rem;
}

.dependency-list {
    margin: 0.375rem 0 0;
    padding-left: 1.125rem;
    font-size: 0.813rem;
    line-height: 1.5;
}

.dependency-list li {
    margin: 0.125rem 0;
}

.dependency-name,
.dependency-linked {
    font-family: var(--theme--fonts--monospace--font-family, monospace);
}

.dependency-arrow {
    margin: 0 0.25rem;
    color: var(--theme--foreground-subdued);
}
</style>
