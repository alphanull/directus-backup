<!--
  Status panel for the module navigation — shows used/free storage and a quota
  usage bar that shifts hue from green to red as the quota fills.

  @author  Frank Kudermann – alphanull
  @license AGPL-3.0-only
-->
<template>
    <div class="nav-section">
        <div class="nav-section-title"><v-icon name="monitoring" class="nav-section-icon" />{{ t('backup.nav.status') }}</div>
        <div class="nav-storage">
            <div class="nav-storage-row">
                <span class="nav-storage-label">{{ t('backup.storage.used') }}</span>
                <span>{{ storage.usedMB != null ? formatMB(storage.usedMB) : '?' }}<template v-if="quotaMB > 0"> / {{ formatMB(quotaMB) }}</template></span>
            </div>
            <div class="nav-storage-row">
                <span class="nav-storage-label">{{ t('backup.storage.free') }}</span>
                <span :class="{ 'storage-warn': storage.freeMB !== null && minFreeMB > 0 && storage.freeMB < minFreeMB }">
                    {{ storage.freeMB != null ? formatMB(storage.freeMB) : '?' }}
                </span>
            </div>
            <div v-if="quotaMB > 0" class="storage-bar-track">
                <div
                    class="storage-bar-fill"
                    :style="{ width: Math.min(storagePercent, 100) + '%', background: storageBarColor }"
                />
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatMB } from '../composables/useFormatters.js';

const props = defineProps<{
    storage: { usedMB: number | null, freeMB: number | null }
    quotaMB: number
    minFreeMB: number
    storagePercent: number
}>();

const { t } = useI18n();

const storageBarColor = computed(() => {
    const p = Math.min(props.storagePercent, 100);
    if (p <= 50) return 'hsl(120, 65%, 45%)';
    const ratio = (p - 50) / 50;
    const hue = Math.round(120 * (1 - ratio));
    return `hsl(${hue}, 65%, 50%)`;
});
</script>

<style scoped>
.nav-section {
    padding: 0.75rem 0;
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

.nav-storage {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.813rem;
    color: var(--theme--foreground-subdued);
}

.nav-storage-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.nav-storage-label {
    font-weight: 600;
}

.storage-warn {
    font-weight: 600;
    color: var(--danger);
}

.storage-bar-track {
    overflow: hidden;
    height: 0.375rem;
    margin-top: 0.5rem;
    border-radius: 0.188rem;
    background: var(--theme--border-color-subdued);
}

.storage-bar-fill {
    height: 100%;
    border-radius: 0.188rem;
    transition: width 0.3s ease, background 0.3s ease;
}
</style>
