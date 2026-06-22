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

console.log(
  '[CostGuard] Is Top Frame:',
  window === window.top
);

console.log(
  '[CostGuard] Frame URL:',
  window.location.href
);

console.log(
  '[CostGuard] Body Length:',
  document.body?.innerText?.length
);

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
let cachedBadgeElements = new WeakMap();
let costGuardPanel = null;
let previousSelectedResourceInfo = null;
let lastScanTime = 0;
let pricingData = null;
let isInitialized = false;
let mutationObserver = null;

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
  badge.setAttribute('data-costguard', 'true');
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

function calculateCostSummary(hourlyCost) {
  return {
    hourly: parseFloat(hourlyCost.toFixed(4)),
    daily: parseFloat((hourlyCost * 24).toFixed(2)),
    monthly: parseFloat((hourlyCost * 24 * 30).toFixed(2))
  };
}

function formatCurrency(value, decimals) {
  return `$${value.toFixed(decimals)}`;
}

function parseRegionFromUrl() {
  const url = window.location.href;
  const regionParam = url.match(/[?&]region=([a-z0-9-]+)/i);
  if (regionParam) return regionParam[1];

  const awsRegionMatch = url.match(/\b([a-z]{2}-(?:north|south|east|west|central|northeast|southeast|ap|ca|sa|eu|me|af)(?:-[a-z]+)?-\d)\b/i);
  if (awsRegionMatch) return awsRegionMatch[1];

  const gcpRegionMatch = url.match(/\b([a-z]{2}-(?:central|east|west|north|south|northeast|southeast|asia|europe|australia)[0-9])\b/i);
  if (gcpRegionMatch) return gcpRegionMatch[1];

  return 'Unknown Region';
}

function getResourceMatchText(resource) {
  return resource.resource_id || resource.match_text || '';
}

function findSelectedResource(detectedResources) {
  if (!detectedResources || detectedResources.length === 0) {
    return null;
  }

  const selectedSelectors = [
    'option[selected]',
    '[aria-selected="true"]',
    '[aria-pressed="true"]',
    '[data-selected="true"]',
    '[data-active="true"]',
    '.selected',
    '.is-selected',
    '.active'
  ];

  const selectedNodes = selectedSelectors
    .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .filter((node, index, list) => list.indexOf(node) === index);

  for (const node of selectedNodes) {
    const text = node.textContent || '';
    const found = detectedResources.find((resource) => {
      const matchText = getResourceMatchText(resource);
      return matchText && text.includes(matchText);
    });
    if (found) return found;
  }

  const activeElement = document.activeElement;
  if (activeElement && activeElement.textContent) {
    const activeText = activeElement.textContent;
    const found = detectedResources.find((resource) => {
      const matchText = getResourceMatchText(resource);
      return matchText && activeText.includes(matchText);
    });
    if (found) return found;
  }

  const select = document.querySelector('select');
  if (select) {
    const value = select.value;
    const selectedOptionText = select.selectedOptions?.[0]?.textContent || '';
    const foundByValue = detectedResources.find((resource) => {
      const matchText = getResourceMatchText(resource);
      return (matchText && matchText === value) || resource.resource_id === value;
    });
    if (foundByValue) return foundByValue;

    const foundByOptionText = detectedResources.find((resource) => {
      const matchText = getResourceMatchText(resource);
      return matchText && selectedOptionText.includes(matchText);
    });
    if (foundByOptionText) return foundByOptionText;
  }

  return detectedResources[0];
}

function createCostGuardPanel() {
  if (costGuardPanel) return costGuardPanel;

  const existingPanel = document.querySelector('.costguard-panel');
  if (existingPanel) {
    costGuardPanel = existingPanel;
    return costGuardPanel;
  }

  const panel = document.createElement('div');
  panel.className = 'costguard-panel';
  panel.dataset.costguard = 'true';
  panel.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    width: 260px;
    max-width: calc(100vw - 24px);
    background: rgba(255, 255, 255, 0.98);
    color: #24292e;
    border-radius: 18px;
    box-shadow: 0 22px 50px rgba(0,0,0,0.18);
    font-family: ${COSTGUARD_CONFIG.badge_style.font_family};
    padding: 16px;
    display: none;
    z-index: 2147483647;
    cursor: default;
    user-select: none;
  `;

  panel.innerHTML = `
    <div class="costguard-panel-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; cursor: grab;">
      <span style="font-weight:700; font-size:14px;">CostGuard</span>
      <span style="font-size:12px; opacity:0.65;">Live</span>
    </div>
    <div class="costguard-panel-content" style="font-size:13px; line-height:1.5;">
      <div style="margin-bottom:8px;"><span style="opacity:0.65;">Service:</span> <strong data-costguard="service">N/A</strong></div>
      <div style="margin-bottom:8px;"><span style="opacity:0.65;">Resource:</span> <strong data-costguard="resource">N/A</strong></div>
      <div style="margin-bottom:12px;"><span style="opacity:0.65;">Region:</span> <strong data-costguard="region">Unknown Region</strong></div>
      <div style="margin-bottom:8px;"><span style="opacity:0.65;">Hourly Cost:</span> <strong data-costguard="hourly">$0.0000</strong></div>
      <div style="margin-bottom:8px;"><span style="opacity:0.65;">Daily Cost:</span> <strong data-costguard="daily">$0.00</strong></div>
      <div style="margin-bottom:12px;"><span style="opacity:0.65;">Monthly Cost:</span> <strong data-costguard="monthly">$0.00</strong></div>
      <div data-costguard="comparison" style="display:none; padding:10px 12px; border-radius:12px; background: #f1f5f9; color: #102a43; font-size:12px;"></div>
    </div>
  `;

  document.body.appendChild(panel);
  const header = panel.querySelector('.costguard-panel-header');
  makePanelDraggable(panel, header);
  costGuardPanel = panel;
  return panel;
}

function updateCostGuardPanel(resourceInfo) {
  if (!resourceInfo || !resourceInfo.cost_info) {
    hideCostGuardPanel();
    return;
  }

  const panel = createCostGuardPanel();
  const summary = calculateCostSummary(resourceInfo.cost_info.hourly_cost);
  const region = parseRegionFromUrl();

  panel.querySelector('[data-costguard="service"]').textContent = resourceInfo.cost_info.type || 'Unknown';
  panel.querySelector('[data-costguard="resource"]').textContent = resourceInfo.cost_info.resource_id;
  panel.querySelector('[data-costguard="region"]').textContent = region;
  panel.querySelector('[data-costguard="hourly"]').textContent = formatCurrency(summary.hourly, 4);
  panel.querySelector('[data-costguard="daily"]').textContent = formatCurrency(summary.daily, 2);
  panel.querySelector('[data-costguard="monthly"]').textContent = formatCurrency(summary.monthly, 2);

  const comparison = panel.querySelector('[data-costguard="comparison"]');
  if (previousSelectedResourceInfo && previousSelectedResourceInfo.cost_info && previousSelectedResourceInfo.resource_id !== resourceInfo.resource_id) {
    const previousSummary = calculateCostSummary(previousSelectedResourceInfo.cost_info.hourly_cost);
    const diff = summary.monthly - previousSummary.monthly;
    comparison.textContent = `Cost Change: ${diff >= 0 ? '+' : '-'}${formatCurrency(Math.abs(diff), 2)}/month`;
    comparison.style.display = 'block';
  } else {
    comparison.style.display = 'none';
  }

  panel.style.display = 'block';
  previousSelectedResourceInfo = resourceInfo;
}

function hideCostGuardPanel() {
  if (!costGuardPanel) return;
  costGuardPanel.style.display = 'none';
}

function makePanelDraggable(panel, handle) {
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  const normalizePosition = (x, y) => {
    const maxX = window.innerWidth - panel.offsetWidth - 10;
    const maxY = window.innerHeight - panel.offsetHeight - 10;
    return {
      left: `${Math.min(Math.max(x, 10), Math.max(maxX, 10))}px`,
      top: `${Math.min(Math.max(y, 10), Math.max(maxY, 10))}px`
    };
  };

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    isDragging = true;
    startX = event.clientX;
    startY = event.clientY;
    const rect = panel.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    panel.style.right = 'auto';
    panel.style.left = `${startLeft}px`;
    panel.style.top = `${startTop}px`;
    panel.setPointerCapture(event.pointerId);
  });

  handle.addEventListener('pointermove', (event) => {
    if (!isDragging) return;
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    const position = normalizePosition(startLeft + deltaX, startTop + deltaY);
    panel.style.left = position.left;
    panel.style.top = position.top;
  });

  handle.addEventListener('pointerup', (event) => {
    if (!isDragging) return;
    isDragging = false;
    panel.releasePointerCapture(event.pointerId);
  });

  handle.addEventListener('pointercancel', () => {
    isDragging = false;
  });
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

  // FIX: Duplicate detection
  // Deduplicate detected resources by resource_id and keep only the first occurrence.
  // This prevents duplicate badge injection when the same instance type appears multiple times.
  const uniqueResourcesMap = new Map();
  for (const detection of detectedResources) {
    const key = detection.resource_id.toLowerCase();
    if (!uniqueResourcesMap.has(key)) {
      uniqueResourcesMap.set(key, detection);
    } else {
      console.log('[CostGuard] Skipping duplicate resource:', detection.resource_id);
    }
  }

  return Array.from(uniqueResourcesMap.values());
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
    if (!parentElement) continue;

    const resourceKey = cost_info.resource_id.toLowerCase();

    const existingBadge = parentElement.querySelector(
      `.costguard-badge[data-resource-id="${cost_info.resource_id}"]`
    );
    if (existingBadge) {
      console.log('[CostGuard] Badge already exists for:', cost_info.resource_id);
      existingBadge.textContent = `💰 ${formatCost(cost_info.hourly_cost)}`;
      existingBadge.title = `${cost_info.provider} ${cost_info.type}: ${cost_info.resource_id}`;
      existingBadge.setAttribute('data-provider', cost_info.provider);
      existingBadge.setAttribute('data-type', cost_info.type);
      existingBadge.setAttribute('data-costguard', 'true');

      let resourceSet = cachedBadgeElements.get(parentElement);
      if (!resourceSet) {
        resourceSet = new Set();
        cachedBadgeElements.set(parentElement, resourceSet);
      }
      resourceSet.add(resourceKey);
      continue;
    }

    const parentResourceSet = cachedBadgeElements.get(parentElement);
    if (parentResourceSet?.has(resourceKey)) {
      console.log('[CostGuard] Skipping duplicate resource in same parent:', cost_info.resource_id);
      continue;
    }

    try {
      const badge = createCostBadge(cost_info);
      parentElement.insertBefore(badge, text_node.nextSibling);
      let resourceSet = cachedBadgeElements.get(parentElement);
      if (!resourceSet) {
        resourceSet = new Set();
        cachedBadgeElements.set(parentElement, resourceSet);
      }
      resourceSet.add(resourceKey);
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
  cachedBadgeElements = new WeakMap();

  // DEBUG: Log current URL and body text length before scanning
    setTimeout(() => {
    console.log(
      '[CostGuard] Delayed Check:',
      document.body.innerText.includes('t3.micro')
    );
  }, 10000);

  console.log(
    '[CostGuard] Current Body Length:',
    document.body.innerText.length
  );

  console.log(
    '[CostGuard] Has t3.micro:',
    document.body.innerText.includes('t3.micro')
  );
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
    // DEBUG: Log current URL and body text length
      console.log(
    '[CostGuard] Current URL:',
    window.location.href
  );

  console.log(
    '[CostGuard] Body text length:',
    document.body.innerText.length
  );

  console.log(
    '[CostGuard] First 500 chars:',
    document.body.innerText.substring(0, 500)
  );
  console.log('[CostGuard] scanAndInjectBadges triggered');
    const detectedResources = findResourcesInElement(document.body, pricingData);
    console.log(
    '[CostGuard] Detected Resources:',
    detectedResources.length,
    detectedResources
    );
    const selectedResource = findSelectedResource(detectedResources);
    if (selectedResource) {
      updateCostGuardPanel(selectedResource);
    } else {
      hideCostGuardPanel();
    }

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

function isCostGuardNode(node) {
  return (
    node &&
    node.nodeType === Node.ELEMENT_NODE &&
    (node.classList.contains('costguard-badge') ||
      node.getAttribute('data-costguard') === 'true')
  );
}

function mutationContainsOnlyCostGuardNodes(mutations) {
  for (const mutation of mutations) {
    if (mutation.type === 'childList') {
      for (const node of mutation.addedNodes) {
        if (
          node.nodeType !== Node.ELEMENT_NODE ||
          (!isCostGuardNode(node) &&
            !node.querySelector('.costguard-badge, [data-costguard="true"]'))
        ) {
          return false;
        }
      }

      for (const node of mutation.removedNodes) {
        if (!isCostGuardNode(node)) {
          return false;
        }
      }
    }

    if (mutation.type === 'characterData') {
      if (!isCostGuardNode(mutation.target.parentElement)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Set up a MutationObserver to watch for DOM changes and update badges in real-time
 */
function setupMutationObserver(pricingData) {
  if (mutationObserver) {
    console.log('[CostGuard] MutationObserver already exists');
    return mutationObserver;
  }

  mutationObserver = new MutationObserver((mutations) => {
    if (mutationContainsOnlyCostGuardNodes(mutations)) {
      console.log('[CostGuard] Ignoring self-generated mutation');
      return;
    }

    clearTimeout(mutationObserverTimeout);
    mutationObserverTimeout = setTimeout(() => {
      console.log('[CostGuard] Debounced scan triggered');
      scanAndInjectBadges(pricingData);
    }, COSTGUARD_CONFIG.performance.mutation_observer_debounce_ms);
  });

  const observerConfig = {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: false
  };

  mutationObserver.observe(document.body, observerConfig);
  console.log('[CostGuard] MutationObserver initialized');

  return mutationObserver;
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
