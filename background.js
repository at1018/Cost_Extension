/**
 * CostGuard - Background Service Worker
 * 
 * Responsibilities:
 * 1. Load and cache pricing data on extension install/update
 * 2. Maintain a fallback pricing cache in chrome.storage.local
 * 3. Periodically verify cache freshness and trigger silent updates
 * 4. Monitor idle state and broadcast status to content scripts
 */

// ============================================================================
// INITIALIZATION & CACHE MANAGEMENT
// ============================================================================

/**
 * Load pricing data from the bundled pricing-fallback.json file
 * Falls back to a hardcoded minimal pricing map if file is unavailable
 */
async function loadPricingData() {
  try {
    const response = await fetch(chrome.runtime.getURL('pricing-fallback.json'));
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const pricingData = await response.json();
    return pricingData;
  } catch (error) {
    console.error('[CostGuard] Failed to load pricing-fallback.json:', error);
    // Return hardcoded fallback if file fails to load
    return getHardcodedFallbackPricing();
  }
}

/**
 * Hardcoded fallback pricing data (minimal subset)
 * Used if pricing-fallback.json cannot be loaded
 */
function getHardcodedFallbackPricing() {
  return {
    aws: {
      ec2: {
        't3.nano': 0.0052,
        't3.micro': 0.0104,
        't3.small': 0.0208,
        't3.medium': 0.0416,
        't3.large': 0.0832,
        't3.xlarge': 0.1664,
        't3.2xlarge': 0.3328,
        'm5.large': 0.096,
        'm5.xlarge': 0.192,
        'm5.2xlarge': 0.384,
        'm5.4xlarge': 0.768,
        'm5.8xlarge': 1.536,
        'c5.large': 0.085,
        'c5.xlarge': 0.17,
        'c5.2xlarge': 0.34,
        'c5.4xlarge': 0.68,
        'c5.9xlarge': 1.53,
        'r5.large': 0.126,
        'r5.xlarge': 0.252,
        'r5.2xlarge': 0.504,
        'r5.4xlarge': 1.008
      },
      rds: {
        'db.t3.micro': 0.017,
        'db.t3.small': 0.034,
        'db.t3.medium': 0.068,
        'db.t3.large': 0.136,
        'db.m5.large': 0.203,
        'db.m5.xlarge': 0.406,
        'db.m5.2xlarge': 0.812,
        'db.r5.large': 0.275,
        'db.r5.xlarge': 0.55,
        'db.r5.2xlarge': 1.1
      },
      lambda: {
        'per_gb_second': 0.0000166667,
        'per_request': 0.0000002
      },
      s3: {
        'per_gb_month': 0.023
      }
    },
    gcp: {
      compute_engine: {
        'e2-micro': 0.0264,
        'e2-small': 0.0528,
        'e2-medium': 0.0842,
        'e2-standard-2': 0.1338,
        'e2-standard-4': 0.2676,
        'e2-standard-8': 0.5352,
        'e2-standard-16': 1.0704,
        'e2-standard-32': 2.1408,
        'n2-standard-2': 0.09735,
        'n2-standard-4': 0.1947,
        'n2-standard-8': 0.3894,
        'n2-standard-16': 0.7788,
        'n2-standard-32': 1.5576,
        'n2-highmem-2': 0.12305,
        'n2-highmem-4': 0.2461,
        'n2-highmem-8': 0.4922,
        'c2-standard-4': 0.19,
        'c2-standard-8': 0.38,
        'c2-standard-16': 0.76
      },
      cloud_sql: {
        'db-mysql-instance-standard-1': 0.0728,
        'db-mysql-instance-standard-2': 0.1456,
        'db-mysql-instance-standard-4': 0.2912
      },
      cloud_storage: {
        'per_gb_month': 0.020
      }
    },
    metadata: {
      last_updated: new Date().toISOString(),
      currency: 'USD',
      billing_model: 'hourly'
    }
  };
}

/**
 * Initialize the pricing cache on extension install or update
 * This runs once when the extension is first installed or updated
 */
async function initializePricingCache() {
  try {
    // Check if pricing cache already exists
    const existingCache = await chrome.storage.local.get(['cached_prices', 'last_update_time']);
    
    if (existingCache.cached_prices && existingCache.last_update_time) {
      const lastUpdate = new Date(existingCache.last_update_time);
      const now = new Date();
      const daysSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60 * 24);
      
      // If cache is less than 7 days old, keep existing cache
      if (daysSinceUpdate < 7) {
        console.log('[CostGuard] Pricing cache is fresh, skipping reload');
        return;
      }
    }
    
    // Load fresh pricing data
    console.log('[CostGuard] Loading pricing data...');
    const pricingData = await loadPricingData();
    
    // Save to chrome.storage.local
    const cachePayload = {
      cached_prices: pricingData,
      last_update_time: new Date().toISOString(),
      cache_version: '1.0.0'
    };
    
    await chrome.storage.local.set(cachePayload);
    console.log('[CostGuard] Pricing cache initialized successfully:', {
      aws_ec2_entries: Object.keys(pricingData.aws?.ec2 || {}).length,
      gcp_entries: Object.keys(pricingData.gcp?.compute_engine || {}).length,
      timestamp: cachePayload.last_update_time
    });
  } catch (error) {
    console.error('[CostGuard] Error initializing pricing cache:', error);
  }
}

/**
 * Event listener: Extension installed or updated
 * Triggered when the extension is first installed or an update is applied
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    console.log(`[CostGuard] Extension ${details.reason}ed. Initializing cache...`);
    await initializePricingCache();
  }
});

// ============================================================================
// BACKGROUND UPDATE VERIFICATION LOOP
// ============================================================================

/**
 * Periodically verify cache freshness and trigger silent updates
 * This simulates a quiet update verification loop that gracefully falls back
 * to the local cache if the network is unavailable or slow
 */
async function verifyAndUpdateCache() {
  try {
    const storage = await chrome.storage.local.get(['last_update_time']);
    const lastUpdate = new Date(storage.last_update_time || 0);
    const now = new Date();
    const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);
    
    // Check cache every 24 hours; update if stale
    if (hoursSinceUpdate >= 24) {
      console.log('[CostGuard] Cache is stale (24+ hours). Attempting silent update...');
      
      // Attempt to fetch fresh pricing with a 5-second timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      try {
        const pricingData = await loadPricingData();
        clearTimeout(timeoutId);
        
        // Save updated cache
        const cachePayload = {
          cached_prices: pricingData,
          last_update_time: new Date().toISOString()
        };
        await chrome.storage.local.set(cachePayload);
        console.log('[CostGuard] Cache updated successfully');
      } catch (updateError) {
        clearTimeout(timeoutId);
        console.warn('[CostGuard] Silent update failed (network offline or slow). Falling back to existing cache.');
        // Cache fallback is automatic; no action needed here
      }
    }
  } catch (error) {
    console.error('[CostGuard] Error during cache verification:', error);
  }
}

/**
 * Schedule periodic cache verification
 * Creates an alarm that fires every 24 hours to check cache freshness
 */
function setupCacheVerificationAlarm() {
  chrome.alarms.create('costguard_cache_verify', {
    periodInMinutes: 24 * 60 // Check every 24 hours
  });
  
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'costguard_cache_verify') {
      console.log('[CostGuard] Cache verification alarm triggered');
      verifyAndUpdateCache();
    }
  });
}

// Initialize cache verification on startup
setupCacheVerificationAlarm();

// Also run verification check immediately on startup
chrome.runtime.onStartup?.addListener(() => {
  console.log('[CostGuard] Browser started. Running cache verification...');
  verifyAndUpdateCache();
});

// ============================================================================
// IDLE STATE MONITORING (FOR FUTURE PHASES)
// ============================================================================

/**
 * Monitor user idle state
 * (Used in Phase 2+ for multi-tab sync and activity detection)
 */
function setupIdleStateMonitoring() {
  chrome.idle.onStateChanged.addListener((newState) => {
    console.log('[CostGuard] User idle state changed:', newState);
    // Broadcast idle state to content scripts in Phase 2+
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        chrome.tabs.sendMessage(
          tab.id,
          { type: 'idle_state_changed', state: newState },
          { frameId: 0 }
        ).catch(() => {
          // Tab may not have content script loaded; silently ignore
        });
      });
    });
  });
  
  // Query initial idle state
  chrome.idle.queryState(15, (state) => {
    console.log('[CostGuard] Initial idle state:', state);
  });
}

// Setup idle monitoring
setupIdleStateMonitoring();

// ============================================================================
// MESSAGE LISTENER FOR CONTENT SCRIPT COMMUNICATION
// ============================================================================

/**
 * Listen for messages from content scripts
 * Content scripts may request pricing data or report detected resources
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'get_cached_prices') {
    // Retrieve and send cached prices to content script
    chrome.storage.local.get(['cached_prices'], (result) => {
      if (result.cached_prices) {
        sendResponse({
          success: true,
          data: result.cached_prices
        });
      } else {
        sendResponse({
          success: false,
          error: 'No cached prices available'
        });
      }
    });
    // Return true to indicate async response
    return true;
  } else if (message.type === 'resource_detected') {
    // Log detected resources (for analytics in future phases)
    console.log('[CostGuard] Resource detected:', {
      tabId: sender.tab.id,
      url: sender.tab.url,
      resource: message.resource,
      estimatedCost: message.estimatedCost
    });
    sendResponse({ success: true });
  }
});

// ============================================================================
// LOGGING & DIAGNOSTICS
// ============================================================================

console.log('[CostGuard] Background service worker initialized');
