/**
 * CostGuard - Content Script
 * 
 * Responsibilities:
 * 1. Retrieve cached pricing data from chrome.storage.local
 * 2. Scan DOM continuously for cloud resource identifiers (EC2, RDS, Compute Engine, etc.)
 * 3. Calculate hourly cost for detected resources
 * 4. Inject styled cost badges next to resource elements
 * 5. Monitor DOM mutations and update badges in real-time
 */

// ============================================================================
// GLOBAL STATE & CONFIGURATION
// ============================================================================

const COSTGUARD_CONFIG = {
  // AWS resource patterns
  aws: {
    ec2_patterns: [
      /\b(t3\.(nano|micro|small|medium|large|xlarge|2xlarge))\b/gi,
      /\b(t2\.(nano|micro|small|medium|large|xlarge|2xlarge))\b/gi,
      /\b(m5\.(large|xlarge|2xlarge|4xlarge|8xlarge|12xlarge|16xlarge|24xlarge))\b/gi,
      /\b(m6\.(large|xlarge|2xlarge|4xlarge|8xlarge|12xlarge|16xlarge|24xlarge))\b/gi,
      /\b(c5\.(large|xlarge|2xlarge|4xlarge|9xlarge|12xlarge|18xlarge|24xlarge))\b/gi,
      /\b(r5\.(large|xlarge|2xlarge|4xlarge|8xlarge|12xlarge|16xlarge|24xlarge))\b/gi
    ],
    rds_patterns: [
      /\b(db\.t3\.(micro|small|medium|large|xlarge|2xlarge))\b/gi,
      /\b(db\.t2\.(micro|small|medium|large|xlarge|2xlarge))\b/gi,
      /\b(db\.m5\.(large|xlarge|2xlarge|4xlarge))\b/gi,
      /\b(db\.r5\.(large|xlarge|2xlarge|4xlarge))\b/gi
    ]
  },
  // GCP resource patterns
  gcp: {
    compute_engine_patterns: [
      /\b(e2-(micro|small|medium|standard-2|standard-4|standard-8|standard-16|standard-32))\b/gi,
      /\b(n2-(standard|highmem|highcpu)-(2|4|8|16|32|48|64|80))\b/gi,
      /\b(c2-standard-(4|8|16|30|60))\b/gi,
      /\b(m2-(ultramem|hypermem)-416)\b/gi
    ],
    cloud_sql_patterns: [
      /\b(db-mysql-instance-(standard|highmem|highcpu)-(1|2|4|8|16|32))\b/gi,
      /\b(db-postgres-instance-(standard|highmem|highcpu)-(1|2|4|8|16|32))\b/gi
    ],
    cloud_storage_patterns: [
      /\b(cloud-storage|gs:\/\/)\b/gi
    ]
  },
  // Styling configuration
  badge_style: {
    font_family: 'system-ui, -apple-system, sans-serif',
    font_size: '11px',
    padding: '4px 8px',
    border: '1px solid #d0d5dd',
    border_radius: '4px',
    background_color: '#f6f8fb',
    color: '#24292e',
    box_shadow: '0 1px 2px rgba(0,0,0,0.05)',
    z_index: '10000',
    opacity: '0.95',
    cursor: 'help'
  },
  // Performance configuration
  performance: {
    mutation_observer_debounce_ms: 500,
    element_cache_ttl_ms: 5000,
    max_badges_per_page: 100,
    scan_interval_ms: 2000
  }
};

// Track which elements already have badges to avoid duplication
const cachedBadgeElements = new WeakSet();
let lastScanTime = 0;
let pricingData = null;
let isInitialized = false;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Retrieve cached pricing data from chrome.storage.local
 * Implements retry logic with exponential backoff
 */
async function getCachedPrices(retryCount = 0, maxRetries = 3) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['cached_prices'], (result) => {
      if (result.cached_prices) {
        resolve(result.cached_prices);
      } else if (retryCount < maxRetries) {
        // Retry with exponential backoff
        setTimeout(() => {
          getCachedPrices(retryCount + 1, maxRetries).then(resolve);
        }, Math.pow(2, retryCount) * 100);
      } else {
        console.warn('[CostGuard] Failed to retrieve cached prices after retries');
        resolve(null);
      }
    });
  });
}

/**
 * Look up the hourly cost of a resource from the pricing cache
 * Supports AWS EC2, RDS, and GCP Compute Engine, Cloud SQL
 */
function lookupResourceCost(resourceId, pricingData) {
  if (!pricingData) return null;

  const resourceLower = resourceId.toLowerCase();

  // Check AWS EC2
  if (pricingData.aws?.ec2?.[resourceLower]) {
    return {
      provider: 'AWS',
      type: 'EC2',
      hourly_cost: pricingData.aws.ec2[resourceLower],
      resource_id: resourceId
    };
  }

  // Check AWS RDS
  if (pricingData.aws?.rds?.[resourceLower]) {
    return {
      provider: 'AWS',
      type: 'RDS',
      hourly_cost: pricingData.aws.rds[resourceLower],
      resource_id: resourceId
    };
  }

  // Check GCP Compute Engine
  if (pricingData.gcp?.compute_engine?.[resourceLower]) {
    return {
      provider: 'GCP',
      type: 'Compute Engine',
      hourly_cost: pricingData.gcp.compute_engine[resourceLower],
      resource_id: resourceId
    };
  }

  // Check GCP Cloud SQL
  if (pricingData.gcp?.cloud_sql?.[resourceLower]) {
    return {
      provider: 'GCP',
      type: 'Cloud SQL',
      hourly_cost: pricingData.gcp.cloud_sql[resourceLower],
      resource_id: resourceId
    };
  }

  return null;
}

/**
 * Format hourly cost as a currency string
 */
function formatCost(hourly_cost) {
  return `$${hourly_cost.toFixed(4)}/hr`;
}

/**
 * Create a styled badge HTML element
 */
function createCostBadge(costInfo) {
  const badge = document.createElement('span');
  badge.className = 'costguard-badge';
  badge.setAttribute('data-resource-id', costInfo.resource_id);
  badge.setAttribute('data-provider', costInfo.provider);
  badge.setAttribute('data-type', costInfo.type);
  badge.setAttribute('title', `${costInfo.provider} ${costInfo.type}: ${costInfo.resource_id}`);
  
  const formattedCost = formatCost(costInfo.hourly_cost);
  badge.textContent = `💰 ${formattedCost}`;
  
  // Apply inline styles
  const style = COSTGUARD_CONFIG.badge_style;
  badge.style.cssText = `
    display: inline-block;
    font-family: ${style.font_family};
    font-size: ${style.font_size};
    padding: ${style.padding};
    margin-left: 4px;
    border: ${style.border};
    border-radius: ${style.border_radius};
    background-color: ${style.background_color};
    color: ${style.color};
    box-shadow: ${style.box_shadow};
    z-index: ${style.z_index};
    opacity: ${style.opacity};
    cursor: ${style.cursor};
    white-space: nowrap;
    position: relative;
    vertical-align: middle;
  `;
  
  return badge;
}

/**
 * Extract text nodes from an element and search for resource patterns
 */
function findResourcesInElement(element, pricingData) {
  console.log(
    '[CostGuard] Page text regex test:',
    document.body.innerText.match(
      /\b(?:t3|t2|m5|m6i|c5)\.[a-z0-9]+\b/g
    )
  );
  const detectedResources = [];
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  let currentNode;
  while ((currentNode = walker.nextNode())) {
    const text = currentNode.nodeValue;
    if (!text || text.trim().length === 0) continue;

    // Search for AWS EC2 instances
    for (const pattern of COSTGUARD_CONFIG.aws.ec2_patterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const resourceId = match[1];
        const costInfo = lookupResourceCost(resourceId, pricingData);
        if (costInfo) {
          detectedResources.push({
            text_node: currentNode,
            resource_id: resourceId,
            cost_info: costInfo,
            match_text: match[0]
          });
        }
      }
    }

    // Search for AWS RDS instances
    for (const pattern of COSTGUARD_CONFIG.aws.rds_patterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const resourceId = match[1];
        const costInfo = lookupResourceCost(resourceId, pricingData);
        if (costInfo) {
          detectedResources.push({
            text_node: currentNode,
            resource_id: resourceId,
            cost_info: costInfo,
            match_text: match[0]
          });
        }
      }
    }

    // Search for GCP Compute Engine instances
    for (const pattern of COSTGUARD_CONFIG.gcp.compute_engine_patterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const resourceId = match[1];
        const costInfo = lookupResourceCost(resourceId, pricingData);
        if (costInfo) {
          detectedResources.push({
            text_node: currentNode,
            resource_id: resourceId,
            cost_info: costInfo,
            match_text: match[0]
          });
        }
      }
    }

    // Search for GCP Cloud SQL instances
    for (const pattern of COSTGUARD_CONFIG.gcp.cloud_sql_patterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const resourceId = match[1];
        const costInfo = lookupResourceCost(resourceId, pricingData);
        if (costInfo) {
          detectedResources.push({
            text_node: currentNode,
            resource_id: resourceId,
            cost_info: costInfo,
            match_text: match[0]
          });
        }
      }
    }
  }

  return detectedResources;
}

/**
 * Inject cost badges next to detected resources
 */
function injectCostBadges(detectedResources) {
  let badgeCount = 0;
  const maxBadges = COSTGUARD_CONFIG.performance.max_badges_per_page;

  for (const detection of detectedResources) {
    if (badgeCount >= maxBadges) {
      console.warn(`[CostGuard] Reached maximum badges per page (${maxBadges})`);
      break;
    }

    const { text_node, cost_info } = detection;
    const parentElement = text_node.parentElement;

    // Avoid duplicate badges
    if (cachedBadgeElements.has(parentElement)) {
      continue;
    }

    try {
      // Create and inject badge
      const badge = createCostBadge(cost_info);
      parentElement.insertBefore(badge, text_node.nextSibling);
      cachedBadgeElements.add(badge);
      badgeCount++;

      // Log resource detection for debugging
      console.log('[CostGuard] Badge injected:', {
        resource: cost_info.resource_id,
        provider: cost_info.provider,
        type: cost_info.type,
        hourly_cost: cost_info.hourly_cost
      });
    } catch (error) {
      console.error('[CostGuard] Error injecting badge:', error);
    }
  }

  return badgeCount;
}

/**
 * Scan the entire page for cloud resource identifiers and inject badges
 */
function scanAndInjectBadges(pricingData) {
  if (!pricingData) {
    console.warn('[CostGuard] No pricing data available for scanning');
    return 0;
  }

  const now = Date.now();
  if (now - lastScanTime < COSTGUARD_CONFIG.performance.scan_interval_ms) {
    // Debounce scans to avoid excessive DOM traversal
    return 0;
  }
  lastScanTime = now;

  try {
    const detectedResources = findResourcesInElement(document.body, pricingData);
    console.log(
    '[CostGuard] Detected Resources:',
    detectedResources.length,
    detectedResources
    );
    if (detectedResources.length > 0) {
      const badgeCount = injectCostBadges(detectedResources);
      console.log(`[CostGuard] Scanned page and injected ${badgeCount} cost badges`);
      return badgeCount;
    }
  } catch (error) {
    console.error('[CostGuard] Error during page scan:', error);
  }

  return 0;
}

// ============================================================================
// MUTATION OBSERVER FOR REAL-TIME UPDATES
// ============================================================================

let mutationObserverTimeout;

/**
 * Set up a MutationObserver to watch for DOM changes and update badges in real-time
 */
function setupMutationObserver(pricingData) {
  const observer = new MutationObserver(() => {
    // Debounce mutations to avoid excessive scanning
    clearTimeout(mutationObserverTimeout);
    mutationObserverTimeout = setTimeout(() => {
      scanAndInjectBadges(pricingData);
    }, COSTGUARD_CONFIG.performance.mutation_observer_debounce_ms);
  });

  const observerConfig = {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: false
  };

  observer.observe(document.body, observerConfig);
  console.log('[CostGuard] MutationObserver initialized');

  return observer;
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the content script
 * 1. Retrieve cached pricing data
 * 2. Perform initial scan
 * 3. Set up MutationObserver for real-time updates
 */
async function initialize() {
  if (isInitialized) {
    console.log('[CostGuard] Content script already initialized');
    return;
  }

  try {
    console.log('[CostGuard] Content script initializing...');

    // Retrieve pricing data
    pricingData = await getCachedPrices();
    if (!pricingData) {
      console.error('[CostGuard] Failed to retrieve pricing data');
      return;
    }

    console.log('[CostGuard] Pricing data loaded successfully');

    // Wait for DOM to be fully loaded
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        scanAndInjectBadges(pricingData);
        setupMutationObserver(pricingData);
        isInitialized = true;
      });
    } else {
      // DOM already loaded
      scanAndInjectBadges(pricingData);
      setupMutationObserver(pricingData);
      isInitialized = true;
    }

    // Periodically re-scan the page (every 5 seconds) for new resources
    setInterval(() => {
      scanAndInjectBadges(pricingData);
    }, 5000);

    console.log('[CostGuard] Content script initialized successfully');
  } catch (error) {
    console.error('[CostGuard] Error during initialization:', error);
  }
}

// ============================================================================
// MESSAGE LISTENER FOR BACKGROUND COMMUNICATION
// ============================================================================

/**
 * Listen for messages from the background service worker
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'idle_state_changed') {
    console.log('[CostGuard] Idle state changed:', message.state);
    // In future phases, this can trigger different alert behaviors
    sendResponse({ success: true });
  } else if (message.type === 'reload_pricing_data') {
    // Force a refresh of pricing data
    getCachedPrices().then((newPricingData) => {
      pricingData = newPricingData;
      scanAndInjectBadges(pricingData);
      sendResponse({ success: true });
    });
    return true; // Indicate async response
  }
});

// ============================================================================
// START INITIALIZATION
// ============================================================================

// Begin initialization when content script loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
chrome.storage.local.get(null, (data) => {
  console.log('[CostGuard] Full Storage:', data);
});

console.log('[CostGuard] Content script loaded');
