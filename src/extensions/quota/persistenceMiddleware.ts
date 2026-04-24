/**
 * Zustand persistence middleware for quota data.
 * Automatically syncs quota state to IndexedDB.
 */

import { useQuotaStore } from '@/stores';
import { indexedDBQuotaCache } from './indexedDBCache';

type QuotaProviderType = 'antigravity' | 'claude' | 'codex' | 'gemini-cli' | 'kimi';

interface QuotaStatusState {
  status: 'idle' | 'loading' | 'success' | 'error';
  cachedAt?: number;
}

class QuotaPersistenceMiddleware {
  private unsubscribe: (() => void) | null = null;
  private isPreloading = false;
  private syncQueue = new Set<string>();
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Start the middleware
   */
  start() {
    if (this.unsubscribe) {
      console.warn('QuotaPersistenceMiddleware already started');
      return;
    }

    // Check if upstream store structure is compatible
    if (!this.checkCompatibility()) {
      console.warn('QuotaPersistenceMiddleware: Upstream store structure changed, persistence disabled');
      return;
    }

    console.log('QuotaPersistenceMiddleware: Starting...');

    // Preload cache first
    this.preloadCache().then(() => {
      console.log('QuotaPersistenceMiddleware: Cache preloaded');
    });

    // Subscribe to store changes
    this.unsubscribe = useQuotaStore.subscribe((state) => {
      if (this.isPreloading) return; // Skip during preload to avoid circular updates

      this.syncProvider('antigravity', state.antigravityQuota);
      this.syncProvider('claude', state.claudeQuota);
      this.syncProvider('codex', state.codexQuota);
      this.syncProvider('gemini-cli', state.geminiCliQuota);
      this.syncProvider('kimi', state.kimiQuota);
    });

    console.log('QuotaPersistenceMiddleware: Started successfully');
  }

  /**
   * Stop the middleware
   */
  stop() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    console.log('QuotaPersistenceMiddleware: Stopped');
  }

  /**
   * Check if upstream store structure is compatible
   */
  private checkCompatibility(): boolean {
    const state = useQuotaStore.getState();
    const requiredFields = [
      'antigravityQuota',
      'claudeQuota',
      'codexQuota',
      'geminiCliQuota',
      'kimiQuota',
      'setAntigravityQuota',
      'setClaudeQuota',
      'setCodexQuota',
      'setGeminiCliQuota',
      'setKimiQuota',
      'clearQuotaCache',
    ];

    const missing = requiredFields.filter((field) => !(field in state));
    if (missing.length > 0) {
      console.error(`QuotaPersistenceMiddleware: Missing fields: ${missing.join(', ')}`);
      return false;
    }

    return true;
  }

  /**
   * Sync provider quota to IndexedDB (debounced)
   */
  private syncProvider(
    provider: QuotaProviderType,
    quotaMap: Record<string, QuotaStatusState>
  ) {
    Object.entries(quotaMap).forEach(([fileName, state]) => {
      if (state.status === 'success' && state.cachedAt) {
        const key = `${provider}:${fileName}`;
        this.syncQueue.add(key);
      }
    });

    // Debounce: batch sync after 500ms
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.syncTimer = setTimeout(() => {
      this.flushSyncQueue();
    }, 500);
  }

  /**
   * Flush sync queue to IndexedDB
   */
  private async flushSyncQueue() {
    if (this.syncQueue.size === 0) return;

    const state = useQuotaStore.getState();
    const promises: Promise<void>[] = [];

    this.syncQueue.forEach((key) => {
      const [provider, fileName] = key.split(':');
      const quotaMap = this.getQuotaMap(state, provider as QuotaProviderType);
      const quotaState = quotaMap?.[fileName];

      if (quotaState?.status === 'success' && quotaState.cachedAt) {
        promises.push(
          indexedDBQuotaCache.set(provider, fileName, quotaState, quotaState.cachedAt)
        );
      }
    });

    this.syncQueue.clear();

    try {
      await Promise.all(promises);
    } catch (err) {
      console.error('QuotaPersistenceMiddleware: Failed to sync to IndexedDB:', err);
    }
  }

  /**
   * Preload cache from IndexedDB to Zustand store
   */
  private async preloadCache() {
    this.isPreloading = true;

    try {
      const providers: QuotaProviderType[] = ['antigravity', 'claude', 'codex', 'gemini-cli', 'kimi'];

      for (const provider of providers) {
        await this.preloadProvider(provider);
      }
    } catch (err) {
      console.error('QuotaPersistenceMiddleware: Failed to preload cache:', err);
    } finally {
      this.isPreloading = false;
    }
  }

  /**
   * Preload single provider from IndexedDB
   */
  private async preloadProvider(provider: QuotaProviderType) {
    try {
      // Get all cached file names for this provider
      const fileNames = await indexedDBQuotaCache.getFileNamesByProvider(provider);
      if (fileNames.length === 0) return;

      // Batch get cached data
      const cached = await indexedDBQuotaCache.batchGet(provider, fileNames);
      if (cached.size === 0) return;

      // Write to store
      const setterName = this.getSetterName(provider) as 'setAntigravityQuota' | 'setClaudeQuota' | 'setCodexQuota' | 'setGeminiCliQuota' | 'setKimiQuota';
      const storeState = useQuotaStore.getState();
      const setter = storeState[setterName];

      if (typeof setter === 'function') {
        setter((prev: Record<string, any>) => {
          const next = { ...prev };
          cached.forEach((data, fileName) => {
            // Only fill empty slots, don't overwrite existing data
            if (!next[fileName]) {
              next[fileName] = data;
            }
          });
          return next;
        });

        console.log(`QuotaPersistenceMiddleware: Preloaded ${cached.size} entries for ${provider}`);
      }
    } catch (err) {
      console.error(`QuotaPersistenceMiddleware: Failed to preload ${provider}:`, err);
    }
  }

  /**
   * Get quota map from state by provider
   */
  private getQuotaMap(
    state: any,
    provider: QuotaProviderType
  ): Record<string, QuotaStatusState> | null {
    const mapName = this.getQuotaMapName(provider);
    return state[mapName] || null;
  }

  /**
   * Get quota map name by provider
   */
  private getQuotaMapName(provider: QuotaProviderType): string {
    const mapping: Record<QuotaProviderType, string> = {
      'antigravity': 'antigravityQuota',
      'claude': 'claudeQuota',
      'codex': 'codexQuota',
      'gemini-cli': 'geminiCliQuota',
      'kimi': 'kimiQuota',
    };
    return mapping[provider];
  }

  /**
   * Get setter name by provider
   */
  private getSetterName(provider: QuotaProviderType): string {
    const mapping: Record<QuotaProviderType, string> = {
      'antigravity': 'setAntigravityQuota',
      'claude': 'setClaudeQuota',
      'codex': 'setCodexQuota',
      'gemini-cli': 'setGeminiCliQuota',
      'kimi': 'setKimiQuota',
    };
    return mapping[provider];
  }

  /**
   * Get cache statistics
   */
  async getStats() {
    return await indexedDBQuotaCache.getStats();
  }

  /**
   * Clear all cache
   */
  async clearCache() {
    await indexedDBQuotaCache.clear();
    console.log('QuotaPersistenceMiddleware: Cache cleared');
  }
}

export const quotaPersistenceMiddleware = new QuotaPersistenceMiddleware();
